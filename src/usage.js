const MIN = 60_000;
const DAY = 86_400_000;

/**
 * Sliding-window usage per (key, model). Events are [timestamp, tokens] pairs
 * kept for 24 h and persisted through the store so limits survive restarts.
 * Cooldowns (after a 429, auth failure, outage…) are kept in memory only.
 */
export class UsageTracker {
  constructor(store, now = Date.now) {
    this.store = store;
    this.now = now;
    this.events = store.data.usage; // bucket -> [[ts, tokens], ...]
    this.cooldowns = new Map(); // bucket -> { until, reason }
  }

  static bucket(keyId, model) {
    return `${keyId}|${model}`;
  }

  #prune(list, t) {
    let i = 0;
    while (i < list.length && list[i][0] <= t - DAY) i++;
    if (i) list.splice(0, i);
  }

  window(keyId, model, ms) {
    const t = this.now();
    const list = this.events[UsageTracker.bucket(keyId, model)] ?? [];
    let requests = 0;
    let tokens = 0;
    for (let i = list.length - 1; i >= 0 && list[i][0] > t - ms; i--) {
      requests++;
      tokens += list[i][1];
    }
    return { requests, tokens };
  }

  /** Returns null if the key/model can take the request, else the reason it can't. */
  blocker(keyId, model, limits = {}, estTokens = 0) {
    const t = this.now();
    const cd = this.cooldowns.get(UsageTracker.bucket(keyId, model)) ?? this.cooldowns.get(UsageTracker.bucket(keyId, '*'));
    if (cd && cd.until > t) return `cooldown (${cd.reason})`;
    const m = this.window(keyId, model, MIN);
    if (limits.rpm && m.requests + 1 > limits.rpm) return 'rpm';
    if (limits.tpm && m.tokens + estTokens > limits.tpm) return 'tpm';
    if (limits.rpd || limits.tpd) {
      const d = this.window(keyId, model, DAY);
      if (limits.rpd && d.requests + 1 > limits.rpd) return 'rpd';
      if (limits.tpd && d.tokens + estTokens > limits.tpd) return 'tpd';
    }
    return null;
  }

  /** Fraction (0..1) of the tightest daily/minute budget already used — for load spreading. */
  pressure(keyId, model, limits = {}) {
    const m = this.window(keyId, model, MIN);
    const d = this.window(keyId, model, DAY);
    return Math.max(
      limits.rpm ? m.requests / limits.rpm : 0,
      limits.tpm ? m.tokens / limits.tpm : 0,
      limits.rpd ? d.requests / limits.rpd : 0,
      limits.tpd ? d.tokens / limits.tpd : 0,
    );
  }

  /** Records a request up front; returns a handle to correct the token count later. */
  record(keyId, model, tokens) {
    const b = UsageTracker.bucket(keyId, model);
    const list = (this.events[b] ??= []);
    const t = this.now();
    this.#prune(list, t);
    const ev = [t, tokens];
    list.push(ev);
    this.store.saveSoon();
    return {
      setTokens: (n) => {
        if (Number.isFinite(n) && n >= 0) {
          ev[1] = Math.round(n);
          this.store.saveSoon();
        }
      },
    };
  }

  cooldown(keyId, model, ms, reason) {
    this.cooldowns.set(UsageTracker.bucket(keyId, model), { until: this.now() + ms, reason });
  }

  cooldownInfo(keyId, model) {
    const cd = this.cooldowns.get(UsageTracker.bucket(keyId, model)) ?? this.cooldowns.get(UsageTracker.bucket(keyId, '*'));
    return cd && cd.until > this.now() ? { reason: cd.reason, secondsLeft: Math.ceil((cd.until - this.now()) / 1000) } : null;
  }

  /** All buckets for one key: { model: { minute, day } } */
  summary(keyId) {
    const out = {};
    for (const b of Object.keys(this.events)) {
      const [k, model] = splitBucket(b);
      if (k !== keyId) continue;
      out[model] = { lastMinute: this.window(k, model, MIN), last24h: this.window(k, model, DAY) };
    }
    return out;
  }
}

function splitBucket(b) {
  const i = b.indexOf('|');
  return [b.slice(0, i), b.slice(i + 1)];
}

/** Cheap token estimate (~4 chars/token) for budgeting before the provider answers. */
export function estimateTokens(body, type = 'chat') {
  const src = body.messages ?? body.input ?? body.prompt ?? '';
  const chars = typeof src === 'string' ? src.length : (JSON.stringify(src) ?? '').length;
  const prompt = Math.ceil(chars / 4);
  if (type !== 'chat') return prompt; // embeddings/images/tts produce no completion tokens
  const out = Number(body.max_tokens ?? body.max_completion_tokens ?? 256);
  return prompt + (Number.isFinite(out) && out >= 0 ? Math.min(out, 4096) : 256);
}
