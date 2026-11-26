#!/usr/bin/env bash
# Mac / Linux installer: checks Node.js, creates .env, adds a first key, runs the tests.
set -e
cd "$(dirname "$0")"
if ! command -v node >/dev/null 2>&1; then
  echo "Node.js is not installed. Install Node.js 20+ from https://nodejs.org and run this again."
  exit 1
fi
node scripts/setup.js
node --test test/*.test.js >/dev/null 2>&1 && echo "Self-test: OK" || echo "Self-test failed: run 'npm test' to see why."
echo
read -r -p "Add a provider key now? Enter provider name (groq, gemini, mistral, openrouter, cerebras, nvidia, github) or press Enter to skip: " P
if [ -n "$P" ]; then node src/cli.js keys add "$P"; fi
echo
echo "Done. Start the server with:  ./start.sh"
