import { flattenAutomationSteps } from '@riosoma/contracts';
import {
  AppError,
  newId,
  SharedViewSettings,
  SourceConnection,
  type CommandBatchResult,
  type OrganizationDestination,
  type OrganizationImportReviewItem,
  type OrganizationReviewResult,
} from '@riosoma/contracts';
import { ident, query, sql, withTransaction, type Queryable } from '@riosoma/db';
import type { FastifyInstance } from 'fastify';
import { auditEvent, authDatabase, lockKeys } from '../../auth/database.js';
import { findIdentity } from '../../auth/sessions.js';
import { isMessageStep } from '../../automations/messaging.js';
import { loadAutomation } from '../../automations/store.js';
import { inspectPage, pageById } from '../../bookings/pages.js';
import type { Actor } from '../../http/policy.js';
import type { MailMessage } from '../../mail/index.js';
import { invitationMessage } from '../../mail/messages.js';
import { createInvitation } from '../../sharing/invitations.js';
import { checkFileAddress, checkFileHost } from '../../sources/files.js';
import { checkApiAddress } from '../../sources/rest.js';
import { checkSecrets, secretsFor, type SourceRow } from '../../sources/store.js';
import { newHookAddress } from '../../sources/webhook.js';
import { checkedUrl } from '../../webhooks/url.js';
import { unsealCredential } from '../../credentials/service.js';
import { dismissLibraryReview, restoreLibraryReview } from '../commands/libraries.js';
import { runCommands } from '../commands/index.js';
import { dataStore } from '../context.js';
import { AccessScope } from '../access.js';
import { newPublicFormId } from '../public-forms.js';
import { newSharedViewId } from '../shared-views.js';
import { canonical } from './catalog.js';

interface ReviewRow {
  id: string;
  org_id: string;
  kind: OrganizationImportReviewItem['kind'];
  target_id: string;
  database_id: string | null;
  name: string;
  destinations: OrganizationDestination[];
  detail: {
    needsSecret?: boolean;
    invitedAs?: 'member' | 'guest';
    steps?: Record<string, string>;
    settings?: unknown;
    passwordHash?: string | null;
    hadPassword?: boolean;
    /** A webhook's address as the import left it, without the part that didn't come */
    url?: string;
    /** A source's connection as the import left it, as canonical JSON */
    connection?: string;
  };
  created_at: Date;
  done_at: Date | null;
  /** Knowledge libraries only: the pending documents a dismissal erases with the library */
  pending_documents?: number | null;
}

const secretNeeded = () => new AppError('conflict', 'organizationArchive.review.secretNeeded');

function visible(row: ReviewRow): OrganizationImportReviewItem {
  return {
    id: row.id,
    kind: row.kind,
    name: row.name,
    databaseId: row.database_id,
    destinations: row.destinations,
    needsSecret: Boolean(row.detail.needsSecret),
    ...(row.kind === 'person' ? { invitedAs: row.detail.invitedAs ?? 'member' } : {}),
    ...(row.kind === 'knowledgeLibrary' ? { pendingDocuments: row.pending_documents ?? 0 } : {}),
    done: row.done_at !== null,
    createdAt: row.created_at.toISOString(),
  };
}

/**
 * The list an import leaves for the owner: everyone it found, to invite when the owner chooses,
 * and everything that reaches outside the organization, to turn on one at a time.  Nothing on it
 * talks to anyone until the owner acts.
 */
export class ImportReview {
  constructor(private readonly app: FastifyInstance) {}
  private get store() {
    return dataStore(this.app.ctx);
  }
  private get table() {
    return ident(this.store.schemas.app, 'organization_import_review');
  }

  async list(actor: Actor): Promise<OrganizationImportReviewItem[]> {
    await new AccessScope(this.store.pool, this.store.schemas, actor).requireOrganizationAdmin('ai', true);
    const result = await query<ReviewRow>(
      this.store.pool,
      sql`SELECT r.id, r.kind, r.name, r.database_id, r.destinations, r.done_at, r.created_at,
        jsonb_build_object('needsSecret', r.detail->'needsSecret', 'invitedAs', r.detail->'invitedAs') AS detail,
        waiting.documents AS pending_documents
      FROM ${this.table} r
      -- Dismissing a library erases the documents still waiting on it, so the count is shown first.
      LEFT JOIN (SELECT detail->'row'->>'library_id' AS library_id, count(*)::int AS documents
        FROM ${this.table} WHERE org_id = ${actor.orgId} AND kind = 'knowledgeDocument' AND done_at IS NULL
        GROUP BY 1) waiting ON r.kind = 'knowledgeLibrary' AND r.done_at IS NULL AND waiting.library_id = r.target_id
      WHERE r.org_id = ${actor.orgId}
      ORDER BY r.kind = 'person' DESC, r.created_at, r.name, r.id LIMIT 10000`,
    );
    return result.rows.map(visible);
  }

  private async item(db: Queryable, actor: Actor, id: string): Promise<ReviewRow> {
    const row = (
      await query<ReviewRow>(
        db,
        sql`SELECT * FROM ${this.table} WHERE id = ${id} AND org_id = ${actor.orgId} FOR UPDATE`,
      )
    ).rows[0];
    if (!row) throw new AppError('not_found', 'errors.notFound');
    return row;
  }

  private async done(db: Queryable, actor: Actor, row: ReviewRow, action: string): Promise<ReviewRow> {
    const updated = await query<ReviewRow>(
      db,
      sql`UPDATE ${this.table} SET done_at = now() WHERE id = ${row.id} RETURNING *`,
    );
    await auditEvent(db, authDatabase(this.app.ctx).audit, action, actor, {
      reviewId: row.id,
      kind: row.kind,
      targetId: row.target_id,
    });
    return updated.rows[0]!;
  }

  /** Sends the chosen people their invitations, each as a member or a guest, never with admin roles. */
  async invite(actor: Actor, ids: readonly string[]): Promise<OrganizationImportReviewItem[]> {
    const { ctx } = this.app;
    const mailer = ctx.mailer;
    const base = ctx.config.baseUrl?.replace(/\/+$/, '');
    if (!mailer || !base) throw new AppError('unavailable', 'org.invite.noMail');
    const { pool, schemas } = this.store;
    const { app: authSchema } = authDatabase(ctx);
    const deliveries: MailMessage[] = [];
    const items = await withTransaction(pool, async (db) => {
      await lockKeys(db, [`invitations:${actor.orgId}`]);
      const identity = await findIdentity(db, authSchema, actor.userId);
      if (!identity || identity.orgId !== actor.orgId) throw new AppError('not_found', 'errors.notFound');
      const changed: ReviewRow[] = [];
      let count = 0;
      for (const id of new Set(ids)) {
        const row = await this.item(db, actor, id);
        if (row.kind !== 'person') throw new AppError('not_found', 'errors.notFound');
        if (row.done_at) {
          changed.push(row);
          continue;
        }
        const email = row.destinations[0]?.value ?? '';
        const user = (
          await query<{ locale: string; member: boolean }>(
            db,
            sql`SELECT u.locale, EXISTS (SELECT 1 FROM ${ident(schemas.app, 'memberships')} m
              WHERE m.user_id = u.id AND m.org_id = ${actor.orgId}) AS member
            FROM ${ident(schemas.app, 'users')} u WHERE lower(u.email) = ${email.toLowerCase()}`,
          )
        ).rows[0];
        if (!user?.member) {
          const { token } = await createInvitation(db, schemas.app, actor, {
            email,
            kind: row.detail.invitedAs === 'guest' ? 'guest' : 'member',
            reservedUserId: row.target_id,
            displayName: row.name,
          });
          deliveries.push(
            invitationMessage(
              email,
              user?.locale ?? 'en-US',
              identity.orgName,
              identity.name,
              `${base}/join#token=${token}`,
            ),
          );
          count++;
        }
        changed.push(await this.done(db, actor, row, 'organization.import.invited'));
      }
      if (count) await auditEvent(db, authDatabase(ctx).audit, 'org.invitation.created', actor, { count });
      return changed;
    });
    // Delivery starts after commit, and provider errors must never expose a one-time credential.
    const sent = await Promise.allSettled(deliveries.map((delivery) => mailer.send(delivery)));
    if (sent.some((result) => result.status === 'rejected'))
      this.app.log.warn({ code: 'mail_delivery_failed' }, 'invitation email delivery failed');
    return items.map(visible);
  }

  async dismiss(actor: Actor, id: string): Promise<OrganizationReviewResult> {
    const result = await dismissLibraryReview(this.app, actor, id);
    if (result.status === 'rejected') throw new AppError(result.error!.code, result.error!.messageKey);
    return { item: visible(await withTransaction(this.store.pool, async (db) => this.item(db, actor, id))) };
  }

  /** Turns one imported thing on, once its credentials, if it needs any, are there. */
  async enable(actor: Actor, id: string, signal?: AbortSignal): Promise<OrganizationReviewResult> {
    const { pool, schemas } = this.store;
    const { ctx } = this.app;
    const first = await withTransaction(pool, async (db) => this.item(db, actor, id));
    if (first.kind === 'person') throw new AppError('not_found', 'errors.notFound');
    if (first.done_at) return { item: visible(first) };
    if (first.kind === 'knowledgeLibrary' || first.kind === 'knowledgeDocument') {
      await restoreLibraryReview(this.app, actor, id, signal);
      return { item: visible(await withTransaction(pool, async (db) => this.item(db, actor, id))) };
    }
    if (first.kind === 'automation') {
      // Marked done before the command bus runs, in the same transaction, since the bus refuses
      // to turn on an automation still waiting here.  A refusal undoes both.
      const row = await withTransaction(pool, async (db) => {
        const row = await this.item(db, actor, id);
        if (row.done_at) return row;
        const automation = await loadAutomation(db, schemas, row.target_id);
        if (!automation || automation.orgId !== actor.orgId || automation.trashed)
          throw new AppError('not_found', 'errors.notFound');
        // A step still as the import left it, without its credential, can't run.
        for (const [stepId, imported] of Object.entries(row.detail.steps ?? {})) {
          const step = flattenAutomationSteps(automation.config.steps).find((item) => item.id === stepId);
          if (!step) continue;
          if (isMessageStep(step) ? !step.secretSaved : JSON.stringify(step) === imported)
            throw secretNeeded();
        }
        const done = await this.done(db, actor, row, 'organization.import.turnedOn');
        const result: CommandBatchResult = await runCommands(
          this.app,
          actor,
          automation.databaseId,
          {
            clientId: newId('client'),
            commands: [
              {
                id: newId('command'),
                groupId: newId('action'),
                kind: 'automation.update',
                automationId: automation.id,
                enabled: true,
              },
            ],
          },
          db,
        );
        const outcome = result.results[0];
        if (outcome?.status === 'rejected')
          throw new AppError('conflict', outcome.error?.messageKey ?? 'errors.conflict', {
            params: outcome.error?.params,
          });
        return done;
      });
      return { item: visible(row) };
    }
    let address: string | undefined;
    const row = await withTransaction(pool, async (db) => {
      const row = await this.item(db, actor, id);
      if (row.done_at) return row;
      switch (row.kind) {
        case 'bookingPage': {
          const page = await pageById(db, schemas, row.target_id, { forUpdate: true });
          if (!page || page.org_id !== actor.orgId) throw new AppError('not_found', 'errors.notFound');
          const checked = await inspectPage(db, schemas, { ...page, owner_id: actor.userId });
          if (!checked.ok) throw new AppError('conflict', checked.problem);
          await query(
            db,
            sql`UPDATE ${ident(schemas.app, 'booking_pages')} SET enabled = true, owner_id = ${actor.userId},
              updated_at = statement_timestamp() WHERE id = ${page.id}`,
          );
          address = `/b/${page.id}`;
          break;
        }
        case 'oauthClient': {
          const client = (
            await query<{ secret_hash: string | null }>(
              db,
              sql`SELECT secret_hash FROM ${ident(schemas.app, 'oauth_clients')}
                WHERE id = ${row.target_id} AND org_id = ${actor.orgId} AND revoked_at IS NULL FOR UPDATE`,
            )
          ).rows[0];
          if (!client) throw new AppError('not_found', 'errors.notFound');
          if (client.secret_hash !== null && !client.secret_hash) throw secretNeeded();
          await query(
            db,
            sql`UPDATE ${ident(schemas.app, 'oauth_clients')} SET import_paused = false WHERE id = ${row.target_id}`,
          );
          break;
        }
        case 'source': {
          const source = (
            await query<SourceRow>(
              db,
              sql`SELECT * FROM ${ident(schemas.app, 'sources')}
              WHERE id = ${row.target_id} AND org_id = ${actor.orgId} FOR UPDATE`,
            )
          ).rows[0];
          if (!source) throw new AppError('not_found', 'errors.notFound');
          let connection: SourceConnection;
          try {
            connection = SourceConnection.parse(source.connection);
            checkSecrets(connection, await secretsFor(source, ctx.config.secretKey, db));
          } catch {
            throw secretNeeded();
          }
          checkFileAddress(connection, ctx.config);
          await checkFileHost(connection, ctx.config);
          checkApiAddress(connection, ctx.config);
          // An address that came without part of itself has to be entered again first.
          if (row.detail.connection !== undefined && canonical(source.connection) === row.detail.connection)
            throw secretNeeded();
          await query(
            db,
            sql`UPDATE ${ident(schemas.app, 'sources')} SET import_paused = false, import_note = NULL,
            updated_at = now() WHERE id = ${source.id}`,
          );
          // A webhook source takes posts only at an address made here, never one from before.
          if (source.kind === 'webhook')
            address = await newHookAddress(db, schemas, { id: source.id, orgId: actor.orgId });
          break;
        }
        case 'webhook': {
          const webhook = (
            await query<{ url: string }>(
              db,
              sql`SELECT url FROM ${ident(schemas.app, 'webhooks')}
              WHERE id = ${row.target_id} AND org_id = ${actor.orgId} FOR UPDATE`,
            )
          ).rows[0];
          if (!webhook) throw new AppError('not_found', 'errors.notFound');
          if (row.detail.url !== undefined && webhook.url === row.detail.url) throw secretNeeded();
          checkedUrl(webhook.url, ctx.config);
          await query(
            db,
            sql`UPDATE ${ident(schemas.app, 'webhooks')} SET enabled = true, disabled_reason = NULL,
            failing_since = NULL, updated_at = now() WHERE id = ${row.target_id}`,
          );
          break;
        }
        case 'publicLink':
        case 'publicForm': {
          if (row.kind === 'publicLink' && row.detail.hadPassword && !row.detail.passwordHash)
            throw new AppError('conflict', 'organizationArchive.review.passwordNeeded');
          const view = (
            await query<{ database_id: string }>(
              db,
              sql`SELECT t.database_id FROM ${ident(schemas.app, 'views')} v
              JOIN ${ident(schemas.app, 'tables')} t ON t.id = v.table_id
              JOIN ${ident(schemas.app, 'databases')} d ON d.id = t.database_id
              WHERE v.id = ${row.target_id} AND d.org_id = ${actor.orgId}
                AND v.trashed_at IS NULL AND t.trashed_at IS NULL AND d.trashed_at IS NULL`,
            )
          ).rows[0];
          if (!view) throw new AppError('not_found', 'errors.notFound');
          // A new address, shared by the owner, as sharing the view again would make.
          if (row.kind === 'publicLink')
            await query(
              db,
              sql`INSERT INTO ${ident(schemas.app, 'shared_views')}
              (id, org_id, database_id, view_id, settings, password_hash, created_by)
              VALUES (${newSharedViewId()}, ${actor.orgId}, ${view.database_id}, ${row.target_id},
                ${JSON.stringify(SharedViewSettings.parse(row.detail.settings ?? {}))}::jsonb,
                ${row.detail.passwordHash ?? null}, ${actor.userId})
              ON CONFLICT (view_id) WHERE stopped_at IS NULL DO NOTHING`,
            );
          else
            await query(
              db,
              sql`INSERT INTO ${ident(schemas.app, 'public_forms')} (id, org_id, database_id, view_id, created_by)
              VALUES (${newPublicFormId()}, ${actor.orgId}, ${view.database_id}, ${row.target_id}, ${actor.userId})
              ON CONFLICT (view_id) WHERE stopped_at IS NULL DO NOTHING`,
            );
          break;
        }
        case 'calendarFeeds':
          await query(
            db,
            sql`UPDATE ${ident(schemas.app, 'orgs')} SET calendar_feeds = true WHERE id = ${actor.orgId}`,
          );
          break;
        case 'feedback': {
          const token = (
            await query<{ token: string | null }>(
              db,
              sql`SELECT feedback_github_token AS token FROM ${ident(schemas.app, 'orgs')} WHERE id = ${actor.orgId}`,
            )
          ).rows[0]?.token;
          // A token counts only when it's one sealed here for this organization.
          try {
            if (
              !token ||
              !(await unsealCredential(
                ctx.config.secretKey,
                token,
                `feedback.github:${actor.orgId}`,
                actor.orgId,
                db,
              ))
            )
              throw secretNeeded();
          } catch {
            throw secretNeeded();
          }
          await query(
            db,
            sql`UPDATE ${ident(schemas.app, 'orgs')} SET feedback_github_enabled = true WHERE id = ${actor.orgId}`,
          );
          break;
        }
        case 'oauthApp':
          await query(
            db,
            sql`UPDATE ${ident(schemas.app, 'oauth_apps')} SET enabled = true, updated_at = statement_timestamp()
            WHERE org_id = ${actor.orgId} AND provider = ${row.target_id}`,
          );
          break;
      }
      return this.done(db, actor, row, 'organization.import.turnedOn');
    });
    return { item: visible(row), ...(address ? { address } : {}) };
  }
}
