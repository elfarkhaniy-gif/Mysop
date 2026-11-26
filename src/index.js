#!/usr/bin/env node
import { config } from './config.js';
import { Store } from './store.js';
import { createApp } from './server.js';

const cfg = config();
let store;
try {
  store = new Store({ file: cfg.dataFile, masterKey: cfg.masterKey });
} catch (err) {
  console.error(`Startup failed: ${err.message}`);
  process.exit(1);
}

const { server } = createApp({ store, ...cfg });
server.listen(cfg.port, cfg.host, () => {
  console.log(`FreeLLM router listening on http://${cfg.host}:${cfg.port}/v1`);
  if (!cfg.clientKeys.length) console.warn('Warning: FREELLM_API_KEYS is empty, so /v1 accepts requests without a key.');
  if (!cfg.adminToken) console.warn('Note: FREELLM_ADMIN_TOKEN is unset, so /admin is disabled (use the CLI to manage keys).');
  if (!store.data.keys.length) console.warn('No provider keys yet. Add one with: echo "$KEY" | npm run -s cli -- keys add groq');
});

const shutdown = () => {
  store.saveNow();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2000).unref();
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
