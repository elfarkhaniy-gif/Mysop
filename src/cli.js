#!/usr/bin/env node
// Manage provider keys locally, without the admin API.
//   echo "$GROQ_KEY" | node src/cli.js keys add groq [label]
//   node src/cli.js keys list
//   node src/cli.js keys rm <key-id>
//   node src/cli.js providers
import { config } from './config.js';
import { Store } from './store.js';
import { BUILTIN_PROVIDERS } from './catalog.js';

const cfg = config();
const [cmd, sub, ...rest] = process.argv.slice(2);

async function readStdin() {
  if (process.stdin.isTTY) {
    process.stderr.write('Paste the API key and press Enter: ');
  }
  let s = '';
  for await (const c of process.stdin) {
    s += c;
    if (process.stdin.isTTY && s.includes('\n')) break;
  }
  return s.trim();
}

try {
  const store = new Store({ file: cfg.dataFile, masterKey: cfg.masterKey });
  const providers = { ...BUILTIN_PROVIDERS, ...store.data.providers };

  if (cmd === 'keys' && sub === 'add') {
    const [provider, label = ''] = rest;
    if (!providers[provider]) throw new Error(`Unknown provider "${provider}". Known: ${Object.keys(providers).join(', ')}`);
    const apiKey = await readStdin();
    if (!apiKey) throw new Error('No key read from stdin.');
    console.log(store.addKey({ provider, apiKey, label }));
  } else if (cmd === 'keys' && sub === 'list') {
    console.table(store.listKeys());
  } else if (cmd === 'keys' && sub === 'rm') {
    console.log(store.removeKey(rest[0]) ? 'removed' : 'no such key');
  } else if (cmd === 'providers') {
    for (const [id, p] of Object.entries(providers)) {
      console.log(`${id.padEnd(12)} ${p.baseUrl}  keys=${store.keysFor(id).length}`);
      for (const m of p.models ?? []) console.log(`    ${m.type ?? 'chat'}  ${m.id}  tier=${m.tier ?? 0}`);
    }
  } else {
    console.log('Usage:\n  keys add <provider> [label]   (key read from stdin)\n  keys list\n  keys rm <key-id>\n  providers');
    process.exitCode = cmd ? 1 : 0;
  }
} catch (err) {
  console.error(err.message);
  process.exitCode = 1;
}
