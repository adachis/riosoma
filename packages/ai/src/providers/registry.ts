import { ProviderError, type ProviderAdapter } from '../types.js';

/**
 * The adapters Riosoma can talk to.  This lives apart from the package's entry point so an adapter
 * can register itself while that entry point is still being evaluated, and so tests can register
 * fakes without pulling every adapter in.
 */
const adapters = new Map<string, ProviderAdapter>();

/** Makes a provider available.  Each provider's module registers itself; tests may register fakes. */
export function registerProvider(adapter: ProviderAdapter): void {
  adapters.set(adapter.id, adapter);
}

export function providerFor(id: string): ProviderAdapter {
  const adapter = adapters.get(id) ?? (/^gateway-[a-z0-9-]+$/.test(id) ? adapters.get('gateway') : undefined);
  if (!adapter) throw new ProviderError('ai.providerUnavailable');
  return adapter;
}

export function providers(): ProviderAdapter[] {
  return [...adapters.values()];
}
