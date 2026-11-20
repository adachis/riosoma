import {
  appConnectionSchema,
  appDeniedMessage,
  GraphQlConnection,
  isAppAddress,
  LIMITS,
  RestConnection,
  RestEndpoint,
  RestAuth,
  type AppCatalogEntry,
  type SourceObject,
  type SourceSelect,
  type SourceTestResult,
} from '@riosoma/contracts';
import { createGraphQlConnector } from '../api/graphql.js';
import {
  createRestConnector,
  endpointUrl,
  isRestConnector,
  type RestConnectorContext,
  type RestConnectorOptions,
} from '../rest/connector.js';
import { isRecordObject, parseJson, valueAt } from '../rest/records.js';
import { ConnectorError, type Connector, type ConnectorContext } from '../types.js';
import { APP_PRESETS } from './index.js';
import { mergePropertyPages, propertyNames, propertyRequests } from './properties.js';
import { checkResponse, recordProjection } from './records.js';
import type { AppDiscovery, AppObject, AppPreset } from './types.js';
import { fieldLabels, projectValues } from './values.js';
import { errorDiagnostic } from '../rest/errors.js';
import { fieldEndpoints } from './field-selection.js';

const MESSAGE_KEYS: Record<string, string> = {
  'sources.rest.https': 'sources.app.https',
  'sources.rest.blocked': 'sources.app.blocked',
  'sources.rest.tls': 'sources.app.tls',
  'sources.rest.connect': 'sources.app.connect',
  'sources.rest.resolve': 'sources.app.resolve',
  'sources.rest.notFound': 'sources.app.objectMissing',
  'sources.rest.status': 'sources.app.status',
  'sources.rest.rateLimited': 'sources.app.rateLimited',
  'sources.rest.notJson': 'sources.app.notJson',
  'sources.rest.records': 'sources.app.records',
  'sources.rest.pageLimit': 'sources.app.pageLimit',
  'sources.rest.recordLimit': 'sources.app.recordLimit',
  'sources.rest.pagingLoop': 'sources.app.pagingLoop',
  'sources.rest.nextElsewhere': 'sources.app.nextElsewhere',
  'sources.rest.tooLarge': 'sources.app.tooLarge',
  'sources.rest.noQueries': 'sources.app.noQueries',
  'sources.sync.objectMissing': 'sources.app.objectMissing',
  'sources.secretsMissing': 'sources.app.secretMissing',
  'sources.test.timeout': 'sources.app.timeout',
  'sources.test.resolve': 'sources.app.resolve',
  'sources.test.connect': 'sources.app.connect',
  'sources.test.tls': 'sources.app.tls',
  'sources.test.authenticate': 'sources.app.authenticate',
  'sources.test.read': 'sources.app.read',
  'sources.test.records': 'sources.app.records',
  'sources.test.paging': 'sources.app.pagingLoop',
  'sources.graphql.queryOnly': 'sources.app.queryOnly',
  'sources.graphql.errors': 'sources.app.graphqlErrors',
  'sources.graphql.pageInfo': 'sources.app.pageInfo',
};

const DENIED = new Set([
  'sources.rest.deniedToken',
  'sources.rest.deniedKey',
  'sources.rest.deniedPassword',
  'sources.rest.deniedOauth',
  'sources.rest.oauthDenied',
  'sources.rest.oauthFailed',
]);

/** Discovery and permission probes share the same total bound as an API read, at the preset's pace. */
export const APP_INSPECTION_TIMEOUT_MS = 20 * 60_000;

function messageKey(key: string, entry?: AppCatalogEntry): string {
  if (/^sources\.app\./.test(key)) return key;
  if (DENIED.has(key) && entry) return appDeniedMessage(entry);
  return MESSAGE_KEYS[key] ?? 'sources.app.read';
}

/** App failures keep message parameters and discard all external words. */
function failure(
  error: unknown,
  entry?: AppCatalogEntry,
  diagnostic?: RestConnectorOptions['onUnexpectedError'],
): ConnectorError {
  const key =
    error instanceof ConnectorError
      ? error.messageKey === 'sources.sync.read' && error.params?.reason === 'timeout'
        ? 'sources.app.timeout'
        : messageKey(error.messageKey, entry)
      : 'sources.app.read';
  if (key === 'sources.app.read') diagnostic?.(errorDiagnostic(error));
  if (!(error instanceof ConnectorError)) return new ConnectorError(key);
  const showKeyPage = entry?.secret && (key === appDeniedMessage(entry) || key === 'sources.app.keyInvalid');
  return new ConnectorError(
    key,
    undefined,
    showKeyPage ? { ...error.params, keyUrl: entry.keyUrl } : error.params,
  );
}

function isPermissionRefusal(key: string | undefined, preset: AppPreset): boolean {
  return (
    key === 'sources.app.objectNotAllowed' ||
    key === 'sources.app.objectFault' ||
    (preset.permissionDenied?.messageId !== undefined && key === preset.permissionDenied.messageId)
  );
}

function documentOf(body: Buffer): unknown {
  try {
    return parseJson(body.toString('utf8'));
  } catch {
    throw new ConnectorError('sources.app.notJson');
  }
}

function pathFor(template: string, object: string): string {
  return template.replace('{object}', encodeURIComponent(object));
}

/** All transport, authentication, paging, retry, sampling, and conversion rules belong to the API connectors. */
export function createAppConnector(
  options: RestConnectorOptions = {},
  presets: readonly AppPreset[] = APP_PRESETS,
): Connector {
  const schema = appConnectionSchema(presets.map((preset) => preset.catalog));
  const deadlineMs = options.deadlineMs ?? APP_INSPECTION_TIMEOUT_MS;

  function operationContext(ctx: ConnectorContext): RestConnectorContext {
    return { ...ctx, deadlineAt: Date.now() + deadlineMs };
  }

  function inspectionContext(ctx: ConnectorContext): RestConnectorContext {
    return {
      ...operationContext(ctx),
      signal: AbortSignal.any([...(ctx.signal ? [ctx.signal] : []), AbortSignal.timeout(deadlineMs)]),
    };
  }

  function apiOptions(
    preset: AppPreset,
    object?: AppObject,
    testing = false,
    settings: Record<string, unknown> = {},
    values: Record<string, string> = {},
  ): RestConnectorOptions {
    const identity = testing && object && 'endpoint' in object && object.endpoint.records === '';
    return {
      ...options,
      headers: Object.fromEntries(
        Object.entries(preset.target.headers ?? {}).map(([name, template]) => {
          const value = fillValues(template, settings, values);
          if (
            Array.from(value).some(
              (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
            )
          )
            throw new ConnectorError('sources.app.settingInvalid');
          return [name, value];
        }),
      ),
      responseError(responseContext, status, body, hiddenCredentials, canRenewToken, headers) {
        let document: unknown;
        try {
          document = parseJson(body.toString('utf8'));
        } catch {
          // Only declared JSON fields can supply permission names.
        }
        const rateLimit = preset.rateLimited;
        const rateMessage = rateLimit ? valueAt(document, rateLimit.message.path) : undefined;
        if (
          rateLimit &&
          (status === 429 ||
            (status === 403 &&
              (headers[rateLimit.remainingHeader] === '0' ||
                headers['retry-after'] !== undefined ||
                (typeof rateMessage === 'string' && rateLimit.message.pattern.test(rateMessage)))))
        )
          // A 403 without Retry-After can last until the hourly reset.  Other throttles share bounded retries.
          return new ConnectorError(
            status === 429 || headers['retry-after'] !== undefined
              ? 'sources.rest.rateLimited'
              : 'sources.app.rateLimited',
            undefined,
            { status },
          );
        const responseCode = preset.response ? valueAt(document, preset.response.code) : undefined;
        const fault = preset.fault;
        const errors = fault ? valueAt(document, fault.errors) : undefined;
        if (fault && Array.isArray(errors) && errors.length) {
          if (
            status === 401 ||
            fault.reconnect.values.includes(String(valueAt(document, fault.reconnect.path)))
          )
            return new ConnectorError(appDeniedMessage(preset.catalog));
          const reason = errors
            .map((error) => valueAt(error, fault.message))
            .filter((value) => typeof value === 'string')
            .join('  ');
          const safeReason = [...hiddenCredentials]
            .reduce((text, secret) => (secret ? text.split(secret).join('[redacted]') : text), reason)
            .slice(0, 300);
          return new ConnectorError('sources.app.objectFault', undefined, {
            object: object?.name ?? '',
            ...(object?.labelMessageId ? { objectMessageId: object.labelMessageId } : {}),
            reason: safeReason,
            code: errors
              .map((error) => valueAt(error, fault.code))
              .filter((code) => typeof code === 'string' && /^[0-9]{1,10}$/.test(code))
              .join(', '),
          });
        }
        const envelopeStatus =
          typeof responseCode === 'number' && preset.response?.denied.includes(responseCode)
            ? responseCode
            : undefined;
        const denied = preset.permissionDenied;
        const code = denied?.code ? valueAt(document, denied.code.path) : undefined;
        const declaredPermission = denied?.code?.values.includes(String(code)) === true;
        const recognizedPermission = typeof code === 'string' && declaredPermission;
        const unavailable = preset.objectUnavailable;
        const unavailableCode = unavailable ? valueAt(document, unavailable.path) : undefined;
        const objectUnavailable =
          typeof unavailableCode === 'string' &&
          (unavailable?.values?.includes(unavailableCode) === true ||
            unavailable?.statuses?.includes(status) === true);
        const missingPermission =
          status === 403 || envelopeStatus === 403 || declaredPermission || objectUnavailable;
        if (canRenewToken && !missingPermission) return undefined;
        if (
          (status === 401 && !(declaredPermission && denied?.reportTest)) ||
          envelopeStatus === 401 ||
          (testing &&
            missingPermission &&
            !denied?.reportTest &&
            !recognizedPermission &&
            !object?.permission) ||
          (!object && missingPermission)
        )
          return new ConnectorError(appDeniedMessage(preset.catalog), undefined, {
            status: envelopeStatus ?? status,
          });
        if (missingPermission && object) {
          const field = denied?.names ? valueAt(document, denied.names.path) : undefined;
          const captured =
            denied?.names?.pattern && typeof field === 'string'
              ? new RegExp(denied.names.pattern.source, denied.names.pattern.flags).exec(field)?.[1]
              : denied?.names?.pattern
                ? undefined
                : field;
          const path =
            responseContext.connection.kind === 'rest'
              ? responseContext.connection.endpoints[0]?.path
              : undefined;
          const fallbackPermission =
            Object.entries(denied?.permissions ?? {}).find(([prefix]) => path?.startsWith(prefix))?.[1] ??
            denied?.permission;
          const candidates = Array.isArray(captured)
            ? captured
            : typeof captured === 'string'
              ? captured.split(denied?.names?.separator ?? ',')
              : fallbackPermission && declaredPermission
                ? [fallbackPermission]
                : [];
          const hidden = [...hiddenCredentials];
          const names = candidates
            .filter((name): name is string => typeof name === 'string')
            .map((name) => name.trim())
            .filter(
              (name) =>
                /^[A-Za-z][A-Za-z0-9_.:-]{0,127}$/.test(name) &&
                !hidden.some((secret) => name.includes(secret)),
            );
          const permission = [
            ...new Set(names.length ? names : object.permission ? [object.permission] : []),
          ].join(', ');
          return new ConnectorError(denied?.messageId ?? 'sources.app.objectNotAllowed', undefined, {
            object: object.name,
            ...(object.labelMessageId
              ? { objectMessageId: object.labelMessageId, parent: object.labelParams?.parent ?? '' }
              : {}),
            permission,
            hasPermission: permission.length > 0,
          });
        }
        // GraphQL classifies its error envelope after this app's permission rules run.
        if (
          (object && 'graphql' in object) ||
          (status >= 200 && status < 300) ||
          status === 429 ||
          status === 500 ||
          status === 502 ||
          status === 503
        )
          return undefined;
        if (status === 404 || status === 410) return new ConnectorError('sources.app.objectMissing');
        return new ConnectorError('sources.app.status', undefined, { status });
      },
      ...(preset.target.requestLimit ? { requestLimit: preset.target.requestLimit } : {}),
      ...(preset.target.rateLimitKey
        ? { rateLimitKey: fillValues(preset.target.rateLimitKey, settings, values) }
        : {}),
      ...(preset.target.maxConcurrent ? { maxConcurrent: preset.target.maxConcurrent } : {}),
      ...(preset.lastPage ? { lastPage: preset.lastPage } : {}),
      ...(preset.response || identity || object?.singleRecord || object?.emptyRecords
        ? {
            document: async (ctx, url, document, request) => {
              checkResponse(document, preset.response);
              const projected = options.document
                ? await options.document(ctx, url, document, request)
                : document;
              if (object?.emptyRecords && 'endpoint' in object) {
                const parts = object.endpoint.records.split('.');
                const member = parts.pop()!;
                const parent = valueAt(projected, parts.join('.'));
                if (isRecordObject(parent) && !Object.hasOwn(parent, member)) parent[member] = [];
              }
              // Credential endpoints can return one identity instead of a list of readable objects.
              return object?.singleRecord || (identity && isRecordObject(projected))
                ? [projected]
                : projected;
            },
          }
        : {}),
    };
  }

  function recordOptions(object: AppObject): Pick<RestConnectorOptions, 'record' | 'keyColumns'> {
    return {
      keyColumns: [object.key],
      ...(object.fields || object.keep || object.omit || object.dateEncoding
        ? {
            record(record: unknown) {
              if (!isRecordObject(record)) throw new ConnectorError('sources.app.records');
              const projected = object.keep
                ? Object.fromEntries(
                    object.keep
                      .filter((name) => Object.hasOwn(record, name))
                      .map((name) => [name, record[name]]),
                  )
                : { ...record };
              for (const [name, field] of Object.entries(object.fields ?? {})) {
                if (typeof field === 'string') projected[name] = valueAt(record, field) ?? null;
                else if ('exists' in field) projected[name] = valueAt(record, field.exists) != null;
                else {
                  const items = valueAt(record, field.path);
                  if (!Array.isArray(items)) throw new ConnectorError('sources.app.records');
                  const values = items.map((item) => valueAt(item, field.item));
                  if (values.some((value) => typeof value !== 'string'))
                    throw new ConnectorError('sources.app.records');
                  projected[name] = values.join(field.separator);
                }
              }
              const omit = (value: unknown): unknown => {
                if (Array.isArray(value)) return value.map(omit);
                if (!isRecordObject(value)) return value;
                return Object.fromEntries(
                  Object.entries(value)
                    .filter(([name]) => !object.omit?.includes(name))
                    .map(([name, inner]) => [name, omit(inner)]),
                );
              };
              const dates = (value: unknown): unknown => {
                if (typeof value === 'string') {
                  const match = /^\/Date\((-?\d+)(?:[+-]\d{4})?\)\/$/.exec(value);
                  const date = match ? new Date(Number(match[1])) : null;
                  return date && Number.isFinite(date.getTime()) ? date.toISOString() : value;
                }
                if (Array.isArray(value)) return value.map(dates);
                return isRecordObject(value)
                  ? Object.fromEntries(Object.entries(value).map(([key, inner]) => [key, dates(inner)]))
                  : value;
              };
              const result = object.omit ? omit(projected) : projected;
              return object.dateEncoding === 'dotnet' ? dates(result) : result;
            },
          }
        : {}),
    };
  }

  function resolve(ctx: ConnectorContext) {
    const parsed = schema.safeParse(ctx.connection);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      throw new ConnectorError(
        issue?.code === 'custom'
          ? issue.message
          : issue?.code === 'unrecognized_keys' && issue.keys.includes('baseUrl')
            ? 'sources.app.address'
            : 'sources.app.settingInvalid',
      );
    }
    const preset = presets.find((entry) => entry.catalog.id === parsed.data.app)!;
    const settings = parsed.data.settings;
    // Validated address settings use their origin so appended paths have one separator.
    for (const setting of preset.catalog.settings) {
      const value = settings[setting.key];
      if (setting.type === 'address' && typeof value === 'string' && value)
        settings[setting.key] = new URL(value).origin;
    }
    for (const secret of preset.catalog.secret
      ? [preset.catalog.secret, ...(preset.catalog.additionalSecrets ?? [])]
      : [{ name: 'token' as const }])
      if (!ctx.secrets[secret.name])
        throw new ConnectorError(
          'sources.app.secretMissing',
          undefined,
          'labelMessageId' in secret ? { fieldMessageId: secret.labelMessageId } : undefined,
        );

    const target = preset.target.address;
    let address: unknown;
    if (typeof target === 'string') address = target;
    else if ('secret' in target) {
      const secret = ctx.secrets[target.secret];
      const separator = secret?.lastIndexOf(target.separator) ?? -1;
      const suffix = separator >= 0 ? secret!.slice(separator + target.separator.length) : '';
      if (!target.separator || !/^[A-Za-z0-9]{1,63}$/.test(suffix))
        throw new ConnectorError('sources.app.keyInvalid');
      address = `https://${suffix.toLowerCase()}.${target.domain}`;
    } else {
      const choice = settings[target.setting];
      address =
        'choices' in target
          ? target.choices[typeof choice === 'string' && choice ? choice : target.default]
          : choice;
    }
    if (
      typeof address !== 'string' ||
      (typeof target !== 'string' && 'domain' in target && !isAppAddress(address, target.domain))
    )
      throw new ConnectorError('sources.app.address');
    // Only the shared OAuth exchange may send a body outside a declared GraphQL query.
    if (options.queryBody) throw new ConnectorError('sources.app.queryOnly');
    return { preset, address, settings };
  }

  /** Declared settings fill values without becoming request instructions. */
  function fillSetting(template: string, settings: Record<string, unknown>, path = false): string {
    return template.replace(/\{setting:([A-Za-z0-9_]+)\}/g, (_placeholder, key: string) => {
      const value = settings[key];
      if (typeof value !== 'string' || !value) throw new ConnectorError('sources.app.settingRequired');
      return path ? encodeURIComponent(value) : value;
    });
  }

  /** Only validated settings fill sign-in values, and dynamic token hosts stay on the API's origin. */
  function authFor(preset: AppPreset, settings: Record<string, unknown>, address: string): RestAuth {
    const auth = preset.target.auth;
    if (auth.method === 'basic') return RestAuth.parse({ ...auth, user: fillSetting(auth.user, settings) });
    if (auth.method !== 'oauth-client') return RestAuth.parse(auth);
    const target = auth.tokenUrl;
    const choice = typeof target === 'string' ? undefined : settings[target.setting];
    const template =
      typeof target === 'string'
        ? target
        : target.choices[typeof choice === 'string' && choice ? choice : target.default];
    if (!template) throw new ConnectorError('sources.app.address');
    const tokenUrl = fillSetting(template, settings);
    try {
      if (template.includes('{setting:') && new URL(tokenUrl).origin !== new URL(address).origin)
        throw new Error();
    } catch {
      throw new ConnectorError('sources.app.address');
    }
    const parsed = RestAuth.safeParse({
      ...auth,
      tokenUrl,
      clientId: fillSetting(auth.clientId, settings),
      ...(auth.scope ? { scope: fillSetting(auth.scope, settings) } : {}),
      ...(auth.tokenParams
        ? {
            tokenParams: Object.fromEntries(
              Object.entries(auth.tokenParams).map(([key, value]) => [key, fillSetting(value, settings)]),
            ),
          }
        : {}),
    });
    if (!parsed.success) throw new ConnectorError('sources.app.settingInvalid');
    return parsed.data;
  }

  /** Settings and account values fill declared request values without becoming request instructions. */
  function fillValues(
    template: string,
    settings: Record<string, unknown>,
    values: Record<string, string>,
    path = false,
  ): string {
    return template.replace(
      /\{(setting|value):([A-Za-z0-9_]+)\}/g,
      (_placeholder, kind: string, key: string) => {
        const value = kind === 'setting' ? settings[key] : values[key];
        if (typeof value !== 'string' || !value)
          throw new ConnectorError(
            kind === 'setting' ? 'sources.app.settingRequired' : 'sources.app.accountValues',
          );
        return path ? encodeURIComponent(value) : value;
      },
    );
  }

  function endpointWithValues(
    endpoint: RestEndpoint,
    settings: Record<string, unknown>,
    values: Record<string, string> = {},
  ): RestEndpoint {
    const fill = (template: string, path: boolean) => fillValues(template, settings, values, path);
    return RestEndpoint.parse({
      ...endpoint,
      path: fill(endpoint.path, true),
      query: endpoint.query.map((param) => ({ ...param, value: fill(param.value, false) })),
    });
  }

  function restContext(
    ctx: RestConnectorContext,
    address: string,
    preset: AppPreset,
    endpoint: RestEndpoint,
    settings: Record<string, unknown>,
  ): RestConnectorContext {
    return {
      ...ctx,
      secrets: authSecrets(ctx, preset),
      connection: RestConnection.parse({
        kind: 'rest',
        baseUrl: address,
        auth: authFor(preset, settings, address),
        requestsPerSecond: preset.target.requestsPerSecond,
        endpoints: [endpoint],
      }),
    };
  }

  /** Presets name their key for the form, while each API auth method has a fixed secret slot. */
  function authSecrets(ctx: ConnectorContext, preset: AppPreset): ConnectorContext['secrets'] {
    const method = preset.target.auth.method;
    const slot =
      method === 'bearer'
        ? 'token'
        : method === 'basic'
          ? 'password'
          : method === 'header' || method === 'query'
            ? 'apiKey'
            : undefined;
    return slot && preset.catalog.secret
      ? { ...ctx.secrets, [slot]: ctx.secrets[preset.catalog.secret.name] }
      : ctx.secrets;
  }

  /** Resolve account values anew so a changed organization or key never reuses another call's values. */
  async function prepare(ctx: RestConnectorContext) {
    const resolved = resolve(ctx);
    const { preset, address, settings } = resolved;
    const values: Record<string, string> = { ...ctx.accountValues };
    if (preset.bootstrap) {
      const endpoint = endpointWithValues(preset.bootstrap.endpoint, settings, values);
      const context = restContext(ctx, address, preset, endpoint, settings);
      const document = documentOf(
        await createRestConnector(apiOptions(preset, undefined, false, settings, values)).request(
          context,
          endpointUrl(address, endpoint),
        ),
      );
      for (const [name, path] of Object.entries(preset.bootstrap.values)) {
        const value = valueAt(document, path);
        if (
          typeof value !== 'string' ||
          !value.trim() ||
          value.length > LIMITS.urlLength ||
          Array.from(value).some(
            (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
          )
        )
          throw new ConnectorError('sources.app.accountValues');
        values[name] = value;
      }
    }
    return { ...resolved, values };
  }

  async function objects(
    ctx: RestConnectorContext,
    preset: AppPreset,
    address: string,
    settings: Record<string, unknown>,
    values: Record<string, string>,
  ): Promise<{ result: AppObject[]; skipped: SourceTestResult['steps'] }> {
    const result = [...preset.objects];
    const skipped: SourceTestResult['steps'] = [];
    const roots = [...(preset.discovery ? [preset.discovery] : []), ...(preset.discoveries ?? [])];
    async function discover(
      discovery: AppDiscovery,
      ancestors: Record<string, string> = {},
      names: string[] = [],
      labels: string[] = [],
    ): Promise<void> {
      const pathWithIds = (path: string, ids: Record<string, string>, current?: string) =>
        path.replace(/\{discovery:([A-Za-z0-9_]+)\}|\{object\}/g, (_match, name: string | undefined) => {
          const id = name ? ids[name] : current;
          if (id === undefined) throw new ConnectorError('sources.app.discovery');
          return encodeURIComponent(id);
        });
      const endpoint = endpointWithValues(
        {
          ...discovery.endpoint,
          path: pathWithIds(discovery.endpoint.path, ancestors, ancestors.object),
        },
        settings,
        values,
      );
      const context = restContext(ctx, address, preset, endpoint, settings);
      let found: unknown;
      try {
        const discoveryObject: AppObject = {
          name: endpoint.name,
          key: discovery.id,
          endpoint,
          permission: discovery.permission,
        };
        const api = createRestConnector(
          apiOptions(
            preset,
            discovery.reportDenied || discovery.permission ? discoveryObject : undefined,
            false,
            settings,
            values,
          ),
        );
        if (discovery.paged) {
          const rows: unknown[] = [];
          for await (const page of api.records(context, {
            kind: 'object',
            object: { schema: null, name: endpoint.name },
          }))
            rows.push(...page);
          found = rows;
        } else {
          const document = documentOf(await api.request(context, endpointUrl(address, endpoint)));
          found = valueAt(checkResponse(document, preset.response), endpoint.records);
        }
      } catch (error) {
        if (
          discovery.optional &&
          error instanceof ConnectorError &&
          (isPermissionRefusal(error.messageKey, preset) ||
            (error.messageKey === appDeniedMessage(preset.catalog) &&
              typeof error.params?.status === 'number' &&
              error.params.status !== 401))
        ) {
          if (
            (discovery.reportDenied || discovery.permission) &&
            isPermissionRefusal(error.messageKey, preset)
          )
            skipped.push({
              step: 'rows',
              status: 'skipped',
              ms: 0,
              messageKey: error.messageKey,
              params: error.params as SourceTestResult['steps'][number]['params'],
            });
          return;
        }
        throw error;
      }
      if (!Array.isArray(found)) throw new ConnectorError('sources.app.discovery');
      const seen = new Set<string>();
      for (const record of found) {
        if (
          discovery.include &&
          !discovery.include.some((group) =>
            Object.entries(group).every(([path, expected]) => {
              const actual = valueAt(record, path);
              return Array.isArray(expected)
                ? typeof actual === 'string' && expected.includes(actual)
                : actual === expected;
            }),
          )
        )
          continue;
        const rawId = valueAt(record, discovery.id);
        const id = typeof rawId === 'number' && Number.isSafeInteger(rawId) ? String(rawId) : rawId;
        if (
          !isRecordObject(record) ||
          typeof id !== 'string' ||
          !id ||
          id.length > 255 ||
          Array.from(id).some(
            (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
          ) ||
          id === '.' ||
          id === '..'
        )
          throw new ConnectorError('sources.app.discovery');
        if (seen.has(id)) continue;
        seen.add(id);
        const ids = { ...ancestors, [discovery.parameter ?? 'object']: id, object: id };
        for (const [name, path] of Object.entries(discovery.parameters ?? {})) {
          const value = valueAt(record, path);
          if (
            typeof value !== 'string' ||
            !value ||
            value.length > 255 ||
            value === '.' ||
            value === '..' ||
            Array.from(value).some(
              (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
            )
          )
            throw new ConnectorError('sources.app.discovery');
          ids[name] = value;
        }
        const lineage = [...names, encodeURIComponent(id)];
        const label = discovery.labelFields
          ? discovery.labelFields
              .map((path) => valueAt(record, path))
              .filter((value) => typeof value === 'string' && value)
              .join(' ') || id
          : discovery.label
            ? valueAt(record, discovery.label)
            : undefined;
        const labelLineage = [...labels, typeof label === 'string' ? label : id];
        for (const definition of [
          ...(discovery.object ? [discovery.object] : []),
          ...(discovery.objects ?? []),
        ]) {
          const base = [...lineage, ...(definition.name ? [encodeURIComponent(definition.name)] : [])].join(
            '/',
          );
          let name = base;
          for (let suffix = 2; result.some((object) => object.name === name); suffix++)
            name = `${base}/${suffix}`;
          if (name.length > 255) throw new ConnectorError('sources.app.discovery');
          result.push({
            name,
            key: definition.key,
            fields: definition.fields,
            keep: definition.keep,
            omit: definition.omit,
            ...(definition.labelMessageId
              ? {
                  labelMessageId: definition.labelMessageId,
                  labelParams: { parent: labelLineage.join(' / ') },
                }
              : {}),
            permission: definition.permission,
            ...(definition.projection
              ? {
                  projection: {
                    ...definition.projection,
                    definitions: {
                      ...definition.projection.definitions,
                      path: pathWithIds(definition.projection.definitions.path, ids, id),
                    },
                  },
                }
              : {}),
            ...(label !== undefined || labels.length
              ? {
                  label: [...labelLineage, ...(definition.name ? [definition.name] : [])].join(
                    discovery.labelSeparator ?? ' / ',
                  ),
                }
              : {}),
            endpoint: RestEndpoint.parse({
              ...definition.endpoint,
              name,
              path: pathWithIds(definition.path, ids, id),
            }),
          });
        }
        for (const child of discovery.discoveries ?? []) await discover(child, ids, lineage, labelLineage);
      }
    }
    for (const discovery of roots) await discover(discovery);
    return { result, skipped };
  }

  async function setup(
    ctx: RestConnectorContext,
    select: SourceSelect,
    testing = false,
    selected?: AppObject,
    prepared?: Awaited<ReturnType<typeof prepare>>,
  ) {
    const { preset, address, settings, values } = prepared ?? (await prepare(ctx));
    if (select.kind !== 'object') throw new ConnectorError('sources.app.noQueries');
    const object = testing
      ? preset.test
      : (selected ??
        preset.objects.find((entry) => entry.name === select.object.name) ??
        (await objects(ctx, preset, address, settings, values)).result.find(
          (entry) => entry.name === select.object.name,
        ));
    if (!object || select.object.schema !== null) throw new ConnectorError('sources.app.objectMissing');
    const objectOptions = {
      ...apiOptions(preset, object, testing, settings, values),
      ...recordOptions(object),
    };
    if ('graphql' in object) {
      const context: ConnectorContext = {
        ...ctx,
        secrets: authSecrets(ctx, preset),
        connection: GraphQlConnection.parse({
          ...object.graphql,
          kind: 'graphql',
          baseUrl: address,
          auth: authFor(preset, settings, address),
          requestsPerSecond: preset.target.requestsPerSecond,
        }),
      };
      // The GraphQL connector exposes its one query under this internal object name.
      return {
        connector: createGraphQlConnector({
          ...objectOptions,
          nestedConnections: object.nestedConnections,
        }),
        context,
        select: { kind: 'object', object: { schema: null, name: 'query' } } as const,
        object,
      };
    }
    const endpoint = endpointWithValues({ ...object.endpoint, name: object.name }, settings, values);
    const context = restContext(ctx, address, preset, endpoint, settings);
    if (!testing && preset.fieldSelection) {
      const rule = preset.fieldSelection;
      const metadata = endpointWithValues(
        {
          ...rule.endpoint,
          path: pathFor(rule.endpoint.path, object.name),
          query: rule.endpoint.query.map((param) => ({
            ...param,
            value: param.value.replaceAll('{object}', object.name),
          })),
        },
        settings,
        values,
      );
      const metadataContext = restContext(ctx, address, preset, metadata, settings);
      const answer = await createRestConnector(objectOptions).request(
        metadataContext,
        endpointUrl(address, metadata),
      );
      // An empty field list (Zoho answers 204 for modules such as Approvals) leaves nothing to read,
      // so the object is left out instead of failing the whole source.
      if (!answer.length)
        throw new ConnectorError('sources.app.objectNoFields', undefined, {
          object: object.label ?? object.name,
        });
      const endpoints = fieldEndpoints(documentOf(answer), rule, endpoint, address, object.name, object.key);
      return {
        connector: createRestConnector({
          ...objectOptions,
          recordGroups: { endpoints, key: object.key, changedMessageKey: 'sources.app.batchChanged' },
        }),
        context,
        select,
        object,
      };
    }
    const valueRules = object.values;
    if (valueRules) {
      let labels: Map<string, string> | undefined;
      return {
        connector: createRestConnector({
          ...objectOptions,
          async document(pageContext, url, first, request) {
            // Metadata uses the active call's guarded transport, pacing, retry, and deadline.
            if (!labels)
              labels = valueRules.labels
                ? fieldLabels(
                    documentOf(await request(endpointUrl(address, valueRules.labels.endpoint))),
                    valueRules,
                  )
                : new Map();
            const document = objectOptions.document
              ? await objectOptions.document(pageContext, url, first, request)
              : first;
            return projectValues(document, endpoint.records, valueRules, labels);
          },
        }),
        context,
        select,
        object,
      };
    }
    const properties = testing ? undefined : preset.properties;
    if (!properties) {
      const api = objectOptions;
      const projection = object.projection;
      let project: ReturnType<typeof recordProjection> | undefined;
      return {
        connector: createRestConnector({
          ...api,
          keyColumns: [object.key],
          ...(projection?.definitions.id
            ? {
                async prepare(_ctx, read) {
                  const definitions = endpointWithValues(
                    RestEndpoint.parse({
                      name: 'definitions',
                      path: pathFor(projection.definitions.path, object.name),
                      records: projection.definitions.records,
                      query: projection.definitions.query,
                      paging: projection.definitions.paging,
                    }),
                    settings,
                    values,
                  );
                  const records: unknown[] = [];
                  for await (const page of read(definitions, (document) =>
                    checkResponse(document, preset.response),
                  ))
                    records.push(...page);
                  let document: unknown = records;
                  for (const member of definitions.records.split('.').filter(Boolean).reverse())
                    document = { [member]: document };
                  project = recordProjection(projection, endpoint, document);
                },
                columnNames: () => project?.columns ?? [],
              }
            : {}),
          ...(projection
            ? {
                async document(ctx, url, value, request) {
                  const page = api.document ? await api.document(ctx, url, value, request) : value;
                  if (!project) {
                    const definitions = RestEndpoint.parse({
                      name: 'definitions',
                      path: pathFor(projection.definitions.path, object.name),
                      records: projection.definitions.records,
                    });
                    // Fetch once per operation through the active call's guarded, paced request.
                    const document = documentOf(await request(endpointUrl(address, definitions)));
                    project = recordProjection(
                      projection,
                      endpoint,
                      checkResponse(document, preset.response),
                    );
                  }
                  return project(page);
                },
              }
            : {}),
        }),
        context,
        select,
        object,
      };
    }
    const propertyEndpoint = endpointWithValues(
      RestEndpoint.parse({
        name: 'properties',
        path: pathFor(properties.path, object.name),
        records: properties.records,
      }),
      settings,
      values,
    );
    const names = propertyNames(
      documentOf(
        await createRestConnector(objectOptions).request(context, endpointUrl(address, propertyEndpoint)),
      ),
      properties,
    );
    const connector = createRestConnector({
      ...objectOptions,
      requestUrl: (_context, url) => propertyRequests(url, properties.param, names)[0]!,
      async document(_pageContext, url, first, request) {
        const documents = [first];
        const rows = valueAt(first, endpoint.records);
        if (!Array.isArray(rows)) throw new ConnectorError('sources.app.records');
        if (rows.length)
          for (const next of propertyRequests(url, properties.param, names).slice(1))
            documents.push(documentOf(await request(next)));
        return mergePropertyPages(documents, endpoint, object.key, properties.member, names);
      },
    });
    return { connector, context, select, object };
  }

  async function accessibleObjects(
    ctx: RestConnectorContext,
    prepared?: Awaited<ReturnType<typeof prepare>>,
  ) {
    const account = prepared ?? (await prepare(ctx));
    const { preset, address, settings, values } = account;
    const allowed: SourceObject[] = [];
    const discovered = await objects(ctx, preset, address, settings, values);
    const skipped: SourceTestResult['steps'] = [...discovered.skipped];
    for (const object of discovered.result) {
      const start = Date.now();
      try {
        const built = await setup(
          ctx,
          { kind: 'object', object: { schema: null, name: object.name } },
          false,
          object,
          account,
        );
        // One page proves access to both the properties and columns, including empty objects.
        if (isRestConnector(built.connector)) await built.connector.firstPage(built.context, built.select, 1);
        else await built.connector.preview(built.context, built.select, 1);
        allowed.push({
          schema: null,
          name: object.name,
          type: 'endpoint',
          rowEstimate: null,
          ...(object.label ? { label: object.label } : {}),
          ...(object.labelMessageId
            ? { labelMessageId: object.labelMessageId, labelParams: object.labelParams }
            : {}),
        });
      } catch (error) {
        if (
          !(error instanceof ConnectorError) ||
          (!isPermissionRefusal(error.messageKey, preset) &&
            error.messageKey !== 'sources.app.objectNoFields')
        )
          throw error;
        skipped.push({
          step: 'rows',
          status: 'skipped',
          ms: Date.now() - start,
          messageKey: error.messageKey,
          params: error.params as SourceTestResult['steps'][number]['params'],
        });
      }
    }
    return { allowed, skipped };
  }

  async function run<T>(ctx: ConnectorContext, action: () => Promise<T>): Promise<T> {
    try {
      return await action();
    } catch (error) {
      const connection = ctx.connection;
      const entry =
        connection.kind === 'app'
          ? presets.find((preset) => preset.catalog.id === connection.app)?.catalog
          : undefined;
      const problem = failure(error, entry, options.onUnexpectedError);
      if (problem.messageKey === 'sources.app.connectionRefused' && ctx.onAuthRefused)
        return ctx.onAuthRefused();
      throw problem;
    }
  }

  return {
    kind: 'app',
    async test(ctx) {
      ctx = inspectionContext(ctx);
      const steps: SourceTestResult['steps'] = [];
      try {
        const prepared = await prepare(ctx);
        const { preset } = prepared;
        const built = await setup(
          ctx,
          { kind: 'object', object: { schema: null, name: preset.test.name } },
          true,
          undefined,
          prepared,
        );
        const result = await built.connector.test(built.context);
        const failed = result.steps.filter((step) => step.status === 'failed');
        // A listed object's refusal can leave other objects readable, while dedicated key probes stay required.
        const skipTestObject =
          (preset.test.permission !== undefined ||
            preset.objects.some((object) => object.name === preset.test.name)) &&
          failed.length > 0 &&
          failed.every((step) => isPermissionRefusal(step.messageKey, preset));
        steps.push(
          ...result.steps.map((step) => {
            const key = step.messageKey ? messageKey(step.messageKey, preset.catalog) : undefined;
            const params =
              key === appDeniedMessage(preset.catalog) && preset.catalog.keyUrl
                ? { ...step.params, keyUrl: preset.catalog.keyUrl }
                : step.params;
            return {
              step: skipTestObject && step.status === 'failed' ? 'rows' : step.step,
              status: skipTestObject && step.status === 'failed' ? 'skipped' : step.status,
              ms: step.ms,
              ...(key ? { messageKey: key } : {}),
              ...(params ? { params } : {}),
            };
          }),
        );
        if (!result.ok && !skipTestObject) {
          if (steps.some((step) => step.messageKey === 'sources.app.connectionRefused') && ctx.onAuthRefused)
            await ctx.onAuthRefused();
          return { ok: false, steps };
        }
        const { allowed, skipped } = await accessibleObjects(ctx, prepared);
        steps.push(
          ...skipped.filter(
            (note) =>
              !steps.some(
                (step) =>
                  step.status === 'skipped' &&
                  step.messageKey === note.messageKey &&
                  step.params?.object === note.params?.object,
              ),
          ),
        );
        if (!allowed.length && !preset.allowNoObjects) {
          // An organization's permissions do not establish that the shared account's credentials were refused.
          const refusal = preset.catalog.connect
            ? skipped.find((step) => isPermissionRefusal(step.messageKey, preset))
            : undefined;
          if (refusal?.messageKey) throw new ConnectorError(refusal.messageKey, undefined, refusal.params);
          throw new ConnectorError(appDeniedMessage(preset.catalog));
        }
        return {
          ok: true,
          steps,
        };
      } catch (error) {
        const problem = await run(ctx, () => Promise.reject(error)).catch((thrown: ConnectorError) => thrown);
        return {
          ok: false,
          steps: [
            ...steps,
            {
              step: 'authenticate',
              status: 'failed',
              ms: 0,
              messageKey: problem.messageKey,
              ...(problem.params
                ? { params: problem.params as SourceTestResult['steps'][number]['params'] }
                : {}),
            },
          ],
        };
      }
    },
    listObjects: (ctx) => {
      const context = inspectionContext(ctx);
      return run(context, async () => (await accessibleObjects(context)).allowed);
    },
    describe: (ctx, select) =>
      run(ctx, async () => {
        const built = await setup(operationContext(ctx), select);
        return built.connector.describe(built.context, built.select);
      }),
    preview: (ctx, select, limit) =>
      run(ctx, async () => {
        const built = await setup(operationContext(ctx), select);
        return built.connector.preview(built.context, built.select, limit);
      }),
    keyCandidates: (ctx, object) =>
      run(ctx, async () => {
        const built = await setup(operationContext(ctx), { kind: 'object', object });
        return built.connector.keyCandidates(built.context, built.select.object);
      }),
    async *read(ctx, select, readOptions) {
      const built = await run(ctx, () => setup(operationContext(ctx), select));
      try {
        yield* built.connector.read(built.context, built.select, readOptions);
      } catch (error) {
        await run(ctx, () => Promise.reject(error));
      }
    },
  };
}
