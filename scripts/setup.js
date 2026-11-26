// First-run setup: creates .env with random secrets if it doesn't exist yet.
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { randomBytes } from 'node:crypto';

const [major] = process.versions.node.split('.').map(Number);
if (major < 20) {
  console.error(`Node.js ${process.versions.node} is too old. Install Node.js 20 or newer from https://nodejs.org`);
  process.exit(1);
}

mkdirSync('data', { recursive: true });
if (existsSync('.env')) {
  console.log('.env already exists, keeping your current settings.');
} else {
  const rnd = (n) => randomBytes(n).toString('base64url');
  const clientKey = `sk-local-${rnd(18)}`;
  const env = readFileSync('.env.example', 'utf8')
    .replace(/^FREELLM_MASTER_KEY=.*$/m, `FREELLM_MASTER_KEY=${rnd(32)}`)
    .replace(/^FREELLM_ADMIN_TOKEN=.*$/m, `FREELLM_ADMIN_TOKEN=${rnd(24)}`)
    .replace(/^FREELLM_API_KEYS=.*$/m, `FREELLM_API_KEYS=${clientKey}`);
  writeFileSync('.env', env, { mode: 0o600 });
  console.log('Created .env with random secrets.');
  console.log('IMPORTANT: back up .env. Without FREELLM_MASTER_KEY your stored keys cannot be decrypted.');
  console.log(`Your client API key (use it in your apps): ${clientKey}`);
}
console.log('\nNext: add a free provider key, e.g.  npm run -s cli -- keys add groq');
console.log('Then start the server:              npm start');
