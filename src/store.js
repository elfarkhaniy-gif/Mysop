import { randomBytes, scryptSync, createCipheriv, createDecipheriv } from 'node:crypto';
import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';

const VERSION = 1;

/**
 * JSON-file store. Provider API keys are encrypted with AES-256-GCM using a key
 * derived (scrypt) from FREELLM_MASTER_KEY and a per-store random salt.
 * Pass file = null for an in-memory store (tests).
 */
export class Store {
  constructor({ file = null, masterKey }) {
    if (!masterKey || masterKey.length < 12) {
      throw new Error('FREELLM_MASTER_KEY must be set (at least 12 characters).');
    }
    this.file = file;
    this.data = this.#load();
    this.key = scryptSync(masterKey, Buffer.from(this.data.salt, 'base64'), 32);
    this.#saveTimer = null;
    // Fail fast if the master key changed since keys were stored.
    const first = this.data.keys[0];
    if (first) {
      try { this.#decrypt(first.enc); } catch {
        throw new Error('FREELLM_MASTER_KEY does not match the one used to encrypt the stored keys.');
      }
    }
  }

  #saveTimer;

  #load() {
    if (this.file && existsSync(this.file)) {
      const data = JSON.parse(readFileSync(this.file, 'utf8'));
      data.keys ??= [];
      data.providers ??= {};
      data.usage ??= {};
      return data;
    }
    return { version: VERSION, salt: randomBytes(16).toString('base64'), keys: [], providers: {}, usage: {} };
  }

  #encrypt(plain) {
    const iv = randomBytes(12);
    const c = createCipheriv('aes-256-gcm', this.key, iv);
    const ct = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
    return [iv, c.getAuthTag(), ct].map((b) => b.toString('base64')).join('.');
  }

  #decrypt(blob) {
    const [iv, tag, ct] = blob.split('.').map((s) => Buffer.from(s, 'base64'));
    const d = createDecipheriv('aes-256-gcm', this.key, iv);
    d.setAuthTag(tag);
    return Buffer.concat([d.update(ct), d.final()]).toString('utf8');
  }

  saveNow() {
    if (!this.file) return;
    clearTimeout(this.#saveTimer);
    this.#saveTimer = null;
    mkdirSync(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.data, null, 2), { mode: 0o600 });
    renameSync(tmp, this.file);
  }

  /** Debounced save, for frequent writes such as usage counters. */
  saveSoon(ms = 1000) {
    if (!this.file || this.#saveTimer) return;
    this.#saveTimer = setTimeout(() => this.saveNow(), ms);
    this.#saveTimer.unref?.();
  }

  // ---- provider keys ----

  addKey({ provider, apiKey, label = '' }) {
    if (!provider || !apiKey) throw new Error('provider and key are required');
    const entry = {
      id: `key_${randomBytes(6).toString('hex')}`,
      provider,
      label,
      hint: apiKey.length > 8 ? `…${apiKey.slice(-4)}` : '…',
      enc: this.#encrypt(apiKey),
      disabled: false,
      createdAt: new Date().toISOString(),
    };
    this.data.keys.push(entry);
    this.saveNow();
    return publicKey(entry);
  }

  listKeys() {
    return this.data.keys.map(publicKey);
  }

  keysFor(provider) {
    return this.data.keys.filter((k) => k.provider === provider && !k.disabled);
  }

  secret(keyId) {
    const k = this.data.keys.find((x) => x.id === keyId);
    return k ? this.#decrypt(k.enc) : null;
  }

  updateKey(id, patch) {
    const k = this.data.keys.find((x) => x.id === id);
    if (!k) return null;
    if (typeof patch.disabled === 'boolean') k.disabled = patch.disabled;
    if (typeof patch.label === 'string') k.label = patch.label;
    this.saveNow();
    return publicKey(k);
  }

  removeKey(id) {
    const before = this.data.keys.length;
    this.data.keys = this.data.keys.filter((k) => k.id !== id);
    for (const bucket of Object.keys(this.data.usage)) {
      if (bucket.startsWith(`${id}|`)) delete this.data.usage[bucket];
    }
    this.saveNow();
    return this.data.keys.length < before;
  }

  // ---- custom providers ----

  setProvider(id, def) {
    this.data.providers[id] = def;
    this.saveNow();
  }

  removeProvider(id) {
    const existed = id in this.data.providers;
    delete this.data.providers[id];
    this.saveNow();
    return existed;
  }
}

function publicKey({ enc, ...rest }) {
  return rest;
}
