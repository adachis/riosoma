/**
 * The providers Riosoma ships with.  Importing this module registers every one of them, so a caller
 * can ask for a provider by id without knowing which adapters exist.
 */
export {
  PROVIDER_MESSAGE_KEYS,
  RetryableProviderError,
  providerFailure,
  type ProviderMessageKey,
  type ProviderFailure,
} from './errors.js';
export { providerFor, providers, registerProvider } from './registry.js';
export { chatCompletionsProvider, type ChatCompletionsOptions } from './openai-compatible.js';
export { openaiProvider } from './openai.js';
export { mistralProvider } from './mistral.js';
export { openrouterProvider } from './openrouter.js';
export { ollamaProvider } from './ollama.js';
export { geminiProvider } from './gemini.js';
export { anthropicProvider } from './anthropic.js';
export { bedrockProvider } from './bedrock.js';
export { vertexProvider } from './vertex.js';
export { azureProvider } from './azure.js';
export { falProvider } from './fal.js';
export { gatewayProvider, gatewayHeaders, isGateway } from './gateway.js';
