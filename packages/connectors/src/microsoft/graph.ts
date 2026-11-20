import { ConnectorError } from '../types.js';
import { microsoftProblem, MICROSOFT_KEYS, type Answer, type MicrosoftCall } from './client.js';

/**
 * The parts of Microsoft Graph the SharePoint list and Excel workbook sources share: addresses under
 * Graph's own origin, and finding a site by the address people know it by.
 */

export interface SiteInfo {
  /** Graph's ID for the site, like `contoso.sharepoint.com,<guid>,<guid>` */
  id: string;
  name: string;
  /** The address the source names it by */
  address: string;
}

/** An address under Graph's v1.0 API. */
export function graphAddress(graphUrl: string, path: string, query: Record<string, string> = {}): URL {
  const address = new URL(`${graphUrl}/v1.0${path}`);
  for (const [name, value] of Object.entries(query)) address.searchParams.set(name, value);
  return address;
}

/**
 * The error an answer outside 2xx stands for, about `what`.  Graph answers 401 for an app with no
 * permission to SharePoint at all, and 403 for a site the app wasn't given, which both mean the
 * app needs access, so both say `denied`.  A 404 says `missing`.
 */
export function graphRefusal(
  answer: Answer,
  what: string,
  denied: string,
  missing: () => ConnectorError,
): ConnectorError {
  const problem = microsoftProblem(answer.body);
  const detail = `HTTP ${answer.status}${problem.code ? ` ${problem.code}` : ''}${problem.message ? `: ${problem.message}` : ''} (${what})`;
  if (answer.status === 401 || answer.status === 403) return new ConnectorError(denied, detail);
  if (answer.status === 404) {
    const error = missing();
    return new ConnectorError(error.messageKey, detail, error.params);
  }
  return new ConnectorError(MICROSOFT_KEYS.status, detail, { status: answer.status });
}

/**
 * A site's Graph ID and name, from its address as `sharePointSiteOf` writes it: the host, then the
 * site's path, already encoded, which Graph takes after a colon.
 */
export async function findSite(
  call: MicrosoftCall,
  graphUrl: string,
  address: string,
  denied: string,
  missing: string,
): Promise<SiteInfo> {
  const host = address.slice('https://'.length).split('/')[0]!;
  const path = address.slice(`https://${host}`.length).split('/').filter(Boolean).join('/');
  const answer = await call.get(
    graphAddress(graphUrl, `/sites/${host}${path ? `:/${path}` : ''}`, { $select: 'id,displayName,webUrl' }),
  );
  if (answer.status < 200 || answer.status >= 300)
    throw graphRefusal(answer, address, denied, () => new ConnectorError(missing));
  const site = call.json(answer) as { id?: unknown; displayName?: unknown };
  if (typeof site.id !== 'string' || !site.id)
    throw new ConnectorError(MICROSOFT_KEYS.unreadable, `Graph gave no ID for ${address}`);
  return { id: site.id, name: typeof site.displayName === 'string' ? site.displayName : address, address };
}
