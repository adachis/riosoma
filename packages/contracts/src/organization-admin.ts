import { LogoChange, OrganizationAppearance } from './branding.js';
import { z } from 'zod';
import { MemberCommand, ProfileUpdate, ChangeEmail, ConfirmEmail, type PersonalProfile } from './people.js';
import { UnitAdminUpdate, UnitPreset, type UnitPresetChange } from './org-units.js';
import {
  FileScannerSettings,
  FileSafetySettings,
  FileSettingsView,
  ScannerAddress,
  type FileScannerInfo,
  type FileScannerStatus,
} from './data/files.js';

const EventId = z.string().regex(/^[1-9][0-9]{0,18}$/);
export const AuditFilters = z
  .object({
    q: z.string().trim().max(200).optional(),
    person: z.string().trim().max(200).optional(),
    action: z.string().trim().max(200).optional(),
    resource: z.string().trim().max(200).optional(),
    from: z.iso.datetime({ offset: true }).optional(),
    to: z.iso.datetime({ offset: true }).optional(),
  })
  .refine((value) => !value.from || !value.to || Date.parse(value.from) <= Date.parse(value.to));
export type AuditFilters = z.infer<typeof AuditFilters>;
export const AuditQuery = AuditFilters.safeExtend({
  before: EventId.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
export type AuditQuery = z.infer<typeof AuditQuery>;
export const AuditExport = z.object({ filters: AuditFilters, format: z.enum(['csv', 'json']) }).strict();
export type AuditExport = z.infer<typeof AuditExport>;

export interface AuditEntry {
  id: string;
  sequence: string;
  actorId: string | null;
  actorName: string | null;
  action: string;
  resource: string | null;
  at: string;
  metadata: Record<string, unknown>;
  prevHash: string | null;
  hash: string;
}
export interface AuditPage {
  events: AuditEntry[];
  next: string | null;
}
export interface AuditIntegrity {
  checked: number;
  firstBreak: string | null;
}
export interface OrganizationPresetPreview {
  preset: z.infer<typeof UnitPreset>;
  revision: string;
  diff: UnitPresetChange[];
}

export const OrganizationCommand = z.discriminatedUnion('kind', [
  OrganizationAppearance.extend({ kind: z.literal('organization.appearance') }),
  LogoChange.extend({ kind: z.literal('organization.logo') }),
  ...MemberCommand.options,
  ChangeEmail.extend({ kind: z.literal('profile.email.request') }),
  ConfirmEmail.extend({ kind: z.literal('profile.email.confirm') }),
  ProfileUpdate.extend({ kind: z.literal('profile.update') }),
  FileSettingsView.extend({ kind: z.literal('organization.files') }),
  FileScannerSettings.extend({ kind: z.literal('organization.files.scanner') }),
  FileSafetySettings.extend({ kind: z.literal('organization.files.safety') }),
  z
    .object({
      kind: z.literal('organization.files.scanner.detect'),
      address: ScannerAddress.nullable().optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('organization.files.scanner.test'),
      address: ScannerAddress.nullable().optional(),
    })
    .strict(),
  UnitAdminUpdate.extend({ kind: z.literal('organization.roles'), userId: z.string().min(1).max(100) }),
  z
    .object({ kind: z.literal('organization.preset'), preset: UnitPreset, revision: z.string().length(64) })
    .strict(),
  z.object({ kind: z.literal('organization.undo'), eventId: EventId }).strict(),
  AuditExport.extend({ kind: z.literal('audit.export') }),
]);
export type OrganizationCommand = z.infer<typeof OrganizationCommand>;
export interface OrganizationCommandResult {
  eventId: string;
  undoable: boolean;
  profile?: PersonalProfile;
  fileSettings?: z.infer<typeof FileSettingsView>;
  fileScanner?: FileScannerInfo;
  fileSafety?: z.infer<typeof FileSafetySettings>;
  scannerStatus?: FileScannerStatus;
}
