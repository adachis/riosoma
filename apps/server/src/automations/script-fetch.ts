import { z } from 'zod';
import { callOut, checkRequest, type OutboundRequest, type Resolve } from './outbound.js';
import { ScriptError } from './script.js';
import { headerAllowed } from './validate.js';

const Request = z.tuple([
  z.string().url(),
  z
    .object({
      method: z.enum(['GET', 'POST', 'PUT', 'PATCH']).default('GET'),
      headers: z.record(z.string(), z.string()).default({}),
      body: z.string().nullable().default(null),
    })
    .strict(),
]);

/** A script's `fetch` arguments as a request, refused unless it's https with headers a script may set. */
function scriptRequest(args: unknown[]): OutboundRequest {
  const request = Request.parse(args);
  const url = new URL(request[0]);
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    !Object.keys(request[1].headers).every(headerAllowed)
  )
    throw new ScriptError('automations.script.fetchBlocked');
  return { url: request[0], ...request[1] };
}

export async function scriptFetch(args: unknown[], resolve: Resolve, timeoutMs: number) {
  const response = await callOut(scriptRequest(args), {
    resolve,
    allowPrivate: false,
    timeoutMs,
  });
  if (response.status >= 300 && response.status < 400)
    throw new ScriptError('automations.script.fetchBlocked');
  if (response.truncated) throw new ScriptError('automations.script.responseLimit');
  return { status: response.status, headers: response.headers ?? {}, body: response.body };
}

/**
 * What a simulated script's `fetch` answers: nothing is sent, and the script gets status 200 with
 * an empty JSON object, so it carries on.  The request it would have made comes back beside it.
 */
export function simulatedFetch(args: unknown[]) {
  const request = scriptRequest(args);
  // Refused the way a real call would be, as far as can be told without looking the name up.
  checkRequest(request, { allowPrivate: false });
  return { request, response: { status: 200, headers: {}, body: '{}' } };
}
