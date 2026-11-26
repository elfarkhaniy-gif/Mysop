import { BUILTIN_PROVIDERS, ENDPOINTS } from './catalog.js';
import { estimateTokens } from './usage.js';

export class RouterError extends Error {
  constructor(status, message, attempts = []) {
    super(message);
    this.status = status;
    this.attempts = attempts;
  }
}

const RETRYABLE_CLIENT = new Set([401, 403, 404, 408, 409, 429]);

/**
 * Picks (provider, key, model) candidates for a request and walks them in
 * order, failing over on rate limits, auth errors, timeouts and outages.
 */
export class Router {
  constructor({ store, usage, fetchImpl = globalThis.fetch, maxAttempts = 5, timeoutMs = 120_000 }) {
    this.store = store;
    this.usage = usage;
    this.fetch = fetchImpl;
    this.maxAttempts = maxAttempts;
    this.timeoutMs = timeoutMs;
  }

  /** Built-in providers merged with custom ones (custom ids override built-ins). */
  providers() {
    return { ...BUILTIN_PROVIDERS, ...this.store.data.providers };
  }

  /** Every model of `type`, flattened, with whether a usable key exists. */
  allModels(type) {
    const out = [];
    for (const [pid, p] of Object.entries(this.providers())) {
      const keys = this.store.keysFor(pid);
      for (const m of p.models ?? []) {
        if (type && (m.type ?? 'chat') !== type) continue;
        out.push({ provider: pid, providerDef: p, model: m, keys });
      }
    }
    return out;
  }

  /** Resolve the requested model name into an ordered list of candidates. */
  candidates(requested, type, estTokens = 0) {
    const name = typeof requested === 'string' ? requested.trim() : 'auto';
    const providers = this.providers();
    let pool;

    const slash = name.indexOf('/');
    const pid = slash > 0 ? name.slice(0, slash) : null;
    if (pid && providers[pid]) {
      // Explicit "provider/model-id" — use exactly that, even if not in the catalog.
      const id = name.slice(slash + 1);
      const p = providers[pid];
      const m = (p.models ?? []).find((x) => x.id === id) ?? { id, type, tier: 0, limits: {} };
      pool = [{ provider: pid, providerDef: p, model: m, keys: this.store.keysFor(pid) }];
    } else if (name === 'auto' || name === '') {
      pool = this.allModels(type);
    } else {
      pool = this.allModels(type).filter((c) => c.model.id === name || (c.model.aliases ?? []).includes(name));
    }

    const out = [];
    const skipped = [];
    for (const c of pool) {
      if (!c.keys.length) {
        skipped.push({ provider: c.provider, model: c.model.id, reason: 'no key configured' });
        continue;
      }
      for (const k of c.keys) {
        const blocked = this.usage.blocker(k.id, c.model.id, c.model.limits, estTokens);
        if (blocked) {
          skipped.push({ provider: c.provider, model: c.model.id, key: k.id, reason: blocked });
          continue;
        }
        out.push({
          provider: c.provider,
          baseUrl: c.providerDef.baseUrl,
          headers: c.providerDef.headers ?? {},
          model: c.model,
          keyId: k.id,
          pressure: this.usage.pressure(k.id, c.model.id, c.model.limits),
        });
      }
    }
    // Best model first; among equals, the least-used key/provider.
    out.sort((a, b) => (b.model.tier ?? 0) - (a.model.tier ?? 0) || a.pressure - b.pressure);
    return { candidates: out, skipped, matched: pool.length };
  }

  /**
   * Send the request upstream with failover. Resolves with the first successful
   * upstream Response plus the candidate that served it and a usage handle.
   */
  async dispatch(type, body, { signal } = {}) {
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      throw new RouterError(400, 'Request body must be a JSON object');
    }
    if (body.model != null && typeof body.model !== 'string') {
      throw new RouterError(400, '"model" must be a string');
    }
    const est = estimateTokens(body, type);
    const { candidates, skipped, matched } = this.candidates(body.model, type, est);
    if (!matched) throw new RouterError(404, `Unknown model "${body.model}". GET /v1/models lists what is available.`);
    if (!candidates.length) {
      throw new RouterError(skipped.every((s) => s.reason === 'no key configured') ? 503 : 429,
        'No provider can take this request right now (all rate-limited, cooling down, or missing keys).', skipped);
    }

    const attempts = [];
    let lastUpstream = null;
    for (const c of candidates.slice(0, this.maxAttempts)) {
      const handle = this.usage.record(c.keyId, c.model.id, est);
      const payload = { ...body, model: c.model.id };
      if (payload.stream && type === 'chat') payload.stream_options ??= { include_usage: true };
      // The timeout covers waiting for response headers only, so long streams
      // aren't cut off; the client's signal aborts the upstream call at any time.
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(new DOMException('timeout', 'TimeoutError')), this.timeoutMs);
      const upstreamSignal = signal ? AbortSignal.any([signal, ctrl.signal]) : ctrl.signal;
      let res;
      try {
        res = await this.fetch(c.baseUrl.replace(/\/$/, '') + ENDPOINTS[type], {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${this.store.secret(c.keyId)}`,
            ...c.headers,
          },
          body: JSON.stringify(payload),
          signal: upstreamSignal,
        });
      } catch (err) {
        clearTimeout(timer);
        if (signal?.aborted) {
          handle.setTokens(0);
          throw new RouterError(499, 'Client closed the request', attempts);
        }
        const timedOut = ctrl.signal.aborted;
        this.usage.cooldown(c.keyId, c.model.id, 30_000, 'network error');
        attempts.push({ provider: c.provider, model: c.model.id, error: timedOut ? 'timeout' : err.message });
        continue;
      }
      clearTimeout(timer);

      if (res.ok) return { res, candidate: c, usageHandle: handle, attempts };

      const status = res.status;
      const text = await res.text().catch(() => '');
      attempts.push({ provider: c.provider, model: c.model.id, status, error: text.slice(0, 300) });
      lastUpstream = { status, text, contentType: res.headers.get('content-type') };

      if (status === 429) {
        this.usage.cooldown(c.keyId, c.model.id, retryAfterMs(res) ?? 60_000, 'rate limited by provider');
      } else if (status === 401 || status === 403) {
        this.usage.cooldown(c.keyId, '*', 3_600_000, `auth failed (${status})`);
      } else if (status === 404) {
        this.usage.cooldown(c.keyId, c.model.id, 3_600_000, 'model not found');
      } else if (status >= 500) {
        this.usage.cooldown(c.keyId, c.model.id, 30_000, `provider error ${status}`);
      } else if (!RETRYABLE_CLIENT.has(status)) {
        // 400/413/422…: the request itself is likely bad; don't burn other quotas on it.
        handle.setTokens(0);
        throw Object.assign(new RouterError(status, 'Upstream rejected the request', attempts), { upstream: lastUpstream });
      }
    }
    throw Object.assign(new RouterError(lastUpstream?.status === 429 ? 429 : 502, 'All providers failed', attempts), { upstream: lastUpstream });
  }
}

function retryAfterMs(res) {
  const h = res.headers.get('retry-after');
  if (!h) return null;
  const s = Number(h);
  if (Number.isFinite(s)) return Math.max(1000, s * 1000);
  const d = Date.parse(h);
  return Number.isFinite(d) ? Math.max(1000, d - Date.now()) : null;
}
