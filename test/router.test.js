import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { Store } from '../src/store.js';
import { createApp } from '../src/server.js';

// Two fake OpenAI-compatible upstreams. "busy" always answers 429; "good" works.
let upstream, upstreamUrl, app, base;
const hits = [];

before(async () => {
  upstream = createServer(async (req, res) => {
    let body = '';
    for await (const c of req) body += c;
    const parsed = JSON.parse(body || '{}');
    hits.push({ path: req.url, auth: req.headers.authorization, model: parsed.model });
    if (req.url.startsWith('/busy')) {
      res.writeHead(429, { 'retry-after': '120', 'content-type': 'application/json' });
      return res.end('{"error":"slow down"}');
    }
    if (req.url.startsWith('/bad')) {
      res.writeHead(400, { 'content-type': 'application/json' });
      return res.end('{"error":{"message":"bad param"}}');
    }
    if (parsed.stream) {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('data: {"choices":[{"delta":{"content":"Hel"}}]}\n\n');
      res.write('data: {"choices":[{"delta":{"content":"lo"}}]}\n\n');
      res.write('data: {"choices":[],"usage":{"total_tokens":42}}\n\n');
      return res.end('data: [DONE]\n\n');
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ id: 'x', object: 'chat.completion', model: parsed.model,
      choices: [{ index: 0, message: { role: 'assistant', content: 'hi' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 } }));
  });
  await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
  upstreamUrl = `http://127.0.0.1:${upstream.address().port}`;

  const store = new Store({ file: null, masterKey: 'test-master-key-123' });
  const m = (id, tier, limits = {}) => ({ id, type: 'chat', tier, aliases: ['shared'], limits });
  store.setProvider('busy', { baseUrl: `${upstreamUrl}/busy`, models: [m('big', 5)] });
  store.setProvider('good', { baseUrl: `${upstreamUrl}/good`, models: [m('small', 1, { rpm: 2 })] });
  store.setProvider('bad', { baseUrl: `${upstreamUrl}/bad`, models: [m('strict', 3)] });
  store.addKey({ provider: 'busy', apiKey: 'sk-busy-secret' });
  store.addKey({ provider: 'good', apiKey: 'sk-good-secret' });

  app = createApp({ store, clientKeys: ['client-1'], adminToken: 'adm', log: {} });
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${app.server.address().port}`;
});

after(() => { app.server.close(); upstream.close(); });

const chat = (body, key = 'client-1') => fetch(`${base}/v1/chat/completions`, {
  method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
  body: JSON.stringify({ messages: [{ role: 'user', content: 'hello' }], ...body }),
});

test('rejects bad client key', async () => {
  const r = await chat({}, 'nope');
  assert.equal(r.status, 401);
});

test('stores provider keys encrypted', () => {
  const raw = JSON.stringify(app.store.data);
  assert.ok(!raw.includes('sk-good-secret'));
  const id = app.store.listKeys().find((k) => k.provider === 'good').id;
  assert.equal(app.store.secret(id), 'sk-good-secret');
});

test('auto: fails over from rate-limited provider to the next one', async () => {
  hits.length = 0;
  const r = await chat({ model: 'auto' });
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('x-freellm-provider'), 'good');
  assert.equal(r.headers.get('x-freellm-attempts'), '2');
  assert.equal((await r.json()).choices[0].message.content, 'hi');
  assert.deepEqual(hits.map((h) => h.model), ['big', 'small']);
  assert.equal(hits[1].auth, 'Bearer sk-good-secret');
});

test('429 puts the key on cooldown so it is skipped next time', async () => {
  hits.length = 0;
  const r = await chat({ model: 'shared', stream: true });
  assert.equal(r.status, 200);
  assert.match(await r.text(), /\[DONE\]/);
  assert.deepEqual(hits.map((h) => h.model), ['small']);
  const goodKey = app.store.listKeys().find((k) => k.provider === 'good').id;
  assert.equal(app.usage.window(goodKey, 'small', 60_000).tokens, 7 + 42);
});

test('local rpm limit is enforced, then reports 429', async () => {
  const r = await chat({ model: 'good/small' });
  assert.equal(r.status, 429);
  const j = await r.json();
  assert.ok(j.error.attempts.some((a) => a.reason === 'rpm'));
});

test('400 from upstream is returned without trying other providers', async () => {
  app.store.addKey({ provider: 'bad', apiKey: 'sk-bad-secret' });
  hits.length = 0;
  const r = await chat({ model: 'strict' });
  assert.equal(r.status, 400);
  assert.equal(hits.length, 1);
});

test('unknown model -> 404; /v1/models lists configured models', async () => {
  assert.equal((await chat({ model: 'nope-model' })).status, 404);
  const r = await fetch(`${base}/v1/models`, { headers: { authorization: 'Bearer client-1' } });
  const ids = (await r.json()).data.map((d) => d.id);
  assert.ok(ids.includes('auto') && ids.includes('good/small') && ids.includes('shared'));
});

test('admin API needs the admin token and reports usage', async () => {
  assert.equal((await fetch(`${base}/admin/keys`)).status, 401);
  const r = await fetch(`${base}/admin/usage`, { headers: { authorization: 'Bearer adm' } });
  const { data } = await r.json();
  const busy = data.find((k) => k.provider === 'busy');
  assert.equal(busy.models.big.cooldown.reason, 'rate limited by provider');
  assert.ok(!JSON.stringify(data).includes('sk-'));
});
