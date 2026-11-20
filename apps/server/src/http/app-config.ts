import type { FastifyInstance } from 'fastify';
import type { AppConfig } from '@riosoma/contracts';
import { bucketHostUrl, bucketTarget } from '@riosoma/connectors/s3';
import { DEFAULT_MAP_STYLE_URL, type RuntimeConfig } from '../config.js';
import { VERSION } from '../version.js';

/** The style map views draw with, or null when the server turns maps off. */
export function mapStyleUrl(config: Pick<RuntimeConfig, 'mapStyleUrl'>): string | null {
  return config.mapStyleUrl === undefined ? DEFAULT_MAP_STYLE_URL : config.mapStyleUrl;
}

/**
 * What the content security policy lets map views reach: the style's own origin, for the style
 * and the tiles, fonts, and sprites it names.  Nothing when maps are off.  MapLibre's worker ships
 * with the web app, so workers need nothing more than the app's own origin.
 */
export function mapOrigins(config: Pick<RuntimeConfig, 'mapStyleUrl'>): string[] {
  const url = mapStyleUrl(config);
  return url ? [new URL(url).origin] : [];
}

/**
 * Where attachments load from when downloads are sent to the store's signed addresses: the
 * bucket's and the container's origins, so previews, pictures, and players can show them.  Nothing
 * while downloads go through Riosoma, which is the default.
 */
export function fileStoreOrigins(
  config: Pick<RuntimeConfig, 'filesSignedUrlSeconds' | 'filesS3' | 'filesAzure'>,
): string[] {
  if (!config.filesSignedUrlSeconds) return [];
  const origins: string[] = [];
  if (config.filesS3) origins.push(bucketHostUrl(bucketTarget(config.filesS3)).origin);
  if (config.filesAzure) origins.push(new URL(config.filesAzure.endpoint).origin);
  return origins;
}

/**
 * `GET /api/config`, which the web app reads for settings that come from the server's environment,
 * and for the version it runs, which `/healthz` already tells anyone who asks.
 */
export async function appConfigRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/config', { config: { policy: { kind: 'public' } } }, async (request): Promise<AppConfig> => ({
    map: { styleUrl: request.actor?.demo ? null : mapStyleUrl(app.ctx.config) },
    version: VERSION,
  }));
}
