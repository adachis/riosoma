/** The provider settings the server reads, by the setting's name. */
export interface ProviderKeySettings {
  RIOSOMA_OPENAI_API_KEY?: string | undefined;
  RIOSOMA_ANTHROPIC_API_KEY?: string | undefined;
  RIOSOMA_GEMINI_API_KEY?: string | undefined;
  RIOSOMA_MISTRAL_API_KEY?: string | undefined;
  RIOSOMA_OPENROUTER_API_KEY?: string | undefined;
  RIOSOMA_OLLAMA_API_KEY?: string | undefined;
  RIOSOMA_ANTHROPIC_WORKSPACE_ID?: string | undefined;
}

/**
 * The API key each provider gets from the server's settings, keyed by the provider's ID, and the
 * workspace one provider's keys may need.  It lives beside the providers so their names stay here.
 */
export function providerKeysFrom(settings: ProviderKeySettings) {
  return {
    providerApiKeys: {
      openai: settings.RIOSOMA_OPENAI_API_KEY,
      anthropic: settings.RIOSOMA_ANTHROPIC_API_KEY,
      gemini: settings.RIOSOMA_GEMINI_API_KEY,
      mistral: settings.RIOSOMA_MISTRAL_API_KEY,
      openrouter: settings.RIOSOMA_OPENROUTER_API_KEY,
      ollama: settings.RIOSOMA_OLLAMA_API_KEY,
    },
    providerWorkspaceId: settings.RIOSOMA_ANTHROPIC_WORKSPACE_ID,
  };
}
