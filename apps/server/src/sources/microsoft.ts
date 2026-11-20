import { SPREADSHEET_LIMITS } from '@riosoma/contracts';
import {
  createDataverseConnector,
  createExcelOnlineConnector,
  createSharePointListConnector,
  registerConnector,
  type MicrosoftOptions,
} from '@riosoma/connectors';
import type { FastifyInstance } from 'fastify';
import { systemResolve, type Resolve } from '../automations/outbound.js';
import type { RuntimeConfig } from '../config.js';
import { allowsPrivate } from '../webhooks/url.js';
import { fileNetwork, spreadsheetReader } from './files.js';

/**
 * Microsoft 365 sources on this server: SharePoint lists, Excel workbooks in SharePoint or
 * OneDrive, and Dataverse tables, each given the guarded network file and API sources use.  They
 * only ever ask Entra's token address, Microsoft Graph, and a Dataverse environment on Microsoft's
 * own hosts, which the settings hold them to, so there's no address for a source to point
 * somewhere it shouldn't.  Workbooks are read the way uploads are.
 */

type Config = Pick<RuntimeConfig, 'production' | 'automationsAllowPrivateHosts'>;

export function microsoftConnectorOptions(
  config: Config,
  resolve: Resolve = systemResolve,
): MicrosoftOptions {
  return { network: fileNetwork({ resolve, allowPrivate: (url) => allowsPrivate(url.href, config) }) };
}

export function installMicrosoftSources(app: FastifyInstance): void {
  const options = microsoftConnectorOptions(app.ctx.config);
  registerConnector(createSharePointListConnector(options));
  registerConnector(
    createExcelOnlineConnector({
      ...options,
      spreadsheet: spreadsheetReader,
      spreadsheetMaxBytes: SPREADSHEET_LIMITS.uploadBytes,
    }),
  );
  registerConnector(createDataverseConnector(options));
}
