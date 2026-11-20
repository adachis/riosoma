import {
  aiDestination,
  AppError,
  GatewayHeaderName,
  type AiSettings,
  type GatewayConfig,
} from '@riosoma/contracts';
import { isGateway, REGISTRY, type RegistryModel } from '@riosoma/ai';
import { z } from 'zod';

export const GatewaySecret = z.object({
  key: z.string().max(10_000).optional(),
  headers: z
    .record(
      GatewayHeaderName,
      z
        .string()
        .max(10_000)
        .regex(/^[^\r\n]*$/),
    )
    .default({}),
});

export function readGatewaySecret(value?: string): z.infer<typeof GatewaySecret> {
  if (!value) return { headers: {} };
  try {
    return GatewaySecret.parse(JSON.parse(value));
  } catch {
    return { key: value, headers: {} };
  }
}

/**
 * Whether a gateway still points where its stored key and header values were saved for.  Stored
 * secrets never follow a gateway somewhere new: otherwise anyone who could change the address
 * could collect them without ever seeing them.  The whole address counts, since gateways that
 * share a host tell their accounts apart by path.
 */
export function sameDestination(stored: GatewayConfig | undefined, next: GatewayConfig): boolean {
  return Boolean(stored) && aiDestination(stored!.baseUrl) === aiDestination(next.baseUrl);
}

/**
 * The address the settings give a gateway or a provider, or undefined for a provider's own.  A
 * gateway's address is part of the gateway, and a provider's is the one chosen for it.
 */
export function configuredAddress(settings: AiSettings, providerId: string): string | undefined {
  return isGateway(providerId)
    ? settings.gateways?.find((entry) => entry.providerId === providerId)?.baseUrl
    : settings.providers.find((entry) => entry.providerId === providerId)?.baseUrl;
}

export function registeredModel(
  settings: AiSettings,
  providerId: string,
  model: string,
): RegistryModel | undefined {
  const entry = settings.gateways
    ?.find((gateway) => gateway.providerId === providerId)
    ?.models.find((entry) => entry.model === model);
  if (!entry) return REGISTRY.find((entry) => entry.providerId === providerId && entry.model === model);
  const mapped = entry.mapping
    ? REGISTRY.find(
        (known) => known.providerId === entry.mapping!.providerId && known.model === entry.mapping!.model,
      )
    : undefined;
  return {
    ...mapped,
    providerId,
    model,
    name: model,
    tiers:
      mapped && !mapped.tiers.some((tier) => tier === 'everyday' || tier === 'power')
        ? []
        : ['everyday', 'power'],
    price: mapped?.price ?? null,
    contextTokens: entry.contextTokens,
    tools: mapped?.tools ?? true,
  };
}

export function validateGateway(gateway: GatewayConfig) {
  const names = gateway.headerNames.map((name) => name.toLowerCase());
  if (
    new Set(names).size !== names.length ||
    names.some(
      (name) =>
        [
          'authorization',
          'host',
          'content-length',
          'content-type',
          'connection',
          'transfer-encoding',
        ].includes(name) ||
        (gateway.auth.mode === 'header' && name === gateway.auth.header.toLowerCase()),
    )
  )
    throw new AppError('validation_failed', 'ai.gateway.invalid');
  const models = gateway.models.map((model) => model.model);
  if (
    new Set(models).size !== models.length ||
    gateway.models.some(
      (model) =>
        model.mapping &&
        !REGISTRY.some(
          (known) => known.providerId === model.mapping!.providerId && known.model === model.mapping!.model,
        ),
    )
  )
    throw new AppError('validation_failed', 'ai.gateway.invalid');
}
