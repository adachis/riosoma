import type { DataSchemas } from './context.js';

/**
 * Postgres notification channels.  A committed change sends `{"databaseId", "seq"}` on the
 * changes channel with `pg_notify`, inside the command's transaction so it goes out only on
 * commit; presence goes on its own channel.  Names include the app schema, so two installs sharing
 * one Postgres database never hear each other.
 */
export function changesChannel(schemas: DataSchemas): string {
  return `${schemas.app}_changes`.slice(0, 63);
}

export function organizationChannel(schemas: DataSchemas): string {
  return `${schemas.app}_organization`.slice(0, 63);
}

export function presenceChannel(schemas: DataSchemas): string {
  return `${schemas.app}_presence`.slice(0, 63);
}

/**
 * Who can open a database changed; the payload is the database ID.  Anything that changes access
 * sends it, so open realtime subscriptions recheck their role at once instead of at the next
 * session check.
 */
export function accessChannel(schemas: DataSchemas): string {
  return `${schemas.app}_access`.slice(0, 63);
}

export interface ChangeNotice {
  databaseId: string;
  seq: number;
}

/**
 * Home notices contain only the organization ID, so clients refetch through their access scope.
 * Folder changes also invalidate realtime access throughout that organization, including nested
 * databases and subscriptions registered while the change was committing.
 */
export function homeChannel(schemas: DataSchemas): string {
  return `${schemas.app}_home`.slice(0, 63);
}
