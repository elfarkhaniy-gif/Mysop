import { readFileSync, existsSync } from 'node:fs';

/** Load KEY=VALUE pairs from .env (if present) without overriding real env vars. */
export function loadEnv(path = '.env') {
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i);
    if (!m || line.trim().startsWith('#')) continue;
    const v = m[2].replace(/^(['"])(.*)\1$/, '$2');
    if (process.env[m[1]] === undefined) process.env[m[1]] = v;
  }
}

export function config() {
  loadEnv();
  const e = process.env;
  return {
    port: Number(e.PORT ?? 8787),
    host: e.HOST ?? '127.0.0.1',
    dataFile: e.FREELLM_DATA_FILE ?? './data/store.json',
    masterKey: e.FREELLM_MASTER_KEY,
    adminToken: e.FREELLM_ADMIN_TOKEN ?? '',
    clientKeys: (e.FREELLM_API_KEYS ?? '').split(',').map((s) => s.trim()).filter(Boolean),
    maxAttempts: Number(e.FREELLM_MAX_ATTEMPTS ?? 5),
    timeoutMs: Number(e.FREELLM_TIMEOUT_MS ?? 120_000),
  };
}
