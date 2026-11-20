import { installIngest, type IngestWorker } from './ingest/pipeline/index.js';
import { installDemoBoundary, installDemoResponses } from './demo/routes.js';
import { prepareDemo } from './demo/sessions.js';
import { governanceRoutes } from './data/governance-routes.js';
import { remoteToolRoutes } from './mcp-client/routes.js';
import { credentialRoutes } from './credentials/routes.js';
import { installNoSqlSources } from './sources/nosql.js';
import { registerDriverConnectors } from '@riosoma/connectors';
import { driverRoutes } from './drivers/routes.js';
import { serverSecrets } from './drivers/server-secrets.js';
import { unitRoutes } from './org-units/routes.js';
import { organizationAdminRoutes } from './data/organization-admin/routes.js';
import { installSiteProtection, installSiteResponses, sitePublicRoutes } from './sites/routes.js';
import { siteManagementRoutes } from './sites/manage.js';
import { authorizationRoutes } from './authorization/routes.js';
import {
  installCustomDomainClassification,
  installCustomDomainServing,
  installCustomDomainResponses,
} from './custom-domains/serving.js';
import { customDomainRoutes } from './custom-domains/routes.js';
import { installCustomDomainRechecks } from './custom-domains/store.js';
import { paymentRoutes, paymentWebhookRoutes } from './payments/routes.js';
import { installPaymentUpkeep, type PaymentUpkeep } from './payments/service.js';
import { sqlRoutes } from './sql/routes.js';
import { rioRoutes } from './ai/routes.js';
import { installAutomations, type AutomationEngine } from './automations/engine.js';
import { automationRoutes } from './automations/routes.js';
import { simulationRoutes } from './automations/simulate.js';
import { authenticateToken, tokenRoutes } from './auth/tokens.js';
import { apiV1Routes } from './api-v1/routes.js';
import { apiError } from './api-v1/messages.js';
import { airtableRoutes } from './airtable-api/routes.js';
import { notFound as airtableNotFound } from './airtable-api/errors.js';
import { mcpRoutes } from './mcp/routes.js';
import { mcpSettingsRoutes } from './mcp/settings.js';
import { installAirtableSources } from './sources/airtable.js';
import { installFeedSources } from './sources/feed.js';
import { inboundRoutes, webhookSourceRoutes } from './sources/inbound.js';
import { installInboundWriter, type InboundWriter } from './sources/inbound-writer.js';
import { installWebhookSources } from './sources/webhook.js';
import { installFileSources } from './sources/files.js';
import { installGoogleSheetsSources } from './sources/google-sheets.js';
import { installMicrosoftSources } from './sources/microsoft.js';
import { installAnalyticsSources } from './sources/analytics.js';
import {
  fixedLink,
  installConnectorService,
  type ConnectorServiceLink,
} from './sources/connector-service.js';
import { installRestSources } from './sources/rest.js';
import { sourceRoutes } from './sources/routes.js';
import { installSourceScheduler, type SourceScheduler } from './sources/scheduler.js';
import { trashRoutes } from './data/trash-routes.js';
import { joinRoutes } from './data/join-routes.js';
import { duplicateRoutes } from './data/dedupe/routes.js';
import { commentRoutes } from './data/comment-routes.js';
import { publicFormRoutes } from './data/public-form-routes.js';
import { publicSharingRoutes } from './data/public-sharing-routes.js';
import { sharedViewRoutes } from './data/shared-view-routes.js';
import { dashboardRoutes } from './data/dashboards/routes.js';
import { interfaceRoutes } from './data/interfaces/routes.js';
import { viewAggregateRoutes } from './data/view-aggregates/routes.js';
import { installTrashPurge } from './data/purge.js';
import { installNotifications, type NotificationDelivery } from './notifications/delivery.js';
import { notificationRoutes } from './notifications/routes.js';
import { reportRoutes } from './reports/routes.js';
import { feedbackRoutes } from './feedback/routes.js';
import { installReports, type ReportWorker } from './reports/worker.js';
import { outboundSyncRoutes } from './outbound-sync/routes.js';
import { installOutboundSync, type OutboundSyncWorker } from './outbound-sync/worker.js';
import { calendarFeedRoutes } from './calendar-feeds/routes.js';
import { bookingPageRoutes } from './bookings/routes.js';
import { signatureRoutes } from './signatures/routes.js';
import { GOOGLE_PICKER_HOSTS, googlePickerAllowed } from './oauth/apps.js';
import { oauthRoutes } from './oauth/routes.js';
import { aiFieldRoutes } from './ai-fields/routes.js';
import { updateRoutes } from './updates/routes.js';
import type { Updates } from './updates/service.js';
import type { Telemetry } from './telemetry/service.js';
import { installAiFields, type AiFieldWorker } from './ai-fields/worker.js';
import { routineRoutes } from './routines/routes.js';
import { installRoutines, type RoutineWorker } from './routines/worker.js';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { themesRoot } from './themes/catalog.js';
import Fastify, { type FastifyError, type FastifyInstance } from 'fastify';
import { installHttpShutdown } from './shutdown.js';
import cookie from '@fastify/cookie';
import helmet from '@fastify/helmet';
import fastifyStatic from '@fastify/static';
import type pg from 'pg';
import { AppError, FILE_LIMITS } from '@riosoma/contracts';
import { authRoutes } from './auth/routes.js';
import { levelRoutes } from './auth/levels.js';
import { ssoAdminRoutes } from './auth/sso/admin.js';
import { ssoRoutes } from './auth/sso/flow.js';
import { samlRoutes } from './auth/sso/saml-flow.js';
import { scimRoutes } from './auth/scim/routes.js';
import { scimAdminRoutes } from './auth/scim/admin.js';
import { installDomainRechecks } from './auth/scim/domains.js';
import { mfaRoutes } from './auth/mfa/routes.js';
import { fileRoutes } from './data/files/routes.js';
import { importRoutes } from './data/imports/routes.js';
import type { AirtableImporter } from './data/imports/airtable/importer.js';
import { airtableImportRoutes } from './data/imports/airtable/routes.js';
import type { PlatformImporter } from './data/imports/platforms/importer.js';
import { platformImportRoutes } from './data/imports/platforms/routes.js';
import type { DatabaseCopier } from './data/archives/copier.js';
import { archiveRoutes } from './data/archives/routes.js';
import { organizationArchiveRoutes } from './data/organization-archives/routes.js';
import type { OrganizationArchives } from './data/organization-archives/jobs.js';
import { readRoutes } from './data/read-routes.js';
import { dataRoutes } from './data/routes.js';
import { permissionRoutes } from './data/permissions/routes.js';
import type { DataServices } from './data/services.js';
import type { LiveReads } from './sources/live.js';
import { sessionResolver } from './auth/sessions.js';
import type { RuntimeConfig } from './config.js';
import { installPolicies, type SessionResolver } from './http/policy.js';
import { appConfigRoutes, fileStoreOrigins, mapOrigins } from './http/app-config.js';
import { sendShell } from './http/shell.js';
import { loggerOptions } from './logger.js';
import { mailerFrom, type Mailer } from './mail/index.js';
import { realtimeRoutes } from './realtime/routes.js';
import { setupRoutes } from './setup/routes.js';
import { sharingRoutes } from './sharing/routes.js';
import type { SetupState } from './setup/state.js';
import { isBuildAsset, isScript, STALE_ASSET_HEADER, STALE_ASSET_SCRIPT } from './stale-assets.js';
import { VERSION } from './version.js';
import { templateRoutes } from './templates/routes.js';
import { installWebhooks, type WebhookWorker } from './webhooks/worker.js';
import { webhookRoutes } from './webhooks/routes.js';

export interface AppContext {
  appPageHtml?: () => string;
  publicPageHtml?: () => string;
  config: RuntimeConfig;
  /** Null until a database is configured; setup swaps it in without a restart. */
  pool: pg.Pool | null;
  /** Closes the pool and anything it depends on, such as an SSH tunnel. */
  closeDatabase?: (() => Promise<void>) | null;
  setup: SetupState;
  sessions: SessionResolver;
  /** Response streams share the session revocation watcher with browser sockets. */
  watchSession?: (sessionId: string, end: () => void) => () => void;
  mailer?: Mailer | null;
  /** Set by the read routes once the data module is running */
  data?: DataServices;
  /**
   * How the server reaches the connector service.  Unset, it's at the address the settings name,
   * or on this machine's default port.
   */
  connectorService?: ConnectorServiceLink;
  /** Orders and pages of tables that read their source live, set with `data` */
  live?: LiveReads;
  /** The worker that runs automations, set once the app is built */
  automations?: AutomationEngine;
  /** The worker that emails notifications after their changes commit, set once the app is built */
  notifications?: NotificationDelivery;
  /** Wakes copied source tables after their command transaction commits. */
  sourceScheduler?: SourceScheduler;
  /** The worker that sends webhooks, set once the app is built */
  webhooks?: WebhookWorker;
  /** The worker that imports Airtable bases, set once the app is built */
  airtableImports?: AirtableImporter;
  /** The worker that imports bases from the other tools, set once the app is built */
  platformImports?: PlatformImporter;
  /** The worker that restores snapshots and duplicates databases, set once the app is built */
  databaseCopies?: DatabaseCopier;
  /** The worker that exports and imports whole organizations, set once the app is built */
  organizationArchives?: OrganizationArchives;
  /** The worker that sends scheduled reports, set once the app is built */
  reports?: ReportWorker;
  /** The worker that keeps views synced out to outside systems, set once the app is built */
  outboundSyncs?: OutboundSyncWorker;
  ingest?: IngestWorker;
  /** The worker that runs AI fields, set once the app is built */
  aiFields?: AiFieldWorker;
  /** The worker that runs routines, set once the app is built */
  routines?: RoutineWorker;
  /** The worker that writes webhook sources' posts to their tables, set once the app is built */
  inbound?: InboundWriter;
  /** Ends given-up payment holds at Stripe, set once the app is built */
  payments?: PaymentUpkeep;
  /** Update checks and one-click updates, set once the app is built */
  updates?: Updates;
  /** Anonymous usage counts, set once the app is built */
  telemetry?: Telemetry;
}

declare module 'fastify' {
  interface FastifyInstance {
    ctx: AppContext;
  }
}

function webRoot(config: RuntimeConfig): string | null {
  const candidates = [
    config.webDir,
    resolve(dirname(fileURLToPath(import.meta.url)), '../../web/dist'),
    resolve(process.cwd(), 'apps/web/dist'),
  ].filter((p): p is string => Boolean(p));
  return candidates.find((p) => existsSync(join(p, 'index.html'))) ?? null;
}

/** Logs a pooled connection that died while idle; the pool reconnects on its own. */
export function idleErrorLogger(app: FastifyInstance) {
  return (error: Error) =>
    app.log.warn({ code: (error as { code?: string }).code }, 'database connection dropped');
}

export { themesRoot };

function notFound(): AppError {
  return new AppError('not_found', 'errors.notFound');
}

/** A 404 in the shape each API answers with, or the app's own. */
function notFoundBody(url: string) {
  if (url.startsWith('/v0/')) return airtableNotFound().body();
  return url.startsWith('/api/v1/') ? apiError(notFound()) : notFound().toBody();
}

const PLAIN_HOST = /^[A-Za-z0-9.-]+(:\d{1,5})?$|^\[[0-9A-Fa-f:.]+\](:\d{1,5})?$/;

/** The realtime socket's origin for the CSP: from the base URL when set, else from a plain Host. */
function socketOrigin(baseUrl: string | undefined, host: string | undefined, scheme: 'ws:' | 'wss:'): string {
  if (baseUrl) {
    const origin = new URL(baseUrl);
    return `${origin.protocol === 'https:' ? 'wss:' : 'ws:'}//${origin.host}`;
  }
  return host && PLAIN_HOST.test(host) ? `${scheme}//${host}` : "'self'";
}

export async function buildApp(ctx: AppContext): Promise<FastifyInstance> {
  ctx.sessions = sessionResolver(ctx);
  if (ctx.pool) await prepareDemo(ctx);
  if (ctx.mailer === undefined) ctx.mailer = mailerFrom(ctx.config);
  const app = Fastify({
    logger: loggerOptions(ctx.config.logLevel, ctx.config.production),
    trustProxy: ctx.config.trustProxy,
    bodyLimit: 10 * 1024 * 1024,
    routerOptions: { maxParamLength: FILE_LIMITS.nameLength },
    genReqId: () => randomUUID(),
  });
  installHttpShutdown(app);
  app.decorate('ctx', ctx);
  // Many API clients label a bodiless DELETE as JSON.  Treat an empty JSON body as no body instead
  // of refusing the request, and keep Fastify's own parser, with its prototype-poisoning guards,
  // for everything else.
  const parseJson = app.getDefaultJsonParser('error', 'error');
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (request, body, done) => {
    if (body === '') {
      done(null, undefined);
      return;
    }
    parseJson(request, String(body), done);
  });
  if (ctx.config.smtpAllowPlaintext) {
    app.log.warn(
      { setting: 'RIOSOMA_SMTP_ALLOW_PLAINTEXT', messageKey: 'config.smtp.plaintextAllowed' },
      'SMTP plaintext delivery is enabled',
    );
  }

  // Map views reach the map style's host, and only it, for the style, tiles, fonts, and sprites.
  const maps = mapOrigins(ctx.config);
  // With signed downloads on, attachments load from the bucket or container itself.
  const stores = fileStoreOrigins(ctx.config);
  // Google's Picker loads its script and opens its frame from Google, but only while Google Drive
  // is offered.  Each directive's sources are one entry, so turning it off leaves no gap behind.
  const withPicker = (kind: keyof typeof GOOGLE_PICKER_HOSTS, base: readonly string[]) => () =>
    [...base, ...(googlePickerAllowed(ctx) ? GOOGLE_PICKER_HOSTS[kind] : [])].join(' ');
  await app.register(helmet, {
    contentSecurityPolicy: {
      useDefaults: false,
      directives: {
        requireTrustedTypesFor: ["'script'"],
        trustedTypes: ['rio-sanitizer', 'rio-html', 'rio-script-url'],
        defaultSrc: ["'self'"],
        scriptSrc: [withPicker('script', ["'self'"])],
        styleSrc: ["'self'"],
        imgSrc: [withPicker('img', ["'self'", 'data:', 'blob:', ...maps, ...stores])],
        mediaSrc: ["'self'", ...stores],
        fontSrc: ["'self'"],
        connectSrc: [
          "'self'",
          // Some browsers do not match WebSocket schemes against 'self', so name the socket's origin.
          // The Host header counts only when it's a plain host and port, so a crafted one can't add
          // to the policy; helmet passes the raw request, which doesn't know its scheme, so both
          // socket schemes are listed for that host.
          (request) =>
            [
              ...new Set([
                socketOrigin(ctx.config.baseUrl, request.headers.host, 'ws:'),
                socketOrigin(ctx.config.baseUrl, request.headers.host, 'wss:'),
              ]),
            ].join(' '),
          withPicker('connect', maps),
        ],
        workerSrc: ["'self'", 'blob:'],
        manifestSrc: ["'self'"],
        frameSrc: [withPicker('frame', ["'self'"]), 'blob:'],
        frameAncestors: ["'self'"],
        objectSrc: ["'none'"],
        baseUri: ["'none'"],
        formAction: ["'self'"],
      },
    },
    crossOriginEmbedderPolicy: false,
    strictTransportSecurity: ctx.config.production ? { maxAge: 31_536_000, includeSubDomains: true } : false,
    referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
  });
  await app.register(cookie, { secret: ctx.config.secretKey.toString('base64') });
  installSiteProtection(app);
  installCustomDomainClassification(app);
  installDemoBoundary(app);
  installCustomDomainServing(app);
  installCustomDomainResponses(app);
  installSiteResponses(app);
  installDemoResponses(app);

  installPolicies(app, {
    sessions: () => ctx.sessions,
    token: (request, scope) => authenticateToken(ctx, request, scope),
    verifySetupToken: (candidate) => ctx.setup.verify(candidate),
  });

  app.setErrorHandler((error: FastifyError, request, reply) => {
    // A refused streamed image still answers with the shared JSON error body.
    reply.type('application/json');
    const body = (e: AppError) => (request.url.startsWith('/api/v1/') ? apiError(e) : e.toBody(request.id));
    if (error instanceof AppError) {
      if (!error.userFault)
        request.log.error({ err: error.cause ?? error, code: error.code }, 'request failed');
      return reply.status(error.status).send(body(error));
    }
    if (error.validation) {
      const e = new AppError('validation_failed', 'errors.validationFailed');
      return reply.status(e.status).send(body(e));
    }
    const status = error.statusCode ?? 500;
    if (status === 413)
      return reply.status(413).send(body(new AppError('payload_too_large', 'errors.tooLarge')));
    if (status < 500)
      return reply.status(status).send(body(new AppError('bad_request', 'errors.badRequest')));
    request.log.error({ err: error }, 'unhandled error');
    return reply.status(500).send(body(new AppError('internal', 'errors.internal')));
  });

  // The sources whose drivers run in the connector service, registered before anything reads one.
  const connectorService = installConnectorService(app, ctx.connectorService ?? fixedLink(ctx.config));

  // Probes run every few seconds, so log them only when something goes wrong.  The connector service
  // is reported, not required: without it only the sources it runs stop working, so the server
  // stays live and ready.
  app.get('/healthz', { logLevel: 'warn' }, async () => ({
    status: 'ok',
    version: VERSION,
    connectors: await connectorService.health(),
  }));
  app.get('/readyz', { logLevel: 'warn' }, async (_request, reply) => {
    const connectors = await connectorService.health();
    if (!ctx.pool)
      return reply
        .status(503)
        .send({ status: 'setup_required', checks: { database: 'skipped', connectors } });
    try {
      await ctx.pool.query('SELECT 1');
      return { status: 'ready', checks: { database: 'ok', connectors } };
    } catch {
      return reply.status(503).send({ status: 'degraded', checks: { database: 'failing', connectors } });
    }
  });

  await app.register(setupRoutes);
  await app.register(appConfigRoutes);
  await app.register(authRoutes);
  await app.register(levelRoutes);
  await app.register(unitRoutes);
  await app.register(organizationAdminRoutes);
  await app.register(ssoRoutes);
  await app.register(samlRoutes);
  await app.register(ssoAdminRoutes);
  await app.register(scimRoutes);
  await app.register(scimAdminRoutes);
  await app.register(customDomainRoutes);
  await app.register(mfaRoutes);
  await app.register(tokenRoutes);
  await app.register(authorizationRoutes);
  await app.register(apiV1Routes);
  await app.register(airtableRoutes);
  await app.register(mcpRoutes);
  await app.register(mcpSettingsRoutes);
  await app.register(sharingRoutes);
  await app.register(dataRoutes);
  await app.register(permissionRoutes);
  await app.register(sourceRoutes);
  await app.register(driverRoutes);
  installFileSources(app);
  installRestSources(app);
  installNoSqlSources(app);
  installAnalyticsSources(app);
  registerDriverConnectors(app.ctx.config.driversDir, () => serverSecrets(app.ctx.config));
  installGoogleSheetsSources(app);
  installAirtableSources(app);
  installMicrosoftSources(app);
  installFeedSources(app);
  installWebhookSources(app);
  await app.register(webhookSourceRoutes);
  await app.register(inboundRoutes);
  installInboundWriter(app);
  installSourceScheduler(app);
  await app.register(trashRoutes);
  await app.register(joinRoutes);
  await app.register(duplicateRoutes);
  await app.register(commentRoutes);
  await app.register(publicFormRoutes);
  await app.register(publicSharingRoutes);
  await app.register(sharedViewRoutes);
  installTrashPurge(app);
  installDomainRechecks(app);
  installCustomDomainRechecks(app);
  installPaymentUpkeep(app);
  await app.register(templateRoutes);
  await app.register(governanceRoutes);
  await app.register(readRoutes);
  await app.register(sqlRoutes);
  await app.register(dashboardRoutes);
  await app.register(interfaceRoutes);
  await app.register(siteManagementRoutes);
  await app.register(sitePublicRoutes);
  await app.register(viewAggregateRoutes);
  await app.register(fileRoutes);
  await app.register(importRoutes);
  await app.register(airtableImportRoutes);
  await app.register(platformImportRoutes);
  await app.register(archiveRoutes);
  await app.register(organizationArchiveRoutes);
  await app.register(realtimeRoutes);
  await app.register(rioRoutes);
  await app.register(aiFieldRoutes);
  installAiFields(app);
  await app.register(routineRoutes);
  installRoutines(app);
  await app.register(automationRoutes);
  await app.register(simulationRoutes);
  installAutomations(app);
  await app.register(notificationRoutes);
  installNotifications(app);
  await app.register(webhookRoutes);
  installWebhooks(app);
  await app.register(reportRoutes);
  installReports(app);
  await app.register(outboundSyncRoutes);
  installOutboundSync(app);
  installIngest(app);
  await app.register(originalRoutes);
  await app.register(calendarFeedRoutes);
  await app.register(bookingPageRoutes);
  await app.register(paymentRoutes);
  await app.register(paymentWebhookRoutes);
  await app.register(signatureRoutes);
  await app.register(oauthRoutes);
  await app.register(feedbackRoutes);
  await app.register(updateRoutes);
  await app.register(credentialRoutes);
  await app.register(remoteToolRoutes);

  const themes = themesRoot(ctx.config);
  if (themes) {
    await app.register(fastifyStatic, {
      root: themes,
      prefix: '/themes/',
      decorateReply: false,
      index: false,
      cacheControl: false,
      // Stylesheets and manifests revalidate so a rebuilt theme shows up at once; fonts and
      // textures rarely change.
      setHeaders: (res, filePath) => {
        res.header('cache-control', /\.(css|json)$/.test(filePath) ? 'no-cache' : 'public, max-age=86400');
      },
    });
  }

  const root = webRoot(ctx.config);
  if (root) {
    ctx.appPageHtml = () => readFileSync(join(root, 'index.html'), 'utf8');
    ctx.publicPageHtml = () =>
      ctx.appPageHtml!().replace('<head>', '<head><meta name="rio-public-domain" content="true">');
    const assets = `${sep}assets${sep}`;
    await app.register(fastifyStatic, {
      root,
      prefix: '/',
      index: ['index.html'],
      // Send shell HTML as one string so its policy and body always describe the same read.
      allowedPath: (path) => path.replace(/^\//, '') !== 'index.html',
      // One registered read route covers assets and app links, so access inventories include them.
      wildcard: true,
      cacheControl: false,
      // Hashed build assets never change; everything else, the app shell above all, revalidates.
      setHeaders: (res, filePath) => {
        res.header(
          'cache-control',
          filePath.includes(assets) ? 'public, max-age=31536000, immutable' : 'no-cache',
        );
      },
    });
    app.setNotFoundHandler((request, reply) => {
      // Missing theme assets and discovery documents need a 404 so font fallbacks and probes work.
      if (
        (request.method !== 'GET' && request.method !== 'HEAD') ||
        ['/api/', '/v0/', '/.well-known/', '/sites/', '/themes/'].some((prefix) =>
          request.url.startsWith(prefix),
        )
      )
        return reply.status(404).send(notFoundBody(request.url));
      // A build file that is not here belonged to another version.  The app's page is never an
      // answer for one: a browser would take HTML for code, and the page asking would go blank.
      // A custom domain keeps its plain 404 below: its pages install no worker to wake.
      if (isBuildAsset(request.url) && !request.customDomain) {
        reply.header('cache-control', 'no-store').header(STALE_ASSET_HEADER, '1');
        if (isScript(request.url))
          return reply.type('text/javascript; charset=utf-8').send(STALE_ASSET_SCRIPT);
        return reply.status(404).send(notFoundBody(request.url));
      }
      // Every other path is a deep link into the app; the client router takes it from here.
      if (request.customDomain) {
        if (
          request.method !== 'GET' ||
          !/^\/(?:[fvb]\/[A-Za-z0-9]+|signatures|bookings\/cancel)(?:\?|$)/.test(request.url)
        )
          return reply.status(404).send(notFoundBody(request.url));
        return sendShell(reply, ctx.publicPageHtml!());
      }
      return sendShell(reply.header('cache-control', 'no-cache'), ctx.appPageHtml!());
    });
  } else {
    app.setNotFoundHandler((request, reply) => reply.status(404).send(notFoundBody(request.url)));
  }
  return app;
}
import { originalRoutes } from './ingest/originals/routes.js';
