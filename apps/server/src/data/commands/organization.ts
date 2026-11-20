import { refuseDemo } from '../../demo/boundary.js';
import type { OrganizationLogo, OrganizationAppearance } from '@riosoma/contracts';
import type { OrgSettings } from '@riosoma/contracts';
import { changeLogo, currentLogo, saveLogo, currentAppearance, changeAppearance } from '../branding/store.js';
import {
  AppError,
  FileScannerSettings,
  FileSafetySettings,
  OrganizationCommand,
  UNIT_ADMIN_ROLES,
  type OrganizationCommandResult,
  type FileScannerInfo,
  type FileScannerStatus,
  type FileSettingsView,
} from '@riosoma/contracts';
import { ident, query, sql, withTransaction, type Queryable } from '@riosoma/db';
import { confirmEmail, requestEmail, type EmailDelivery } from '../profile-email.js';
import { profileEmailMessage } from '../../mail/messages.js';
import { lockUnits } from '../../org-units/store.js';
import {
  changeKind,
  changeStatus,
  memberState,
  peopleChanged,
  profile as currentProfile,
  removePerson,
  saveProfile,
} from '../people.js';
import type { FastifyInstance } from 'fastify';
import type { Actor } from '../../http/policy.js';
import { parse } from '../../http/validate.js';
import { notify } from '../../notifications/produce.js';
import { dataStore } from '../context.js';
import { organizationChannel } from '../notify.js';
import { retry } from './transaction.js';
import {
  changeScannerSettings,
  fileSafetySettings,
  fileSettings,
  probeScanner,
  scannerSettings,
} from '../files/settings.js';
import { organizationAdmin } from '../../org-units/store.js';
import {
  currentPresetState,
  digest,
  lockOrganization,
  memberRoles,
  previewPreset,
  recordAdminEvent,
  savePresetState,
  saveRoles,
  scope,
  undoEvent,
  type AdminContext,
  type PresetState,
} from '../organization-admin/store.js';

/** Organization commands share one transaction for authorization, changes, audit, and delivery */
export async function runOrganizationCommand(
  app: FastifyInstance,
  actor: Actor,
  input: unknown,
  options: { db?: Queryable; ownershipVerified?: boolean; undoPerson?: string; profileUndo?: boolean } = {},
): Promise<OrganizationCommandResult> {
  refuseDemo(actor);
  const command = parse(OrganizationCommand, input);
  const { pool, schemas } = dataStore(app.ctx);
  const apply = async (db: Queryable) => {
    const c: AdminContext = { db, schemas, actor };
    await lockOrganization(c);
    if (command.kind.startsWith('people.') || command.kind === 'organization.undo')
      await lockUnits(db, actor.orgId);
    let metadata: Record<string, unknown>;
    let target: string | null = null;
    let recipient: string | null = null;
    let action: string = command.kind;
    let fileScanner: FileScannerInfo | undefined;
    let fileSafety: FileSafetySettings | undefined;
    let savedFiles: FileSettingsView | undefined;
    let scannerStatus: FileScannerStatus | undefined;
    let scannerError: string | undefined;
    let scannerChange = false;
    let profile: OrganizationCommandResult['profile'];
    let personChange = false;
    let profileChange = false;
    let profileUndoable = false;
    let emailDelivery: EmailDelivery | undefined;
    if (command.kind === 'organization.appearance') {
      metadata = await changeAppearance(c, app.ctx.config, command);
    } else if (command.kind === 'organization.logo') {
      metadata = await changeLogo(c, app.ctx.config, command);
    } else if (command.kind === 'profile.email.request') {
      emailDelivery = await requestEmail(c, app.ctx.config, Boolean(app.ctx.mailer), command.email);
      metadata = { email: command.email };
      target = actor.userId;
    } else if (command.kind === 'profile.email.confirm') {
      const changed = await confirmEmail(c, app.ctx.config, Boolean(app.ctx.mailer), command.token);
      emailDelivery = changed.delivery;
      metadata = { before: changed.before, after: changed.after };
      target = actor.userId;
      personChange = true;
      profileChange = true;
    } else if (command.kind === 'profile.update') {
      const saved = await saveProfile(c, app.ctx.config, Boolean(app.ctx.mailer), command);
      profile = saved.after;
      profileUndoable =
        saved.before.pictureUrl === saved.after.pictureUrl && saved.before.name !== saved.after.name;
      metadata = {
        before: { name: saved.before.name, pictureUrl: saved.before.pictureUrl },
        after: { name: saved.after.name, pictureUrl: saved.after.pictureUrl },
      };
      target = actor.userId;
      personChange = true;
      profileChange = true;
    } else if (command.kind === 'people.role' || command.kind === 'people.status') {
      const before =
        command.kind === 'people.role'
          ? await changeKind(c, command.userId, command.role)
          : await changeStatus(c, command.userId, command.deactivated);
      metadata = {
        before,
        after: await memberState(c, command.userId),
        ...(before.unitId ? { unitId: before.unitId } : {}),
      };
      target = command.userId;
      personChange = true;
    } else if (command.kind === 'people.remove') {
      const before = await removePerson(c, command.userId);
      action = 'people.account.removed';
      metadata = {
        userId: command.userId,
        userName: before.userName,
        externalId: before.externalId,
        ...(before.unitId ? { unitId: before.unitId } : {}),
      };
      target = command.userId;
      personChange = true;
    } else if (command.kind === 'people.transfer') {
      await scope(c).requireOrganizationAdmin('people', true);
      if (!options.ownershipVerified) throw new AppError('forbidden', 'people.guard.reauthenticate');
      if (command.userId === actor.userId) throw new AppError('conflict', 'people.guard.transferSelf');
      const before = await changeKind(c, command.userId, 'owner');
      await changeKind(c, actor.userId, 'member');
      metadata = { from: actor.userId, to: command.userId, before, undoable: false };
      target = command.userId;
      personChange = true;
      await peopleChanged(c, actor.userId);
    } else if (command.kind === 'organization.files.safety') {
      await scope(c).requireOrganizationAdmin('security');
      const before = await fileSafetySettings(db, schemas.app, actor.orgId);
      fileSafety = FileSafetySettings.parse({
        outsideFiles: command.outsideFiles,
        allowOutsideMacros: command.allowOutsideMacros,
      });
      await query(
        db,
        sql`UPDATE ${ident(schemas.app, 'orgs')}
        SET settings = jsonb_set(settings, '{fileSafety}', ${JSON.stringify(fileSafety)}::jsonb)
        WHERE id = ${actor.orgId}`,
      );
      metadata = { before, after: fileSafety };
      scannerChange = true;
    } else if (command.kind === 'organization.files.scanner') {
      const changed = await changeScannerSettings(
        c,
        app.ctx.config,
        FileScannerSettings.parse({
          enabled: command.enabled,
          address: command.address,
          oversizedPolicy: command.oversizedPolicy,
        }),
      );
      fileScanner = changed.info;
      scannerError = changed.error;
      scannerChange = true;
      action = scannerError ? 'organization.files.scanner.test' : 'organization.files.scanner.changed';
      metadata = scannerError
        ? { ...changed.info.status }
        : { before: changed.before, after: changed.info.settings };
    } else if (
      command.kind === 'organization.files.scanner.detect' ||
      command.kind === 'organization.files.scanner.test'
    ) {
      scannerStatus = await probeScanner(
        c,
        app.ctx.config,
        command.kind === 'organization.files.scanner.detect' ? 'detect' : 'test',
        command.address,
      );
      metadata = { ...scannerStatus };
      scannerChange = true;
    } else if (command.kind === 'organization.files') {
      await scope(c).requireOrganizationAdmin('security');
      const before = await fileSettings(db, schemas.app, actor.orgId);
      if (digest(before) !== command.revision) throw new AppError('conflict', 'errors.conflict');
      const after = { maxUploadBytes: command.maxUploadBytes };
      await query(
        db,
        sql`UPDATE ${ident(schemas.app, 'orgs')}
          SET settings = jsonb_set(settings, '{files}', ${JSON.stringify(after)}::jsonb)
          WHERE id = ${actor.orgId}`,
      );
      metadata = { before, after };
      savedFiles = { ...after, revision: digest(after) };
    } else if (command.kind === 'organization.roles') {
      const before = await memberRoles(c, command.userId, true);
      const after = [
        ...new Set([
          ...before.filter((role) => !(UNIT_ADMIN_ROLES as readonly string[]).includes(role)),
          ...command.roles,
        ]),
      ].sort();
      await saveRoles(c, command.userId, after);
      metadata = { before, after };
      target = recipient = command.userId;
    } else if (command.kind === 'organization.preset') {
      const preview = await previewPreset(c, command.preset, {
        sessionMaxDays: app.ctx.config.sessionMaxDays,
        sessionIdleDays: app.ctx.config.sessionIdleDays,
      });
      if (preview.revision !== command.revision) throw new AppError('conflict', 'errors.conflict');
      await savePresetState(c, preview.after);
      metadata = {
        before: preview.before,
        after: preview.after,
        preset: command.preset,
        diff: preview.diff,
      };
    } else if (command.kind === 'organization.undo') {
      const event = await undoEvent(c, command.eventId);
      if (
        (options.profileUndo && (event.action !== 'profile.update' || event.target !== actor.userId)) ||
        (options.undoPerson &&
          (event.target !== options.undoPerson || !['people.role', 'people.status'].includes(event.action)))
      )
        throw new AppError('not_found', 'errors.notFound');
      if (event.action === 'profile.update') {
        if (event.target !== actor.userId) throw new AppError('not_found', 'errors.notFound');
        const current = await currentProfile(c, app.ctx.config, Boolean(app.ctx.mailer));
        const before = event.metadata.before as { name: string; pictureUrl: string | null };
        const after = event.metadata.after as { name: string; pictureUrl: string | null };
        if (
          before.pictureUrl !== after.pictureUrl ||
          digest({ name: current.name, pictureUrl: current.pictureUrl }) !== digest(after)
        )
          throw new AppError('conflict', 'errors.conflict');
        profile = (
          await saveProfile(c, app.ctx.config, Boolean(app.ctx.mailer), {
            name: before.name,
            revision: current.revision,
          })
        ).after;
        target = actor.userId;
        personChange = true;
        profileChange = true;
      } else if (event.action === 'people.role' || event.action === 'people.status') {
        if (!event.target) throw new AppError('conflict', 'errors.conflict');
        await scope(c).requirePeoplePerson(event.target);
        const current = await memberState(c, event.target);
        if (digest(current) !== digest(event.metadata.after))
          throw new AppError('conflict', 'errors.conflict');
        const before = event.metadata.before as Awaited<ReturnType<typeof memberState>>;
        if (event.action === 'people.role') await changeKind(c, event.target, before.kind);
        else await changeStatus(c, event.target, before.deactivated);
        target = event.target;
        personChange = true;
      } else {
        await scope(c).requireOrganizationAdmin(
          ['organization.logo', 'organization.appearance'].includes(event.action) ? 'people' : 'security',
        );
        if (event.action === 'organization.appearance') {
          if (digest(await currentAppearance(c)) !== digest(event.metadata.after))
            throw new AppError('conflict', 'errors.conflict');
          await changeAppearance(
            c,
            app.ctx.config,
            event.metadata.before as OrganizationAppearance,
            event.metadata.previousThemes as Pick<OrgSettings, 'defaultTheme' | 'allowedThemes'> | undefined,
          );
        } else if (event.action === 'organization.logo') {
          const current = await currentLogo(db, schemas.app, actor.orgId);
          if (digest(current) !== digest(event.metadata.after))
            throw new AppError('conflict', 'errors.conflict');
          await saveLogo(db, schemas.app, actor.orgId, event.metadata.before as OrganizationLogo | null);
        } else if (event.action === 'organization.roles' && event.target) {
          const current = await memberRoles(c, event.target, true);
          if (digest(current) !== digest(event.metadata.after))
            throw new AppError('conflict', 'errors.conflict');
          const before = event.metadata.before as string[];
          await saveRoles(c, event.target, before);
          target = recipient = event.target;
        } else if (event.action === 'organization.files.scanner.changed') {
          const current = await scannerSettings(db, schemas.app, actor.orgId, app.ctx.config);
          if (digest(current) !== digest(event.metadata.after))
            throw new AppError('conflict', 'errors.conflict');
          const changed = await changeScannerSettings(
            c,
            app.ctx.config,
            FileScannerSettings.parse(event.metadata.before),
          );
          fileScanner = changed.info;
          scannerChange = true;
          if (changed.error) throw new AppError('unavailable', changed.error);
        } else {
          const current = await currentPresetState(c);
          if (digest(current) !== digest(event.metadata.after))
            throw new AppError('conflict', 'errors.conflict');
          await savePresetState(c, event.metadata.before as PresetState);
        }
      }
      metadata = {
        undoOf: command.eventId,
        before: event.metadata.after,
        after: event.metadata.before,
        ...(typeof event.metadata.unitId === 'string' ? { unitId: event.metadata.unitId } : {}),
      };
    } else {
      await scope(c).requireOrganizationAdmin('audit');
      metadata = { filters: command.filters, format: command.format };
    }
    const eventId = await recordAdminEvent(c, action, target, metadata);
    if (recipient)
      await notify(db, schemas, {
        orgId: actor.orgId,
        recipientId: recipient,
        actorId: actor.userId,
        kind: 'adminRolesChanged',
        subjectId: eventId,
        target: {},
      });
    if (personChange && target) {
      await peopleChanged(c, target, profileChange);
    } else if (command.kind === 'profile.email.request') {
      await query(
        db,
        sql`SELECT pg_notify(${organizationChannel(schemas)}, ${JSON.stringify({ orgId: actor.orgId, userId: actor.userId })})`,
      );
    } else if (scannerChange) {
      const candidates = await query<Pick<Actor, 'userId' | 'kind' | 'adminRoles'>>(
        db,
        sql`SELECT user_id AS "userId", kind, admin_roles AS "adminRoles"
          FROM ${ident(schemas.app, 'memberships')} WHERE org_id = ${actor.orgId}
            AND (kind = 'owner' OR cardinality(admin_roles) > 0)`,
      );
      for (const person of candidates.rows) {
        if (!organizationAdmin(person, 'security')) continue;
        await query(
          db,
          sql`SELECT pg_notify(${organizationChannel(schemas)}, ${JSON.stringify({ orgId: actor.orgId, userId: person.userId })})`,
        );
      }
    } else {
      await query(db, sql`SELECT pg_notify(${organizationChannel(schemas)}, ${actor.orgId})`);
    }
    return {
      eventId,
      emailDelivery,
      undoable:
        profileUndoable ||
        command.kind === 'organization.appearance' ||
        command.kind === 'organization.logo' ||
        command.kind === 'people.role' ||
        command.kind === 'people.status' ||
        command.kind === 'organization.roles' ||
        command.kind === 'organization.preset' ||
        (command.kind === 'organization.files.scanner' && !scannerError),
      ...(profile ? { profile } : {}),
      ...(fileScanner ? { fileScanner } : {}),
      ...(fileSafety ? { fileSafety } : {}),
      ...(savedFiles ? { fileSettings: savedFiles } : {}),
      ...(scannerStatus ? { scannerStatus } : {}),
      scannerError,
    };
  };
  const result = options.db ? await apply(options.db) : await retry(() => withTransaction(pool, apply));
  if (result.scannerError) throw new AppError('unavailable', result.scannerError);
  if (result.emailDelivery && app.ctx.mailer) {
    const delivery = result.emailDelivery;
    const link = delivery.token
      ? `${app.ctx.config.baseUrl?.replace(/\/+$/, '')}/settings/profile?emailToken=${encodeURIComponent(delivery.token)}`
      : undefined;
    await app.ctx.mailer.send(profileEmailMessage(delivery.to, link, delivery.newEmail));
  }
  const { scannerError: _scannerError, emailDelivery: _emailDelivery, ...response } = result;
  return response;
}
