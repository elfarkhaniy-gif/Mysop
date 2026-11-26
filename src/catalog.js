// Built-in catalog of free-tier, OpenAI-compatible providers.
//
// `tier` is a rough quality score (higher = preferred by the "auto" router).
// `limits` are conservative local defaults for each free tier, per API key:
//   rpm/rpd = requests per minute/day, tpm/tpd = tokens per minute/day.
// Providers change model IDs and quotas often. Treat these as starting points:
// override them by registering a custom provider with the same id
// (POST /admin/providers), or call any model directly as "provider/model-id".

export const BUILTIN_PROVIDERS = {
  groq: {
    name: 'Groq',
    baseUrl: 'https://api.groq.com/openai/v1',
    models: [
      { id: 'llama-3.3-70b-versatile', type: 'chat', tier: 3, aliases: ['llama-3.3-70b'], limits: { rpm: 30, rpd: 1000, tpm: 12000, tpd: 100000 } },
      { id: 'llama-3.1-8b-instant', type: 'chat', tier: 1, aliases: ['llama-3.1-8b'], limits: { rpm: 30, rpd: 14400, tpm: 6000, tpd: 500000 } },
    ],
  },
  cerebras: {
    name: 'Cerebras',
    baseUrl: 'https://api.cerebras.ai/v1',
    models: [
      { id: 'gpt-oss-120b', type: 'chat', tier: 3, aliases: ['gpt-oss-120b'], limits: { rpm: 30, rpd: 14400, tpm: 60000, tpd: 1000000 } },
      { id: 'llama3.1-8b', type: 'chat', tier: 1, aliases: ['llama-3.1-8b'], limits: { rpm: 30, rpd: 14400, tpm: 60000, tpd: 1000000 } },
    ],
  },
  gemini: {
    name: 'Google Gemini',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    models: [
      { id: 'gemini-2.5-flash', type: 'chat', tier: 4, aliases: ['gemini-flash'], limits: { rpm: 10, rpd: 250, tpm: 250000 } },
      { id: 'gemini-2.5-flash-lite', type: 'chat', tier: 2, aliases: ['gemini-flash-lite'], limits: { rpm: 15, rpd: 1000, tpm: 250000 } },
      { id: 'gemini-embedding-001', type: 'embedding', tier: 3, aliases: ['embedding'], limits: { rpm: 100, rpd: 1000 } },
    ],
  },
  mistral: {
    name: 'Mistral',
    baseUrl: 'https://api.mistral.ai/v1',
    models: [
      { id: 'mistral-small-latest', type: 'chat', tier: 2, aliases: ['mistral-small'], limits: { rpm: 60, tpm: 500000 } },
      { id: 'mistral-embed', type: 'embedding', tier: 2, aliases: ['embedding'], limits: { rpm: 60, tpm: 500000 } },
    ],
  },
  openrouter: {
    name: 'OpenRouter (free models)',
    baseUrl: 'https://openrouter.ai/api/v1',
    models: [
      { id: 'meta-llama/llama-3.3-70b-instruct:free', type: 'chat', tier: 3, aliases: ['llama-3.3-70b'], limits: { rpm: 20, rpd: 50 } },
      { id: 'deepseek/deepseek-chat-v3-0324:free', type: 'chat', tier: 4, aliases: ['deepseek-chat'], limits: { rpm: 20, rpd: 50 } },
    ],
  },
  nvidia: {
    name: 'NVIDIA NIM',
    baseUrl: 'https://integrate.api.nvidia.com/v1',
    models: [
      { id: 'meta/llama-3.3-70b-instruct', type: 'chat', tier: 3, aliases: ['llama-3.3-70b'], limits: { rpm: 40 } },
    ],
  },
  github: {
    name: 'GitHub Models',
    baseUrl: 'https://models.github.ai/inference',
    models: [
      { id: 'openai/gpt-4.1-mini', type: 'chat', tier: 4, aliases: ['gpt-4.1-mini'], limits: { rpm: 15, rpd: 150, tpm: 8000 } },
    ],
  },
};

// Endpoint path (relative to a provider's baseUrl) for each request type.
export const ENDPOINTS = {
  chat: '/chat/completions',
  embedding: '/embeddings',
  image: '/images/generations',
  tts: '/audio/speech',
};
