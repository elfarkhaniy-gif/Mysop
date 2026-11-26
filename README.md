# Mysop: FreeLLM router

One OpenAI-compatible `/v1` endpoint in front of many free-tier LLM providers.

- **Router**: picks the best available model for each request (`model: "auto"`, an alias such as `llama-3.3-70b`, or an exact `provider/model-id`).
- **Failover**: if a provider rate-limits (429), rejects a key (401/403), drops a model (404), times out or errors (5xx), the request moves to the next provider. That key/model then cools down for a while; on a 429 the cooldown follows the provider's `Retry-After` header.
- **Per-key usage tracking**: counts requests and tokens per key over sliding windows of 1 minute and 24 hours, checked against each free tier's rpm/rpd/tpm/tpd. A key is skipped *before* it hits a cap, and load spreads across keys and providers.
- **Encrypted key storage**: provider keys are encrypted with AES-256-GCM, using a key derived (scrypt) from `FREELLM_MASTER_KEY`. The store file is written with mode `0600`.
- **Custom endpoints**: register any OpenAI-compatible chat, embedding, image or text-to-speech endpoint at runtime.
- Zero runtime dependencies. Needs Node ≥ 20.

Built-in providers: Groq, Cerebras, Google Gemini, Mistral, OpenRouter (`:free` models), NVIDIA NIM and GitHub Models. Run `npm run cli -- providers` to list them.

> Free-tier model IDs and quotas change often. The limits in `src/catalog.js` are conservative defaults, not guarantees. Edit them, or override a provider with `PUT /admin/providers/<id>`. Check each provider's terms of service before you pool keys.

## Quick start

Easiest: run `install.bat` (Windows) or `./install.sh` (Mac/Linux), then `start.bat` / `./start.sh`. The installer creates `.env` with random secrets and offers to add your first provider key. An Arabic guide is in [INSTALL_AR.md](INSTALL_AR.md).

Manual setup:

```bash
cp .env.example .env          # then set FREELLM_MASTER_KEY, FREELLM_ADMIN_TOKEN, FREELLM_API_KEYS
echo "$GROQ_API_KEY"   | npm run -s cli -- keys add groq
echo "$GEMINI_API_KEY" | npm run -s cli -- keys add gemini
npm start                     # http://127.0.0.1:8787/v1
```

The CLI reads keys from stdin, so they stay out of your shell history.

Use it from any OpenAI client:

```python
from openai import OpenAI
client = OpenAI(base_url="http://127.0.0.1:8787/v1", api_key="sk-local-1")
r = client.chat.completions.create(model="auto", messages=[{"role": "user", "content": "Hi"}])
```

```bash
curl http://127.0.0.1:8787/v1/chat/completions \
  -H "Authorization: Bearer sk-local-1" -H "Content-Type: application/json" \
  -d '{"model":"llama-3.3-70b","stream":true,"messages":[{"role":"user","content":"Hi"}]}'
```

Each response carries `x-freellm-provider`, `x-freellm-model` and `x-freellm-attempts` headers.

## Choosing a model

| `model` value | Behaviour |
|---|---|
| `auto` (or omitted) | Every chat model that has a key, highest `tier` first, least-used key first |
| alias, e.g. `llama-3.3-70b` | Every provider serving that model (Groq → OpenRouter → NVIDIA…) |
| `groq/llama-3.1-8b-instant` | Exactly that provider and model; also works for models not in the catalog |

## API

Client routes (`Authorization: Bearer <one of FREELLM_API_KEYS>`):

- `GET /v1/models` (`?all=1` also lists models without keys)
- `POST /v1/chat/completions` (streaming supported)
- `POST /v1/embeddings`
- `POST /v1/images/generations`
- `POST /v1/audio/speech`

Admin routes (`Authorization: Bearer $FREELLM_ADMIN_TOKEN`):

| Route | Purpose |
|---|---|
| `GET /admin/keys` | List keys (masked; secrets are never returned) |
| `POST /admin/keys` `{provider, key, label}` | Add a key |
| `PATCH /admin/keys/:id` `{disabled, label}` | Enable/disable or relabel |
| `DELETE /admin/keys/:id` | Remove a key |
| `GET /admin/providers` | Built-in and custom providers |
| `PUT /admin/providers/:id` `{baseUrl, models:[{id,type,tier,aliases,limits}], headers}` | Add or override a provider |
| `DELETE /admin/providers/:id` | Remove a custom provider |
| `GET /admin/usage` | Per key/model usage for the last minute and 24 h, plus limits and cooldowns |

Example custom endpoint (a local Ollama server):

```bash
curl -X PUT http://127.0.0.1:8787/admin/providers/ollama -H "Authorization: Bearer $FREELLM_ADMIN_TOKEN" \
  -d '{"baseUrl":"http://localhost:11434/v1","models":[{"id":"llama3.2","tier":1,"aliases":["local"]}]}'
echo "ollama" | npm run -s cli -- keys add ollama
```

## Configuration

| Variable | Default | |
|---|---|---|
| `FREELLM_MASTER_KEY` | (required) | Encrypts the stored keys. If you lose it, the stored keys can't be decrypted. |
| `FREELLM_ADMIN_TOKEN` | empty | `/admin` is disabled while this is unset |
| `FREELLM_API_KEYS` | empty | Comma-separated client keys. If empty, `/v1` is open to anyone who can reach the port. |
| `HOST` / `PORT` | `127.0.0.1` / `8787` | |
| `FREELLM_DATA_FILE` | `./data/store.json` | Encrypted keys, custom providers, usage windows |
| `FREELLM_MAX_ATTEMPTS` | `5` | Most providers tried per request |
| `FREELLM_TIMEOUT_MS` | `120000` | Upstream timeout |

## How a request is routed

1. The `model` value is resolved to candidate (provider, model) pairs, each paired with every enabled key for that provider.
2. Candidates are dropped if they are cooling down or would exceed a local rpm/tpm/rpd/tpd limit (the token count is estimated from the prompt size plus `max_tokens`).
3. The rest are sorted by tier (highest first), then by how much of their quota is used (least first), and tried in that order.
4. On success, the estimated token count is replaced with the provider's reported `usage` (or a count of streamed characters).
5. A 400/413/422 response goes straight back to the client, because that request would likely fail everywhere.
6. Streams fail over only before the first byte reaches the client.

## Tests

```bash
npm test
```

The tests run the router against fake upstream servers. They cover failover, cooldowns, local rate limits, encryption, streaming usage accounting and admin authentication.

## Not yet included

- `/v1/audio/transcriptions` (multipart uploads)
- A web dashboard
- Automatic syncing of model lists from providers' `/models` endpoints
