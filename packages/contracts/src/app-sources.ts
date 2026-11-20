import { z } from 'zod';
import { APP_CATALOG_ENTRIES } from './app-catalog.generated.js';

export type AppSecretName = 'token' | 'apiKey' | 'password' | 'clientSecret' | 'refreshToken';

/** Public form metadata and the rules for each non-secret setting. */
export type AppSetting = {
  key: string;
  required: boolean;
  labelMessageId: string;
  helpMessageId: string;
  requiredMessageId?: string;
  invalidMessageId?: string;
} & (
  | { type: 'text'; maxLength: number; pattern?: string }
  | { type: 'choice'; values: readonly string[]; valueMessageIds?: Readonly<Record<string, string>> }
  | { type: 'account-choice' }
  | {
      type: 'address';
      domain: string;
      allowBareName?: boolean;
      subdomainRequired?: boolean;
      addressMessageIds?: Partial<Record<AppAddressProblem, string>>;
    }
);

export type AppCatalogEntry = {
  id: string;
  /** Company names retain the company's spelling and are never translated. */
  name: string;
  settings: readonly AppSetting[];
} & (
  | {
      secret: { name: AppSecretName; helpMessageId: string; deniedMessageId: string };
      connect?: never;
      /** Further sealed values appear after the main key, in this order. */
      additionalSecrets?: readonly {
        name: AppSecretName;
        labelMessageId: string;
        helpMessageId: string;
      }[];
      keyUrl: string;
    }
  | {
      connect: { provider: string };
      secret?: never;
      additionalSecrets?: never;
      keyUrl?: never;
    }
);

export function appDeniedMessage(entry: AppCatalogEntry): string {
  return entry.secret?.deniedMessageId ?? 'sources.app.connectionRefused';
}

const catalog: AppCatalogEntry[] = [...APP_CATALOG_ENTRIES];
export const APP_CATALOG: readonly AppCatalogEntry[] = catalog;

/** Indexed presets register their metadata before the server validates source requests. */
export function registerAppCatalog(entries: readonly AppCatalogEntry[]): void {
  for (const entry of entries) {
    const index = catalog.findIndex((app) => app.id === entry.id);
    if (index === -1) catalog.push(entry);
    else catalog[index] = entry;
  }
}

export type AppAddressProblem =
  'invalid' | 'https' | 'host' | 'credentials' | 'port' | 'path' | 'query' | 'fragment';

/** Check the original address too, since URL parsing erases default ports and normalizes paths. */
export function appAddressProblem(
  address: string,
  domain: string,
  subdomainRequired = false,
): AppAddressProblem | null {
  try {
    const url = new URL(address);
    if (
      /\s/.test(address) ||
      address.includes('\\') ||
      Array.from(address).some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)
    )
      return 'invalid';
    if (url.protocol !== 'https:') return 'https';
    const authority = /^[a-z]+:\/\/([^/?#]*)/i.exec(address)?.[1];
    if (!authority) return 'invalid';
    if (authority.includes('@')) return 'credentials';
    if (authority.includes(':')) return 'port';
    if (
      !(url.hostname.endsWith(`.${domain}`) || (!subdomainRequired && url.hostname === domain)) ||
      !url.hostname.split('.').every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(label))
    )
      return 'host';
    if (address.includes('?')) return 'query';
    if (address.includes('#')) return 'fragment';
    const tail = address.slice(address.indexOf(authority) + authority.length);
    if (tail !== '' && tail !== '/') return 'path';
    return null;
  } catch {
    return 'invalid';
  }
}

/** A customer's address must stay on the app's domain and carry no credentials or parameters. */
export function isAppAddress(address: string, domain: string): boolean {
  return appAddressProblem(address, domain) === null;
}

/** The connector can use the same validation with an isolated test catalog. */
export function appConnectionSchema(catalog: readonly AppCatalogEntry[]) {
  return z
    .object({
      kind: z.literal('app'),
      app: z.string(),
      settings: z.record(z.string(), z.unknown()).default({}),
    })
    .strict()
    .superRefine((connection, ctx) => {
      const entry = catalog.find((app) => app.id === connection.app);
      if (!entry) {
        ctx.addIssue({ code: 'custom', path: ['app'], message: 'sources.app.unknown' });
        return;
      }
      for (const key of Object.keys(connection.settings))
        if (
          !entry.settings.some((setting) => setting.key === key) &&
          !(entry.connect && ['connectionId', 'connectedBy'].includes(key))
        )
          ctx.addIssue({
            code: 'custom',
            path: ['settings', key],
            message: 'sources.app.undeclaredSetting',
          });
      if (entry.connect) {
        for (const key of ['connectionId', 'connectedBy']) {
          const value = connection.settings[key];
          if (
            (key === 'connectionId' || value !== undefined) &&
            (typeof value !== 'string' ||
              !value.trim() ||
              value.length > 255 ||
              Array.from(value).some(
                (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
              ))
          )
            ctx.addIssue({
              code: 'custom',
              path: ['settings', key],
              message: 'sources.app.connectionRequired',
            });
        }
      }
      for (const setting of entry.settings) {
        const value = connection.settings[setting.key];
        if (value === undefined || value === '') {
          if (setting.required)
            ctx.addIssue({
              code: 'custom',
              path: ['settings', setting.key],
              message: setting.requiredMessageId ?? 'sources.app.settingRequired',
            });
          continue;
        }
        if (setting.type === 'address' && typeof value === 'string') {
          // A bare name gains the app's domain, and a host pasted without its scheme gains https, so
          // `example`, `example.myshopify.com`, and `https://example.myshopify.com` all mean the same.
          const host = value.trim().replace(/\/$/, '').toLowerCase();
          const address =
            setting.allowBareName && /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(value)
              ? `https://${value.toLowerCase()}.${setting.domain}`
              : /^[a-z0-9.-]+$/.test(host) && host.endsWith(`.${setting.domain}`)
                ? `https://${host}`
                : value;
          connection.settings[setting.key] = address;
          const problem =
            address.length > 2_000
              ? 'invalid'
              : appAddressProblem(address, setting.domain, setting.subdomainRequired);
          if (problem)
            ctx.addIssue({
              code: 'custom',
              path: ['settings', setting.key],
              message:
                setting.addressMessageIds?.[problem] ?? setting.invalidMessageId ?? 'sources.app.address',
            });
          continue;
        }
        const valid =
          typeof value === 'string' &&
          (setting.type === 'choice'
            ? setting.values.includes(value)
            : setting.type === 'account-choice'
              ? value.length <= 255 &&
                !Array.from(value).some(
                  (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
                )
              : setting.type === 'address'
                ? false
                : value.length <= setting.maxLength &&
                  !Array.from(value).some(
                    (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
                  ) &&
                  (!setting.pattern || new RegExp(setting.pattern).test(value)));
        if (!valid)
          ctx.addIssue({
            code: 'custom',
            path: ['settings', setting.key],
            message:
              setting.invalidMessageId ??
              (setting.type === 'address' ? 'sources.app.address' : 'sources.app.settingInvalid'),
          });
      }
    });
}

export const AppConnection = appConnectionSchema(APP_CATALOG);
export type AppConnection = z.infer<typeof AppConnection>;
