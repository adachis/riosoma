import { createHash } from 'node:crypto';
import {
  AppError,
  DatabaseId,
  cellValue,
  AutomationNotificationContent,
  type NotificationRecipients,
  type Notification,
} from '@riosoma/contracts';
import { ident, query, sql, type Queryable } from '@riosoma/db';
import { activeMember, notificationVisible } from '../notifications/store.js';
import type { AccessScope } from './access.js';
import type { DataSchemas } from './context.js';
import { formatValue } from './format.js';
import { rowAttachments } from './files/metadata.js';
import { loadCollaborators, loadFields } from './metadata.js';
import { ridsForIds } from './physical/order.js';
import { fetchPageByRid } from './physical/records.js';
import { displayExpr } from './physical/relations.js';
import { resolveSelectOptions } from './select-options.js';
import { idsOf } from '@riosoma/contracts';

export const NOTIFICATION_BURST = 50;
export const NOTIFICATION_WINDOW_MS = 3_600_000;

/** Membership is resolved again at delivery, so a removed person fails the step before any send. */
export async function notificationRecipients(
  db: Queryable,
  schemas: DataSchemas,
  scope: AccessScope,
  automationId: string,
  recipients: NotificationRecipients,
  record: { creatorId: string | null; personIds: string[] } | null,
): Promise<Array<{ id: string; name: string }>> {
  await scope.requireOrganization();
  let ids: string[];
  switch (recipients.kind) {
    case 'people':
      ids = recipients.userIds;
      break;
    case 'personField':
      ids = record?.personIds ?? [];
      break;
    case 'recordCreator':
      ids = record?.creatorId ? [record.creatorId] : [];
      break;
    case 'automationOwner': {
      const result = await query<{ created_by: string | null }>(
        db,
        sql`SELECT created_by FROM ${ident(schemas.app, 'automations')}
        WHERE id = ${automationId} AND org_id = ${scope.actor.orgId}`,
      );
      ids = result.rows[0]?.created_by ? [result.rows[0].created_by] : [];
      break;
    }
    case 'group': {
      const result = await query<{ user_id: string }>(
        db,
        sql`SELECT gm.user_id FROM ${ident(schemas.app, 'group_members')} gm
        JOIN ${ident(schemas.app, 'groups')} g ON g.id = gm.group_id AND g.org_id = gm.org_id
        WHERE gm.group_id = ${recipients.groupId} AND gm.org_id = ${scope.actor.orgId}
        ORDER BY gm.user_id LIMIT ${NOTIFICATION_BURST + 1}`,
      );
      ids = result.rows.map((row) => row.user_id);
      break;
    }
  }
  ids = [...new Set(ids)];
  if (!ids.length) throw new AppError('validation_failed', 'automations.notification.noRecipients');
  if (ids.length > NOTIFICATION_BURST) throw new AppError('rate_limited', 'automations.notification.burst');
  const people = await loadCollaborators(db, schemas, scope.actor.orgId, scope);
  const found = [];
  for (const id of ids) {
    if (!(await activeMember(db, schemas, scope.actor.orgId, id)))
      throw new AppError('not_found', 'automations.notification.personDeleted');
    found.push({ id, name: people.find((person) => person.id === id)?.name ?? '' });
  }
  return found;
}

function recordNotice(
  databaseId: string,
  source: NonNullable<AutomationNotificationContent['tokens'][string]['source']>,
): Notification {
  return {
    id: '',
    kind: 'automationNotification',
    actor: null,
    createdAt: '',
    readAt: null,
    target: {
      databaseId,
      tableId: source.tableId,
      recordId: source.recordId,
      ...(source.fieldId ? { fieldId: source.fieldId } : {}),
    },
  };
}

/** Field formatting uses the recipient's scoped fields, linked records, and attachment metadata. */
async function fieldText(
  db: Queryable,
  schemas: DataSchemas,
  scope: AccessScope,
  source: NonNullable<AutomationNotificationContent['tokens'][string]['source']>,
): Promise<string> {
  const fields = await resolveSelectOptions(
    db,
    schemas,
    scope,
    scope.visibleFields(source.tableId, await loadFields(db, schemas, [source.tableId])),
  );
  const field = fields.find((candidate) => candidate.id === source.fieldId);
  if (!field) return '';
  const rid = (await ridsForIds(db, schemas.data, source.tableId, [source.recordId])).get(source.recordId);
  const [row] =
    rid === undefined
      ? []
      : await fetchPageByRid(
          db,
          schemas.data,
          source.tableId,
          fields,
          [rid],
          scope.recordPredicate(source.tableId),
          { now: new Date(), timeZone: 'UTC' },
        );
  if (!row) return '';
  const people = await loadCollaborators(db, schemas, scope.actor.orgId, scope);
  const files = await rowAttachments(db, schemas.app, source.tableId, fields, [row]);
  const linked = new Map<string, string>();
  for (const returned of fields) {
    let target = returned;
    const seen = new Set<string>();
    while (target.type === 'lookup' && target.relation?.target && !seen.has(target.id)) {
      seen.add(target.id);
      target = target.relation.target;
    }
    const relation = target.type === 'link' || target.type === 'lineItems' ? target.relation : undefined;
    const ids = idsOf(cellValue(row, returned));
    if (
      !relation?.primary ||
      !ids.length ||
      !scope.visibleFields(relation.linkedTableId, [relation.primary]).length
    )
      continue;
    const names = await query<{ id: string; name: string }>(
      db,
      sql`SELECT __id AS id, ${displayExpr(relation.primary)} AS name
      FROM ${ident(schemas.data, relation.linkedTableId)} WHERE __id = ANY(${ids}::text[])
      AND __deleted_at IS NULL AND (${scope.recordPredicate(relation.linkedTableId)})`,
    );
    for (const name of names.rows) linked.set(name.id, name.name);
  }
  return formatValue(field, cellValue(row, field), {
    locale: 'en-US',
    timeZone: 'UTC',
    people: new Map(people.map((person) => [person.id, person])),
    fields: new Map(fields.map((item) => [item.id, item])),
    files: new Map(Object.entries(files)),
    linked,
  });
}

/** Invalid schemes never reach a notification link, and app record links use the shared access check. */
async function safeLink(
  db: Queryable,
  schemas: DataSchemas,
  scope: AccessScope,
  link: string,
): Promise<string> {
  if (!link) return '';
  if (link.includes('\\') || Array.from(link).some((character) => character.charCodeAt(0) < 32))
    throw new AppError('validation_failed', 'automations.notification.linkInvalid');
  let pathname: string;
  if (/^\/(?!\/)/.test(link)) {
    // Parsing against an inert origin applies the same dot-segment normalization as navigation.
    const url = new URL(link, `https://${scope.actor.orgId}`);
    pathname = url.pathname;
    link = `${pathname}${url.search}${url.hash}`;
  } else {
    let url: URL;
    try {
      url = new URL(link);
    } catch {
      throw new AppError('validation_failed', 'automations.notification.linkInvalid');
    }
    if (!['https:', 'http:'].includes(url.protocol))
      throw new AppError('validation_failed', 'automations.notification.linkInvalid');
    pathname = url.pathname;
  }
  let parts: string[];
  try {
    parts = pathname
      .slice(1)
      .split('/')
      .map((part) => decodeURIComponent(part));
  } catch {
    throw new AppError('validation_failed', 'automations.notification.linkInvalid');
  }
  const [databaseId, tableId, viewId, recordId] = parts;
  if (DatabaseId.safeParse(databaseId).success) {
    if (!(await scope.databaseRole(databaseId!))) return '';
    if (
      tableId &&
      viewId &&
      recordId &&
      !(await notificationVisible(db, schemas, scope, {
        id: '',
        kind: 'automationNotification',
        actor: null,
        createdAt: '',
        readAt: null,
        target: { databaseId, tableId, recordId },
      }))
    )
      return '';
  }
  return link;
}

/**
 * A fresh send formats fields for its recipient.  Later reads keep that wording only while the
 * same access applies.  Derived outputs have no field provenance, so they require full access.
 */
export async function scopedNotificationContent(
  db: Queryable,
  schemas: DataSchemas,
  scope: AccessScope,
  content: AutomationNotificationContent,
  fresh = false,
) {
  await scope.requireOrganization();
  const role = await scope.databaseRole(content.databaseId);
  if (role) await scope.prepare(content.databaseId);
  const accessKey = role
    ? createHash('sha256')
        .update(await scope.fingerprint(content.databaseId))
        .digest('hex')
    : '';
  const tokens: AutomationNotificationContent['tokens'] = {};
  for (const [key, value] of Object.entries(content.tokens)) {
    let text = value.text;
    const source = value.source;
    let sourceVisible = false;
    if (source) {
      const visible =
        role && (await notificationVisible(db, schemas, scope, recordNotice(content.databaseId, source)));
      sourceVisible = Boolean(visible);
      text =
        !visible || (!fresh && source.accessKey !== accessKey)
          ? ''
          : fresh && source.fieldId
            ? await fieldText(db, schemas, scope, source)
            : text;
      if (!fresh && text && source.fieldId) {
        const field = (await loadFields(db, schemas, [source.tableId])).find(
          (candidate) => candidate.id === source.fieldId,
        );
        // Linked and calculated values can lose visibility when related records change.
        if (field && ['link', 'lineItems', 'lookup', 'rollup', 'count', 'formula'].includes(field.type)) {
          if ((await fieldText(db, schemas, scope, source)) !== text) text = '';
        }
      }
    } else if (value.databaseWide && (!role || scope.limited(content.databaseId))) text = '';
    tokens[key] = {
      ...value,
      text,
      ...(source && sourceVisible ? { source: { ...source, accessKey } } : {}),
    };
  }
  const fill = (template: string) =>
    template.replace(/\{\{\s*([^{}]+?)\s*\}\}/g, (_raw, key: string) => tokens[key]?.text ?? '');
  const title = fill(content.title);
  const message = fill(content.message);
  const address = fill(content.link).trim();
  if (
    !AutomationNotificationContent.pick({ title: true, message: true, link: true }).safeParse({
      title,
      message,
      link: address,
    }).success
  )
    throw new AppError('validation_failed', 'errors.tooLarge');
  const link = await safeLink(db, schemas, scope, address);
  return { content: { ...content, tokens }, title, message, link };
}
