import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { setTimeout as sleep } from 'node:timers/promises';
import { Store } from '../src/store.js';
import { createApp } from '../src/server.js';
import { estimateTokens } from '../src/usage.js';

let upstream, app, base;
let slowStreamClosedEarly = false;

before(async () => {
  upstream = createServer(async (req, res) => {
    for await (const _ of req);
    if (req.url.startsWith('/hang')) return; // never answers: must time out and fail over
    if (req.url.startsWith('/slow')) {
      // Streams for longer than the router's timeout (headers arrive immediately).
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.on('close', () => { if (!res.writableFinished) slowStreamClosedEarly = true; });
      for (let i = 0; i < 6; i++) {
        if (res.destroyed) return;
        res.write(`data: {"choices":[{"delta":{"content":"${i}"}}]}\n\n`);
        await sleep(60);
      }
      return res.end('data: [DONE]\n\n');
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"choices":[{"message":{"content":"ok"}}],"usage":{"total_tokens":3}}');
  });
  await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
  const u = `http://127.0.0.1:${upstream.address().port}`;

  const store = new Store({ file: null, masterKey: 'test-master-key-123' });
  store.setProvider('hang', { baseUrl: `${u}/hang`, models: [{ id: 'h', type: 'chat', tier: 9, aliases: ['pair'] }] });
  store.setProvider('ok', { baseUrl: `${u}/ok`, models: [{ id: 'o', type: 'chat', tier: 1, aliases: ['pair'] }] });
  store.setProvider('slow', { baseUrl: `${u}/slow`, models: [{ id: 's', type: 'chat', tier: 1 }] });
  for (const p of ['hang', 'ok', 'slow']) store.addKey({ provider: p, apiKey: `sk-${p}-secret` });

  app = createApp({ store, adminToken: 'adm', timeoutMs: 150, log: {} });
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${app.server.address().port}`;
});

after(() => { app.server.close(); upstream.closeAllConnections(); upstream.close(); });

const post = (path, body, headers = {}) => fetch(base + path, {
  method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body),
});

test('timeout before headers fails over to the next provider', async () => {
  const r = await post('/v1/chat/completions', { model: 'pair', messages: [] });
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('x-freellm-provider'), 'ok');
});

test('a stream that outlives the timeout is not cut off', async () => {
  const r = await post('/v1/chat/completions', { model: 'slow/s', stream: true, messages: [] });
  const text = await r.text(); // ~360 ms of streaming vs a 150 ms timeout
  assert.match(text, /"content":"5"/);
  assert.match(text, /\[DONE\]/);
});

test('client disconnect aborts the upstream stream', async () => {
  slowStreamClosedEarly = false;
  const ctrl = new AbortController();
  const r = await post('/v1/chat/completions', { model: 'slow/s', stream: true, messages: [] }, {});
  const reader = r.body.getReader();
  await reader.read();
  await reader.cancel();
  ctrl.abort();
  await sleep(250);
  assert.equal(slowStreamClosedEarly, true);
});

test('malformed requests get 400, not 500', async () => {
  assert.equal((await post('/v1/chat/completions', { model: 42 })).status, 400);
  assert.equal((await post('/v1/chat/completions', '[1,2]')).status, 400);
  assert.equal((await post('/v1/chat/completions', '{not json')).status, 400);
  const adm = { authorization: 'Bearer adm' };
  assert.equal((await post('/admin/keys', { provider: 'ok' }, adm)).status, 400);
  assert.equal((await fetch(`${base}/admin/providers/x`, { method: 'PUT', headers: adm, body: '{"baseUrl":"ftp://x"}' })).status, 400);
  assert.equal((await fetch(`${base}/admin/providers/x`, { method: 'PUT', headers: adm, body: '{"baseUrl":"http://x","models":{}}' })).status, 400);
});

test('token estimate adds completion budget only for chat', () => {
  assert.equal(estimateTokens({ input: 'abcdefgh' }, 'embedding'), 2);
  assert.equal(estimateTokens({ messages: 'abcdefgh', max_tokens: 10 }, 'chat'), 12);
});
