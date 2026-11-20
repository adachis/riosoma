import { refuseDemo } from '../../demo/boundary.js';
import { notify } from '../../notifications/produce.js';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { AppError, CredentialCommand, type CredentialJob, type CredentialStatus } from '@riosoma/contracts';
import { ident, query, sql, withTransaction, type Queryable } from '@riosoma/db';
import type { AppContext } from '../../app.js';
import type { Actor } from '../../http/policy.js';
import { dataStore } from '../context.js';
import { AccessScope } from '../access.js';
import { seal, unseal } from '../../secrets.js';
import { localKey, unavailable } from '../../credentials/envelope.js';
import {
  CredentialService,
  type CredentialPolicy,
  type CredentialRepository,
} from '../../credentials/service.js';
import { credentialSlots, replaceSlot } from './inventory.js';

interface PolicyRow {
  profile: string;
  key_id: string;
  revision: string;
  failed_profiles: string[];
}
interface JobRow extends CredentialJob {
  org_id: string;
  previous: CredentialPolicy;
  target: CredentialPolicy;
  cursor: string;
}

export class CredentialStore implements CredentialRepository {
  readonly service: CredentialService;
  constructor(private readonly ctx: AppContext) {
    this.service = new CredentialService(
      ctx.config.secretKey,
      ctx.config.credentials ?? { profiles: [], cacheSeconds: 300 },
      this,
    );
  }

  private async policyRow(orgId: string, db: Queryable = dataStore(this.ctx).pool): Promise<PolicyRow> {
    const { schemas } = dataStore(this.ctx);
    return (
      (
        await query<PolicyRow>(
          db,
          sql`SELECT * FROM ${ident(schemas.app, 'credential_policies')} WHERE org_id = ${orgId}`,
        )
      ).rows[0] ?? { profile: 'database', key_id: 'instance', revision: '0', failed_profiles: [] }
    );
  }

  async policy(orgId: string, db?: Queryable): Promise<CredentialPolicy> {
    if (db) {
      const { schemas } = dataStore(this.ctx);
      // Keep the chosen policy stable until the caller persists the credential and commits
      await query(
        db,
        sql`SELECT pg_advisory_xact_lock_shared(hashtextextended(${`${schemas.app}:credentials:${orgId}`}, 0))`,
      );
    }
    const row = await this.policyRow(orgId, db);
    return { profile: row.profile, keyId: row.key_id };
  }

  async key(orgId: string, id: string, db?: Queryable) {
    const { pool, schemas } = dataStore(this.ctx);
    const row = (
      await query<{ wrapped: string }>(
        db ?? pool,
        sql`SELECT wrapped FROM ${ident(schemas.app, 'credential_keys')} WHERE org_id = ${orgId} AND id = ${id}`,
      )
    ).rows[0];
    if (!row) throw unavailable();
    return localKey(
      Buffer.from(
        unseal(this.ctx.config.secretKey, row.wrapped, JSON.stringify(['credential-key', orgId, id])),
        'base64',
      ),
      id,
    );
  }

  async replace(orgId: string, context: string, previous: string, next: string): Promise<void> {
    const { pool, schemas } = dataStore(this.ctx);
    await withTransaction(pool, async (db) => {
      const policy = await this.policy(orgId, db);
      // A first-read migration may have waited behind a policy change or a row lock
      next = await this.service.move(next, orgId, context, policy, db);
      const slots = await credentialSlots(db, schemas, orgId, '', 50, context);
      let migrated = 0;
      for (const slot of slots)
        if (slot.value === previous && (await replaceSlot(db, schemas, slot, next))) migrated++;
      if (migrated) await this.event(db, orgId, null, 'credentials.migrated', { count: migrated });
    });
  }

  async failed(orgId: string, profile: string): Promise<void> {
    const { pool, schemas } = dataStore(this.ctx);
    await withTransaction(pool, async (db) => {
      const result = await query(
        db,
        sql`INSERT INTO ${ident(schemas.app, 'credential_policies')} (org_id, failed_profiles) VALUES (${orgId}, ${[profile]}::text[])
        ON CONFLICT (org_id) DO UPDATE SET failed_profiles = array_append(${ident(schemas.app, 'credential_policies')}.failed_profiles, ${profile})
        WHERE NOT (${profile} = ANY(${ident(schemas.app, 'credential_policies')}.failed_profiles)) RETURNING org_id`,
      );
      if (result.rowCount) {
        await this.event(db, orgId, null, 'credentials.unavailable', { profile });
        const admins = await query<{ user_id: string }>(
          db,
          sql`SELECT user_id FROM ${ident(schemas.app, 'memberships')}
          WHERE org_id = ${orgId} AND (kind = 'owner' OR 'security' = ANY(admin_roles))`,
        );
        for (const admin of admins.rows)
          await notify(db, schemas, {
            orgId,
            recipientId: admin.user_id,
            kind: 'credentialVaultUnavailable',
            actorId: null,
            subjectId: profile,
            target: {},
          });
      }
    });
  }

  private async event(
    db: Queryable,
    orgId: string,
    actorId: string | null,
    action: string,
    metadata: unknown,
  ) {
    const { schemas } = dataStore(this.ctx);
    await query(
      db,
      sql`INSERT INTO ${ident(schemas.audit, 'events')} (org_id, actor_id, action, metadata) VALUES (${orgId}, ${actorId}, ${action}, ${JSON.stringify(metadata)}::jsonb)`,
    );
    await query(
      db,
      sql`SELECT pg_notify(${`${schemas.app}_credentials`.slice(0, 63)}, ${JSON.stringify({ orgId, action })})`,
    );
  }

  async status(actor: Actor): Promise<CredentialStatus> {
    const { pool, schemas } = dataStore(this.ctx);
    await new AccessScope(pool, schemas, actor).requireOrganizationAdmin('security');
    const row = await this.policyRow(actor.orgId);
    const jobs = (
      await query<CredentialJob>(
        pool,
        sql`SELECT id, kind, state, processed, error FROM ${ident(schemas.app, 'credential_jobs')} WHERE org_id = ${actor.orgId} ORDER BY created_at DESC, id LIMIT 20`,
      )
    ).rows;
    return {
      profile: row.profile,
      keyId: row.key_id,
      revision: Number(row.revision),
      failedProfiles: row.failed_profiles,
      cacheSeconds: this.service.settings.cacheSeconds,
      jobs,
      profiles: this.service.settings.profiles.map((profile) => ({
        id: profile.id,
        kind: profile.kind,
        wrapping:
          ('transit' in profile && Boolean(profile.transit)) || ('kms' in profile && Boolean(profile.kms)),
      })),
    };
  }

  async preview(actor: Actor, profile: string) {
    const status = await this.status(actor);
    this.checkProfile(profile);
    const { pool, schemas } = dataStore(this.ctx);
    let after = '',
      count = 0;
    for (;;) {
      const slots = await credentialSlots(pool, schemas, actor.orgId, after, 250);
      count += slots.length;
      if (slots.length < 250) break;
      after = slots.at(-1)!.cursor;
    }
    return { profile, count, revision: status.revision };
  }

  private checkProfile(profile: string) {
    if (profile !== 'database' && !this.service.settings.profiles.some((p) => p.id === profile))
      throw new AppError('validation_failed', 'credentials.profileMissing');
  }

  async command(actor: Actor, input: unknown): Promise<void> {
    refuseDemo(actor);
    const command = CredentialCommand.parse(input);
    const { pool, schemas } = dataStore(this.ctx);
    await withTransaction(pool, async (db) => {
      await new AccessScope(db, schemas, actor).requireOrganizationAdmin('security');
      await query(
        db,
        sql`SELECT pg_advisory_xact_lock(hashtextextended(${`${schemas.app}:credentials:${actor.orgId}`}, 0))`,
      );
      const duplicate = (
        await query<JobRow>(
          db,
          sql`SELECT * FROM ${ident(schemas.app, 'credential_jobs')} WHERE id = ${command.id}`,
        )
      ).rows[0];
      if (duplicate) {
        if (duplicate.org_id !== actor.orgId) throw new AppError('not_found', 'errors.notFound');
        return;
      }
      if (command.kind === 'resume') {
        const job = (
          await query<JobRow>(
            db,
            sql`SELECT * FROM ${ident(schemas.app, 'credential_jobs')} WHERE id = ${command.jobId} AND org_id = ${actor.orgId}`,
          )
        ).rows[0];
        const current = await this.policyRow(actor.orgId, db);
        if (!job || job.target.profile !== current.profile || job.target.keyId !== current.key_id)
          throw new AppError('conflict', 'credentials.previewChanged');
        const resumed = await query(
          db,
          sql`UPDATE ${ident(schemas.app, 'credential_jobs')} SET state = 'running', error = NULL WHERE id = ${command.jobId} AND org_id = ${actor.orgId} AND state = 'failed'`,
        );
        if (!resumed.rowCount) throw new AppError('conflict', 'errors.conflict');
        await this.event(db, actor.orgId, actor.userId, 'credentials.resumed', { jobId: command.jobId });
        return;
      }
      const active = await query(
        db,
        sql`SELECT 1 FROM ${ident(schemas.app, 'credential_jobs')} WHERE org_id = ${actor.orgId} AND state = 'running'`,
      );
      if (active.rowCount) throw new AppError('conflict', 'credentials.busy');
      const row = await this.policyRow(actor.orgId, db);
      if (Number(row.revision) !== command.revision)
        throw new AppError('conflict', 'credentials.previewChanged');
      const previous = { profile: row.profile, keyId: row.key_id };
      let target = { ...previous };
      if (command.kind === 'move') {
        this.checkProfile(command.profile);
        target.profile = command.profile;
      } else if (command.kind === 'undo') {
        const job = (
          await query<JobRow>(
            db,
            sql`SELECT * FROM ${ident(schemas.app, 'credential_jobs')} WHERE id = ${command.jobId} AND org_id = ${actor.orgId}`,
          )
        ).rows[0];
        if (!job || job.state !== 'finished') throw new AppError('conflict', 'errors.conflict');
        target = job.previous;
        this.checkProfile(target.profile);
      } else {
        const id = randomUUID();
        if (command.keyProfile) {
          this.checkProfile(command.keyProfile);
          target.keyId = `external:${command.keyProfile}:${id}`;
          await this.service.key(actor.orgId, target.keyId);
        } else {
          target.keyId = id;
          const key = randomBytes(32);
          const wrapped = seal(
            this.ctx.config.secretKey,
            key.toString('base64'),
            JSON.stringify(['credential-key', actor.orgId, id]),
          );
          key.fill(0);
          await query(
            db,
            sql`INSERT INTO ${ident(schemas.app, 'credential_keys')} (org_id, id, wrapped) VALUES (${actor.orgId}, ${id}, ${wrapped})`,
          );
        }
      }
      await query(
        db,
        sql`INSERT INTO ${ident(schemas.app, 'credential_policies')} (org_id, profile, key_id, revision) VALUES (${actor.orgId}, ${target.profile}, ${target.keyId}, 1)
        ON CONFLICT (org_id) DO UPDATE SET profile = EXCLUDED.profile, key_id = EXCLUDED.key_id, revision = ${ident(schemas.app, 'credential_policies')}.revision + 1, failed_profiles = '{}'`,
      );
      await this.startJob(db, command.id, actor.orgId, actor.userId, command.kind, previous, target);
    });
  }

  private async startJob(
    db: Queryable,
    id: string,
    orgId: string,
    actorId: string | null,
    kind: CredentialJob['kind'],
    previous: CredentialPolicy,
    target: CredentialPolicy,
  ) {
    const { schemas } = dataStore(this.ctx);
    await query(
      db,
      sql`INSERT INTO ${ident(schemas.app, 'credential_jobs')} (id, org_id, actor_id, kind, previous, target) VALUES (${id}, ${orgId}, ${actorId}, ${kind}, ${JSON.stringify(previous)}::jsonb, ${JSON.stringify(target)}::jsonb)`,
    );
    await this.event(db, orgId, actorId, `credentials.${kind}`, { jobId: id, previous, target });
  }

  async initialize(): Promise<void> {
    const { pool, schemas } = dataStore(this.ctx);
    const orgs = (await query<{ id: string }>(pool, sql`SELECT id FROM ${ident(schemas.app, 'orgs')}`)).rows;
    for (const org of orgs)
      await withTransaction(pool, async (db) => {
        await query(
          db,
          sql`SELECT pg_advisory_xact_lock(hashtextextended(${`${schemas.app}:credentials:${org.id}`}, 0))`,
        );
        const id = `migration:${org.id}`;
        const exists = await query(
          db,
          sql`SELECT 1 FROM ${ident(schemas.app, 'credential_jobs')} WHERE id = ${id} OR (org_id = ${org.id} AND state = 'running')`,
        );
        if (!exists.rowCount) {
          const target = await this.policy(org.id, db);
          await this.startJob(db, id, org.id, null, 'migrate', target, target);
        }
      });
  }

  async tick(): Promise<void> {
    const { pool, schemas } = dataStore(this.ctx);
    const jobs = (
      await query<JobRow>(
        pool,
        sql`SELECT * FROM ${ident(schemas.app, 'credential_jobs')} WHERE state = 'running' ORDER BY created_at LIMIT 10`,
      )
    ).rows;
    for (const job of jobs) {
      try {
        const slots = await credentialSlots(pool, schemas, job.org_id, job.cursor, 25);
        for (const slot of slots) {
          const next = await this.service.move(slot.value, job.org_id, slot.context, job.target);
          await withTransaction(pool, async (db) => {
            const locked = (
              await query<JobRow>(
                db,
                sql`SELECT * FROM ${ident(schemas.app, 'credential_jobs')} WHERE id = ${job.id} FOR UPDATE`,
              )
            ).rows[0]!;
            if (locked.state !== 'running' || locked.cursor >= slot.cursor) return;
            if (!(await replaceSlot(db, schemas, slot, next)))
              throw new AppError('conflict', 'credentials.previewChanged');
            await query(
              db,
              sql`UPDATE ${ident(schemas.app, 'credential_jobs')} SET cursor = ${slot.cursor}, processed = processed + 1, updated_at = statement_timestamp() WHERE id = ${job.id}`,
            );
          });
        }
        if (slots.length < 25)
          await withTransaction(pool, async (db) => {
            const updated = await query(
              db,
              sql`UPDATE ${ident(schemas.app, 'credential_jobs')} SET state = 'finished', updated_at = statement_timestamp() WHERE id = ${job.id} AND state = 'running'`,
            );
            if (updated.rowCount)
              await this.event(db, job.org_id, null, 'credentials.finished', { jobId: job.id });
          });
      } catch {
        await query(
          pool,
          sql`UPDATE ${ident(schemas.app, 'credential_jobs')} SET state = 'failed', error = 'credentials.unavailable', updated_at = statement_timestamp() WHERE id = ${job.id} AND state = 'running'`,
        );
        await this.failed(job.org_id, job.target.profile);
      }
    }
    if (!jobs.length) await this.startupRotation();
  }

  private async startupRotation() {
    const request = this.service.settings.rotateOnStartup;
    if (!request) return;
    const { pool, schemas } = dataStore(this.ctx);
    const orgs = (await query<{ id: string }>(pool, sql`SELECT id FROM ${ident(schemas.app, 'orgs')}`)).rows;
    for (const org of orgs)
      await withTransaction(pool, async (db) => {
        await query(
          db,
          sql`SELECT pg_advisory_xact_lock(hashtextextended(${`${schemas.app}:credentials:${org.id}`}, 0))`,
        );
        const id = `startup:${createHash('sha256')
          .update(JSON.stringify([org.id, request]))
          .digest('hex')}`;
        if (
          (
            await query(
              db,
              sql`SELECT 1 FROM ${ident(schemas.app, 'credential_jobs')} WHERE id = ${id} OR (org_id = ${org.id} AND state = 'running')`,
            )
          ).rowCount
        )
          return;
        const previous = await this.policy(org.id, db);
        const key = randomBytes(32);
        const wrapped = seal(
          this.ctx.config.secretKey,
          key.toString('base64'),
          JSON.stringify(['credential-key', org.id, id]),
        );
        key.fill(0);
        await query(
          db,
          sql`INSERT INTO ${ident(schemas.app, 'credential_keys')} (org_id, id, wrapped) VALUES (${org.id}, ${id}, ${wrapped})`,
        );
        await query(
          db,
          sql`INSERT INTO ${ident(schemas.app, 'credential_policies')} (org_id, key_id, revision) VALUES (${org.id}, ${id}, 1)
        ON CONFLICT (org_id) DO UPDATE SET key_id = EXCLUDED.key_id, revision = ${ident(schemas.app, 'credential_policies')}.revision + 1`,
        );
        await this.startJob(db, id, org.id, null, 'rotate', previous, { ...previous, keyId: id });
      });
  }
}
