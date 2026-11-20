import type {
  IDataObject,
  IExecuteFunctions,
  IHookFunctions,
  IHttpRequestOptions,
  INode,
  IWebhookFunctions,
} from 'n8n-workflow';
import { vi } from 'vitest';
import type { FakeRiosoma } from './fake-riosoma';

/**
 * The parts of n8n's function contexts the nodes use, backed by a fake Riosoma.  Parameters come
 * from a plain object, or from a function of the item for values that differ by item.
 */

export const ADDRESS = 'https://riosoma.example.com';

type Parameters = Record<string, unknown> | ((name: string, itemIndex: number) => unknown);

function lookup(parameters: Parameters, name: string, itemIndex: number): unknown {
  if (typeof parameters === 'function') return parameters(name, itemIndex);
  let value: unknown = parameters;
  for (const part of name.split('.')) {
    if (!value || typeof value !== 'object') return undefined;
    value = (value as Record<string, unknown>)[part];
  }
  return value;
}

/** A resource locator's value, the way `extractValue` hands it over. */
function extracted(value: unknown, options?: { extractValue?: boolean }): unknown {
  if (options?.extractValue && value && typeof value === 'object' && '__rl' in value)
    return (value as unknown as { value: unknown }).value;
  return value;
}

const node: INode = {
  id: 'node',
  name: 'Riosoma',
  type: 'n8n-nodes-riosoma.riosoma',
  typeVersion: 1,
  position: [0, 0],
  parameters: {},
};

function shared(api: FakeRiosoma) {
  return {
    getNode: () => node,
    getTimezone: () => 'America/New_York',
    getCredentials: async () => ({ url: `${ADDRESS}/`, token: 'rio_pat_test', ignoreSslIssues: false }),
    logger: { warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() },
    helpers: {
      httpRequestWithAuthentication: async (_type: string, request: IHttpRequestOptions) => {
        const answer = api.handle(request.method ?? 'GET', request.url, request.body);
        return { statusCode: answer.status, body: answer.body, headers: {} };
      },
    },
  };
}

export function executeContext(
  api: FakeRiosoma,
  parameters: Parameters,
  items: IDataObject[] = [{}],
  continueOnFail = false,
): IExecuteFunctions {
  return {
    ...shared(api),
    getInputData: () => items.map((json) => ({ json })),
    continueOnFail: () => continueOnFail,
    getNodeParameter: (
      name: string,
      itemIndex: number,
      fallback?: unknown,
      options?: { extractValue?: boolean },
    ) => extracted(lookup(parameters, name, itemIndex), options) ?? fallback,
  } as unknown as IExecuteFunctions;
}

export interface FakeResponseObject {
  statusCode: number;
  body: unknown;
}

export function hookContext(
  api: FakeRiosoma,
  parameters: Parameters,
  staticData: IDataObject,
  webhookUrl = 'https://n8n.example.com/webhook/0f0e/webhook',
): IHookFunctions {
  return {
    ...shared(api),
    getWorkflowStaticData: () => staticData,
    getNodeWebhookUrl: () => webhookUrl,
    getNodeParameter: (name: string, fallback?: unknown, options?: { extractValue?: boolean }) =>
      extracted(lookup(parameters, name, 0), options) ?? fallback,
  } as unknown as IHookFunctions;
}

export function webhookContext(
  api: FakeRiosoma,
  parameters: Parameters,
  staticData: IDataObject,
  request: { headers: Record<string, string>; body: unknown; rawBody?: Buffer },
): { context: IWebhookFunctions; response: FakeResponseObject } {
  const response: FakeResponseObject = { statusCode: 200, body: undefined };
  const responseObject = {
    status(code: number) {
      response.statusCode = code;
      return responseObject;
    },
    json(body: unknown) {
      response.body = body;
      return responseObject;
    },
  };
  const context = {
    ...shared(api),
    getWorkflowStaticData: () => staticData,
    getRequestObject: () => request,
    getResponseObject: () => responseObject,
    getNodeParameter: (name: string, fallback?: unknown) => lookup(parameters, name, 0) ?? fallback,
  } as unknown as IWebhookFunctions;
  return { context, response };
}
