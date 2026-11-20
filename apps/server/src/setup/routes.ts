import type { FastifyInstance } from 'fastify';
import {
  AppError,
  CreateOwner,
  DatabaseProfile,
  newId,
  type DiagnosticReport,
  type SetupStatus,
} from '@riosoma/contracts';
import { connectDatabase, migrate, MigrationError, probeDatabase, withTransaction } from '@riosoma/db';
import { idleErrorLogger } from '../app.js';
import { clearEmailFailures } from '../auth/attempts.js';
import { auditEvent, authDatabase, lockKeys } from '../auth/database.js';
import { hashPassword } from '../auth/passwords.js';
import { createSession, findIdentity, sendSession } from '../auth/sessions.js';
import { storeDatabaseProfile, writeStored } from '../config.js';
import { parse } from '../http/validate.js';
import { startupFailure } from '../configuration-error.js';
import { MIGRATIONS } from '../migrations/index.js';

export async function setupRoutes(app: FastifyInstance): Promise<void> {
  const ctx = app.ctx;

  const status = (): SetupStatus => ({ stage: ctx.setup.stage, databaseManaged: ctx.config.databaseFromEnv });

  app.get('/api/setup/status', { config: { policy: { kind: 'public' } } }, async () => status());

  // Lets the wizard check a pasted token before showing the first step.
  app.post('/api/setup/unlock', { config: { policy: { kind: 'setup' } } }, async (_request, reply) => {
    return reply.status(204).send();
  });

  const ownerStepOpen = () => {
    if (ctx.setup.stage === 'ready') throw new AppError('conflict', 'setup.owner.alreadyCreated');
    if (ctx.setup.stage !== 'owner') throw new AppError('conflict', 'setup.database.required');
  };

  app.post(
    '/api/setup/owner',
    {
      config: { policy: { kind: 'setup' } },
      // Completed setup has already discarded its token; report the stage conflict first.
      onRequest: async () => ownerStepOpen(),
    },
    async (request, reply) => {
      const input = parse(CreateOwner, request.body);
      return ctx.setup.exclusive(async () => {
        ownerStepOpen();
        const { pool, app: schema, audit } = authDatabase(ctx);
        const session = await withTransaction(pool, async (db) => {
          await lockKeys(db, [`${schema}:setup:owner`]);
          const orgs = await db.query(`SELECT id FROM ${schema}.orgs LIMIT 1`);
          if (orgs.rowCount) return new AppError('conflict', 'setup.owner.alreadyCreated');
          const passwordHash = await hashPassword(input.password);
          const orgId = newId('org');
          const userId = newId('user');
          await db.query(`INSERT INTO ${schema}.orgs (id, name, settings) VALUES ($1, $2, $3)`, [
            orgId,
            input.orgName,
            JSON.stringify({ defaultTheme: { theme: 'nature', scheme: 'grove' } }),
          ]);
          await db.query(
            `INSERT INTO ${schema}.users (id, email, name, password_hash, locale, preferences)
             VALUES ($1, $2, $3, $4, $5, $6)`,
            [
              userId,
              input.email,
              input.name,
              passwordHash,
              input.locale ?? 'en-US',
              // A level chosen while setting up is the owner's own.  Left out, they follow the default.
              JSON.stringify(input.level ? { level: input.level } : {}),
            ],
          );
          await db.query(`INSERT INTO ${schema}.memberships (org_id, user_id, kind) VALUES ($1, $2, $3)`, [
            orgId,
            userId,
            'owner',
          ]);
          const identity = (await findIdentity(db, schema, userId))!;
          await clearEmailFailures(db, schema, identity.email);
          const created = await createSession(db, ctx, identity, request);
          await auditEvent(db, audit, 'setup.owner_created', identity);
          await auditEvent(db, audit, 'auth.sign_in', identity, { ip: request.ip, method: 'setup' });
          return created;
        });
        await ctx.setup.refresh(pool, ctx.config.database!.schemas.app);
        if (session instanceof AppError) throw session;
        if (!ctx.config.baseUrl) {
          // Emailed links need a trusted address, and a request's Host header isn't one.  This
          // request carries the setup token, so the address the owner used is the right one.
          ctx.config.baseUrl = `${request.protocol}://${request.host}`;
          writeStored(ctx.config.configDir, { baseUrl: ctx.config.baseUrl });
        }
        reply.header('cache-control', 'no-store');
        return sendSession(request, reply, session);
      });
    },
  );

  const databaseStepOpen = () => {
    if (ctx.config.databaseFromEnv) throw new AppError('conflict', 'setup.database.managedByEnvironment');
    if (ctx.setup.stage !== 'database') throw new AppError('conflict', 'setup.database.alreadyConfigured');
  };

  app.post('/api/setup/database/test', { config: { policy: { kind: 'setup' } } }, async (request) => {
    databaseStepOpen();
    const profile = parse(DatabaseProfile, request.body);
    const report: DiagnosticReport = await probeDatabase(profile, {
      queryTimeoutMs: ctx.config.dbQueryTimeoutMs,
    });
    return { report };
  });

  app.post('/api/setup/database', { config: { policy: { kind: 'setup' } } }, async (request) => {
    const profile = parse(DatabaseProfile, request.body);
    return ctx.setup.exclusive(async () => {
      databaseStepOpen();
      const report = await probeDatabase(profile, { queryTimeoutMs: ctx.config.dbQueryTimeoutMs });
      if (!report.ok) return { report, ...status() };

      const database = await connectDatabase(profile, {
        onIdleError: idleErrorLogger(app),
        queryTimeoutMs: ctx.config.dbQueryTimeoutMs,
      });
      const pool = database.pool;
      try {
        await migrate(pool, profile.schemas, MIGRATIONS);
      } catch (cause) {
        await database.close().catch(() => undefined);
        request.log.error(startupFailure(cause));
        // The request error handler may serialize a cause, so keep driver details out of it too.
        throw new AppError(
          'unavailable',
          cause instanceof MigrationError ? cause.messageKey : 'setup.database.migrateFailed',
        );
      }
      storeDatabaseProfile(ctx.config.configDir, ctx.config.secretKey, profile);
      ctx.config.database = profile;
      ctx.pool = pool;
      ctx.closeDatabase = database.close;
      await ctx.setup.refresh(pool, profile.schemas.app);
      request.log.info({ stage: ctx.setup.stage }, 'database configured by setup');
      return { report, ...status() };
    });
  });
}
