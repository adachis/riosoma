import { serviceAccountEmailOf, type SourceConnection, type SourceSecrets } from '@riosoma/contracts';
import {
  createGoogleSheetsConnector,
  registerConnector,
  type SheetsConnectorOptions,
} from '@riosoma/connectors';
import type { FastifyInstance } from 'fastify';
import { systemResolve, type Resolve } from '../automations/outbound.js';
import type { RuntimeConfig } from '../config.js';
import { allowsPrivate } from '../webhooks/url.js';
import { fileNetwork, refuse } from './files.js';

/**
 * Google Sheets sources on this server: the connector, given the guarded network file and API
 * sources use.  It only ever asks Google's own addresses, so there's no address for a source to
 * point somewhere it shouldn't.
 */

type Config = Pick<RuntimeConfig, 'production' | 'automationsAllowPrivateHosts'>;

export function googleSheetsConnectorOptions(
  config: Config,
  resolve: Resolve = systemResolve,
): SheetsConnectorOptions {
  return { network: fileNetwork({ resolve, allowPrivate: (url) => allowsPrivate(url.href, config) }) };
}

export function installGoogleSheetsSources(app: FastifyInstance): void {
  registerConnector(createGoogleSheetsConnector(googleSheetsConnectorOptions(app.ctx.config)));
}

/**
 * A Google Sheets connection with its service account's address copied from the key, so the form
 * can show whom to share spreadsheets with.  A key that isn't a service account's JSON key is
 * refused before it's saved or tried.  Other kinds pass through as they are.
 */
export function withServiceAccount(connection: SourceConnection, secrets: SourceSecrets): SourceConnection {
  if (connection.kind !== 'google-sheets') return connection;
  const key = secrets.serviceAccountJson;
  // A missing key is the secrets check's to report.
  if (!key) return connection;
  const email = serviceAccountEmailOf(key);
  if (!email) refuse('serviceAccountJson', 'sources.google.key');
  return { ...connection, serviceAccountEmail: email };
}
