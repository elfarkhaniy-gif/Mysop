import { createServer } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { Router, RouterError } from './router.js';
import { UsageTracker } from './usage.js';

const MAX_BODY = 10 * 1024 * 1024;
const TYPE_BY_PATH = {
  '/v1/chat/completions': 'chat',
  '/v1/embeddings': 'embedding',
  '/v1/images/generations': 'image',
  '/v1/audio/speech': 'tts',
};

export function createApp({ store, clientKeys = [], adminToken = '', fetchImpl, maxAttempts, timeoutMs, log = console }) {
  const usage = new UsageTracker(store);
  const router = new Router({ store, usage, fetchImpl, maxAttempts, timeoutMs });

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://local');
    setCors(res);
    if (req.method === 'OPTIONS') return end(res, 204);

    try {
      if (url.pathname === '/health') return json(res, 200, { ok: true });

      if (url.pathname.startsWith('/v1/')) {
        if (clientKeys.length && !clientKeys.some((k) => safeEq(bearer(req), k))) {
          return oaiError(res, 401, 'Invalid API key', 'invalid_api_key');
        }
        if (req.method === 'GET' && url.pathname === '/v1/models') {
          return json(res, 200, listModels(router, url.searchParams.get('all') === '1'));
        }
        const type = TYPE_BY_PATH[url.pathname];
        if (req.method === 'POST' && type) return await proxy(req, res, router, type, log);
        return oaiError(res, 404, `No route ${req.method} ${url.pathname}`, 'not_found');
      }

      if (url.pathname.startsWith('/admin/')) {
        if (!adminToken) return json(res, 403, { error: 'Admin API disabled: set FREELLM_ADMIN_TOKEN.' });
        if (!safeEq(bearer(req), adminToken)) return json(res, 401, { error: 'Invalid admin token' });
        return await admin(req, res, url, store, router, usage);
      }

      return json(res, 404, { error: 'Not found' });
    } catch (err) {
      if (err instanceof RouterError) {
        if (res.headersSent || err.status === 499) return res.end();
        return json(res, err.status, {
          error: {
            message: err.message,
            type: 'router_error',
            upstream: err.upstream ? safeParse(err.upstream.text) : undefined,
            attempts: err.attempts,
          },
        });
      }
      if (err.status) return json(res, err.status, { error: { message: err.message } });
      log.error?.(err);
      if (!res.headersSent) json(res, 500, { error: { message: 'Internal error' } });
      else res.end();
    }
  });

  return { server, router, usage, store };
}

// ---------- /v1 proxy ----------

async function proxy(req, res, router, type, log) {
  const body = await readJson(req);
  // Abort the upstream call (and stop spending quota) if the client goes away.
  const clientGone = new AbortController();
  res.on('close', () => { if (!res.writableFinished) clientGone.abort(); });
  const { res: up, candidate, usageHandle, attempts } = await router.dispatch(type, body, { signal: clientGone.signal });

  const headers = {
    'content-type': up.headers.get('content-type') ?? 'application/json',
    'x-freellm-provider': candidate.provider,
    'x-freellm-model': candidate.model.id,
    'x-freellm-attempts': String(attempts.length + 1),
  };
  log.info?.(`${type} -> ${candidate.provider}/${candidate.model.id}${attempts.length ? ` (after ${attempts.length} failover)` : ''}`);

  const isSse = headers['content-type'].includes('text/event-stream');
  if (isSse) {
    headers['cache-control'] = 'no-cache';
    res.writeHead(200, headers);
    const decoder = new TextDecoder();
    let buf = '';
    let completionChars = 0;
    let reported = null;
    for await (const chunk of up.body) {
      if (clientGone.signal.aborted) break;
      res.write(chunk);
      buf += decoder.decode(chunk, { stream: true });
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (data === '[DONE]') continue;
        const evt = safeParse(data);
        if (evt?.usage?.total_tokens) reported = evt.usage.total_tokens;
        for (const ch of evt?.choices ?? []) completionChars += (ch.delta?.content ?? '').length;
      }
    }
    res.end();
    const promptEst = Math.ceil(JSON.stringify(body.messages ?? '').length / 4);
    usageHandle.setTokens(reported ?? promptEst + Math.ceil(completionChars / 4));
    return;
  }

  const raw = Buffer.from(await up.arrayBuffer());
  if (headers['content-type'].includes('json')) {
    const parsed = safeParse(raw.toString('utf8'));
    const total = parsed?.usage?.total_tokens ?? parsed?.usage?.prompt_tokens;
    if (total != null) usageHandle.setTokens(total);
  }
  res.writeHead(200, headers);
  res.end(raw);
}

function listModels(router, all) {
  const seen = new Map();
  const add = (id, owned_by, extra) => { if (!seen.has(id)) seen.set(id, { id, object: 'model', created: 0, owned_by, ...extra }); };
  add('auto', 'freellm', { type: 'chat' });
  for (const c of router.allModels()) {
    if (!all && !c.keys.length) continue;
    const type = c.model.type ?? 'chat';
    add(`${c.provider}/${c.model.id}`, c.provider, { type, tier: c.model.tier ?? 0 });
    add(c.model.id, c.provider, { type });
    for (const a of c.model.aliases ?? []) add(a, 'freellm', { type });
  }
  return { object: 'list', data: [...seen.values()] };
}

// ---------- /admin ----------

async function admin(req, res, url, store, router, usage) {
  const parts = url.pathname.split('/').filter(Boolean); // ['admin', resource, id?]
  const [, resource, id] = parts;
  const m = req.method;

  if (resource === 'keys') {
    if (m === 'GET' && !id) return json(res, 200, { data: store.listKeys() });
    if (m === 'POST' && !id) {
      const b = await readJson(req);
      if (typeof b.key !== 'string' || !b.key.trim()) return json(res, 400, { error: '"key" (string) is required' });
      if (!router.providers()[b.provider]) return json(res, 400, { error: `Unknown provider "${b.provider}"` });
      return json(res, 201, store.addKey({ provider: b.provider, apiKey: b.key.trim(), label: String(b.label ?? '') }));
    }
    if (m === 'PATCH' && id) {
      const k = store.updateKey(id, await readJson(req));
      return k ? json(res, 200, k) : json(res, 404, { error: 'No such key' });
    }
    if (m === 'DELETE' && id) return store.removeKey(id) ? end(res, 204) : json(res, 404, { error: 'No such key' });
  }

  if (resource === 'providers') {
    if (m === 'GET' && !id) {
      const data = Object.entries(router.providers()).map(([pid, p]) => ({
        id: pid, name: p.name ?? pid, baseUrl: p.baseUrl, custom: pid in store.data.providers,
        keys: store.keysFor(pid).length, models: p.models ?? [],
      }));
      return json(res, 200, { data });
    }
    if ((m === 'PUT' || m === 'POST') && id) {
      const b = await readJson(req);
      if (!/^[a-z0-9_-]+$/i.test(id)) return json(res, 400, { error: 'Provider id must be alphanumeric/-/_' });
      if (typeof b.baseUrl !== 'string' || !/^https?:\/\//.test(b.baseUrl)) return json(res, 400, { error: 'baseUrl must be an http(s) URL' });
      if (b.models != null && !Array.isArray(b.models)) return json(res, 400, { error: '"models" must be an array' });
      const models = (b.models ?? []).map((x) => ({
        id: String(x.id), type: x.type ?? 'chat', tier: Number(x.tier ?? 1),
        aliases: x.aliases ?? [], limits: x.limits ?? {},
      }));
      store.setProvider(id, { name: b.name ?? id, baseUrl: b.baseUrl, headers: b.headers ?? {}, models });
      return json(res, 200, { id, ...store.data.providers[id] });
    }
    if (m === 'DELETE' && id) return store.removeProvider(id) ? end(res, 204) : json(res, 404, { error: 'No such custom provider' });
  }

  if (resource === 'usage' && m === 'GET') {
    const providers = router.providers();
    const data = store.listKeys().map((k) => {
      const models = {};
      for (const md of providers[k.provider]?.models ?? []) {
        models[md.id] = { limits: md.limits ?? {}, cooldown: usage.cooldownInfo(k.id, md.id) };
      }
      for (const [model, u] of Object.entries(usage.summary(k.id))) {
        models[model] = { ...(models[model] ?? { limits: {}, cooldown: usage.cooldownInfo(k.id, model) }), ...u };
      }
      return { ...k, models };
    });
    return json(res, 200, { data });
  }

  return json(res, 404, { error: 'Not found' });
}

// ---------- helpers ----------

function bearer(req) {
  const h = req.headers.authorization ?? '';
  return h.startsWith('Bearer ') ? h.slice(7).trim() : (req.headers['x-api-key'] ?? '');
}

function safeEq(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && timingSafeEqual(x, y);
}

async function readJson(req) {
  let size = 0;
  const chunks = [];
  for await (const c of req) {
    size += c.length;
    if (size > MAX_BODY) throw Object.assign(new Error('Request body too large'), { status: 413 });
    chunks.push(c);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
  } catch {
    throw Object.assign(new Error('Body must be valid JSON'), { status: 400 });
  }
}

function safeParse(s) {
  try { return JSON.parse(s); } catch { return s || undefined; }
}

function setCors(res) {
  res.setHeader('access-control-allow-origin', '*');
  res.setHeader('access-control-allow-headers', 'authorization, content-type, x-api-key');
  res.setHeader('access-control-allow-methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
  res.setHeader('access-control-expose-headers', 'x-freellm-provider, x-freellm-model, x-freellm-attempts');
}

function json(res, status, obj) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(obj));
}

function oaiError(res, status, message, code) {
  json(res, status, { error: { message, type: 'invalid_request_error', code } });
}

function end(res, status) {
  res.writeHead(status);
  res.end();
}
