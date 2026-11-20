import { REPORT_ATTACHMENT_LIMIT, type ReportFormat } from '@riosoma/contracts';
import { reportLayoutHtml, summaryReportLayout, type ReportLayout } from './layout.js';
import type { MailAttachment, MailMessage } from '../mail/index.js';
import { escapeHtml, formatMessage, type MessageValue } from './messages.js';

/**
 * The report email: a subject naming the report and its view, a short summary with the record
 * count and the first records as a small table, the file, and a footer that names the schedule,
 * who set it up, and a link to stop receiving it.
 *
 * The copy is written as the app's other strings are, as messages with explicit IDs that the
 * catalog extraction collects, so the email translates with everything else.  Values from records
 * are escaped and never read as markup.
 */

interface Descriptor {
  id: string;
  message: string;
}

const FORM_CONFIRMATION_COPY = {
  subject: /*i18n*/ { id: 'forms.edit.email.subject', message: 'Response received: {form}' },
  body: /*i18n*/ {
    id: 'forms.edit.email.body',
    message: 'Your response to {form} was recorded.  Edit your response here: {link}',
  },
  expiry: /*i18n*/ {
    id: 'forms.edit.email.expiry',
    message: 'This private link expires on {date}.  Anyone with the link can edit your response.',
  },
};

export function formConfirmationEmail(
  to: string,
  title: string,
  url: string,
  expiresAt: string,
): MailMessage {
  const values = {
    form: title,
    link: { text: url, html: `<a href="${escapeHtml(url)}">${escapeHtml(url)}</a>` },
    date: new Intl.DateTimeFormat('en-US', { dateStyle: 'long', timeZone: 'UTC' }).format(
      new Date(expiresAt),
    ),
  };
  const copy = FORM_CONFIRMATION_COPY;
  const format = (descriptor: Descriptor, html: boolean) =>
    formatMessage(descriptor.message, values, { locale: 'en-US', html });
  return {
    to,
    subject: formatMessage(
      copy.subject.message,
      { form: title.replace(/[\r\n]/g, ' ').slice(0, 100) },
      { locale: 'en-US', html: false },
    ),
    text: [format(copy.body, false), format(copy.expiry, false)].join('\n\n'),
    html: `<p>${format(copy.body, true)}</p><p>${format(copy.expiry, true)}</p>`,
    headers: { 'Auto-Submitted': 'auto-generated' },
  };
}

export const ROUTINE_PERSON_COPY = /*i18n*/ {
  id: 'routines.changes.person',
  message: '{name} <{email}> [{id}]',
};

export const ROUTINE_ATTACHMENT_COPY = /*i18n*/ {
  id: 'routines.changes.attachment',
  message: '{name} ({size, plural, one {# byte} other {# bytes}}) [{id}]',
};

export const ROUTINE_CHOICE_COPY = /*i18n*/ {
  id: 'routines.changes.choice',
  message: '{name} [{id}]',
};

export const SIGNATURE_COPY = {
  invitation: /*i18n*/ { id: 'signatures.email.invitation', message: 'Please sign {document}' },
  reminder: /*i18n*/ { id: 'signatures.email.reminder', message: 'Reminder to sign {document}' },
  completed: /*i18n*/ { id: 'signatures.email.completed', message: 'Signed document: {document}' },
  failed: /*i18n*/ { id: 'signatures.email.failed', message: 'Signing stopped: {document}' },
  undelivered: /*i18n*/ {
    id: 'signatures.email.undelivered',
    message: 'Signing email not delivered: {document}',
  },
  link: /*i18n*/ { id: 'signatures.email.link', message: 'Review and sign: {link}' },
  due: /*i18n*/ { id: 'signatures.email.due', message: 'This signing link expires on {date}.' },
  attached: /*i18n*/ {
    id: 'signatures.email.attached',
    message: 'The signed PDF and its signing certificate are attached.',
  },
  download: /*i18n*/ {
    id: 'signatures.email.download',
    message:
      'The signed PDF is too large to attach.  Download it, with its signing certificate, within 30 days: {link}',
  },
  finalHash: /*i18n*/ {
    id: 'signatures.email.finalHash',
    message: 'The signed PDF’s SHA-256 is {hash}.  Compare it with the file to check that it hasn’t changed.',
  },
  failedBody: /*i18n*/ {
    id: 'signatures.email.failedBody',
    message:
      'Riosoma couldn’t finish {document} after its last signature, so the request has stopped and its signing links no longer work.  Open the record’s signature history, then send a new request.',
  },
  undeliveredBody: /*i18n*/ {
    id: 'signatures.email.undeliveredBody',
    message:
      'An email about {document} couldn’t be delivered after 10 tries.  The record’s signature history shows which person it was for.',
  },
  consent: /*i18n*/ {
    id: 'signatures.consent',
    message:
      'I agree to sign this document electronically.  I intend my electronic signature to have the same effect as my handwritten signature, and I consent to receive the signed document electronically.',
  },
  certificate: /*i18n*/ { id: 'signatures.certificate.title', message: 'Electronic signature certificate' },
  simple: /*i18n*/ {
    id: 'signatures.certificate.simple',
    message:
      'Simple electronic signatures with an audit trail, not qualified or certificate-based signatures.',
  },
  originalHash: /*i18n*/ {
    id: 'signatures.certificate.originalHash',
    message: 'Original document SHA-256',
  },
  hashNote: /*i18n*/ {
    id: 'signatures.certificate.hashNote',
    message:
      'The original document’s SHA-256 matches the source attachment on the record.  This signed file’s own SHA-256 appears in the completion email and in the record’s signature history, since adding it here would change the file.',
  },
  signer: /*i18n*/ { id: 'signatures.certificate.signer', message: 'Signer' },
  email: /*i18n*/ { id: 'signatures.certificate.email', message: 'Email' },
  time: /*i18n*/ { id: 'signatures.certificate.time', message: 'Signed at' },
  zone: /*i18n*/ { id: 'signatures.certificate.zone', message: 'Signer’s time zone' },
  address: /*i18n*/ { id: 'signatures.certificate.address', message: 'IP address' },
  browser: /*i18n*/ { id: 'signatures.certificate.browser', message: 'User agent' },
  consentRecorded: /*i18n*/ { id: 'signatures.certificate.consent', message: 'Electronic consent' },
  utc: /*i18n*/ { id: 'signatures.certificate.utc', message: '{time} UTC' },
  otherSigner: /*i18n*/ { id: 'signatures.preview.otherSigner', message: 'For {name}' },
  filename: /*i18n*/ { id: 'signatures.filename', message: '{name} - signed.pdf' },
} satisfies Record<string, Descriptor>;

export const REPORT_EMAIL_COPY = {
  subject: /*i18n*/ { id: 'reports.email.subject', message: '{report}: {view}' },
  intro: /*i18n*/ {
    id: 'reports.email.intro',
    message: '{report}, from the {view} view of {table}, as of {time}.',
  },
  count: /*i18n*/ {
    id: 'reports.email.count',
    message:
      '{count, plural, =0 {No records are in the view right now.} one {# record is in the view.} other {# records are in the view.}}',
  },
  firstRecords: /*i18n*/ {
    id: 'reports.email.firstRecords',
    message: 'The first {shown} are below.',
  },
  attached: /*i18n*/ {
    id: 'reports.email.attached',
    message: 'Every record is in the attached file, {file}.',
  },
  /** A Word document or deck stops at its limit, which the file itself says when it does. */
  attachedDocument: /*i18n*/ {
    id: 'reports.email.attachedDocument',
    message: 'The view is in the attached file, {file}.',
  },
  tooLarge: /*i18n*/ {
    id: 'reports.email.tooLarge',
    message:
      'The file came to more than {limit}, which is too large to attach.  Open the view to see every record: {link}',
  },
  open: /*i18n*/ { id: 'reports.email.open', message: 'Open the view in Riosoma: {link}' },
  footer: /*i18n*/ {
    id: 'reports.email.footer',
    message: 'You’re getting this because {owner} set up the scheduled report {report}.',
  },
  stop: /*i18n*/ { id: 'reports.email.stop', message: 'Stop receiving it: {link}' },
} satisfies Record<string, Descriptor>;

/** Characters of one summary cell before it's cut short */
const CELL_LENGTH = 120;

export interface ReportEmailInput {
  to: string;
  locale: string;
  timeZone: string;
  reportName: string;
  viewName: string;
  tableName: string;
  ownerName: string;
  sentAt: Date;
  format: ReportFormat;
  count: number;
  /** The summary's column headings, the view's first visible fields */
  columns: readonly string[];
  /** The summary's rows, each cell already worded as the app words it */
  rows: ReadonlyArray<readonly string[]>;
  layout?: ReportLayout;
  attachment: MailAttachment | null;
  /** The file was too large to attach, so the email links to the view instead */
  tooLarge: boolean;
  viewLink: string;
  /** The page that stops this recipient receiving it */
  stopLink: string;
  /** Where a mail app's own unsubscribe button posts */
  oneClickLink: string;
}

/** A language the runtime can write in, or American English. */
export function usableLocale(locale: string): string {
  try {
    return new Intl.NumberFormat(locale).resolvedOptions().locale;
  } catch {
    return 'en-US';
  }
}

/** One line, and short enough for a subject: names can be long, and can't break a header. */
function subjectPart(value: string): string {
  const line = value.replace(/\s+/g, ' ').trim();
  const characters = Array.from(line);
  return characters.length <= 60 ? line : `${characters.slice(0, 59).join('').trimEnd()}…`;
}

/** Group totals keep line breaks, and every summary cell stops at the same character limit. */
function cell(value: string, multiline = false): string {
  const line = value.replace(multiline ? /[^\S\n]+/g : /\s+/g, ' ').trim();
  const characters = Array.from(line);
  return characters.length <= CELL_LENGTH
    ? line
    : `${characters
        .slice(0, CELL_LENGTH - 1)
        .join('')
        .trimEnd()}…`;
}

function link(href: string): MessageValue {
  const safe = escapeHtml(href);
  return { html: `<a href="${safe}">${safe}</a>`, text: href };
}

export function reportEmail(input: ReportEmailInput): MailMessage {
  const locale = usableLocale(input.locale);
  const text = (descriptor: Descriptor, values: Record<string, MessageValue>) =>
    formatMessage(descriptor.message, values, { locale, html: false });
  const html = (descriptor: Descriptor, values: Record<string, MessageValue>) =>
    formatMessage(descriptor.message, values, { locale, html: true });
  const time = new Intl.DateTimeFormat(locale, {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: input.timeZone,
  }).format(input.sentAt);
  const names = { report: input.reportName, view: input.viewName, table: input.tableName, time };
  const limit = new Intl.NumberFormat(locale, { style: 'unit', unit: 'megabyte' }).format(
    REPORT_ATTACHMENT_LIMIT / 1024 / 1024,
  );
  const copy = REPORT_EMAIL_COPY;
  const paragraphs: Array<[Descriptor, Record<string, MessageValue>]> = [
    [copy.intro, names],
    [copy.count, { count: input.count }],
  ];
  const rows = input.rows.map((row) => row.map((value) => cell(value)));
  const table = input.columns.length > 0 && rows.length > 0;
  if (table && input.count > rows.length) paragraphs.push([copy.firstRecords, { shown: rows.length }]);
  const after: Array<[Descriptor, Record<string, MessageValue>]> = [];
  if (input.attachment)
    after.push([
      input.format === 'docx' || input.format === 'pptx' || input.format === 'pdf'
        ? copy.attachedDocument
        : copy.attached,
      { file: input.attachment.filename },
    ]);
  if (input.tooLarge) after.push([copy.tooLarge, { limit, link: link(input.viewLink) }]);
  else after.push([copy.open, { link: link(input.viewLink) }]);
  const footer: Array<[Descriptor, Record<string, MessageValue>]> = [
    [copy.footer, { owner: input.ownerName, report: input.reportName }],
    [copy.stop, { link: link(input.stopLink) }],
  ];

  const plainTable = table
    ? [input.columns.map((value) => cell(value)).join(' | '), ...rows.map((row) => row.join(' | '))].join(
        '\n',
      )
    : null;
  const summaryLayout = input.layout ? summaryReportLayout(input.layout) : undefined;
  const htmlTable = summaryLayout
    ? reportLayoutHtml({
        ...summaryLayout,
        columns: summaryLayout.columns.map((column) => ({ ...column, text: cell(column.text) })),
        rows: summaryLayout.rows.map((row) => ({
          ...row,
          cells: row.cells.map((value) => ({ ...value, text: cell(value.text, true) })),
        })),
      })
    : table
      ? `<table border="1" cellpadding="6" cellspacing="0"><thead><tr>${input.columns
          .map((column) => `<th align="left">${escapeHtml(cell(column))}</th>`)
          .join('')}</tr></thead><tbody>${rows
          .map((row) => `<tr>${row.map((value) => `<td>${escapeHtml(value)}</td>`).join('')}</tr>`)
          .join('')}</tbody></table>`
      : null;

  const textBody = [
    ...paragraphs.map(([descriptor, values]) => text(descriptor, values)),
    ...(plainTable ? [plainTable] : []),
    ...after.map(([descriptor, values]) => text(descriptor, values)),
    '--',
    ...footer.map(([descriptor, values]) => text(descriptor, values)),
  ].join('\n\n');
  const htmlBody = [
    ...paragraphs.map(([descriptor, values]) => `<p>${html(descriptor, values)}</p>`),
    ...(htmlTable ? [htmlTable] : []),
    ...after.map(([descriptor, values]) => `<p>${html(descriptor, values)}</p>`),
    '<hr>',
    ...footer.map(([descriptor, values]) => `<p><small>${html(descriptor, values)}</small></p>`),
  ].join('');
  return {
    to: input.to,
    subject: formatMessage(
      copy.subject.message,
      { report: subjectPart(input.reportName), view: subjectPart(input.viewName) },
      { locale, html: false },
    ),
    text: textBody,
    html: htmlBody,
    ...(input.attachment ? { attachments: [input.attachment] } : {}),
    headers: {
      // Mail apps offer their own button for this, which posts here without opening a page.
      'List-Unsubscribe': `<${input.oneClickLink}>`,
      'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
      'Auto-Submitted': 'auto-generated',
    },
  };
}

export const NOTIFICATION_COPY = {
  'notifications.ingest.held.reason': /*i18n*/ {
    id: 'notifications.ingest.held.reason',
    message: 'Open the table to review the reason.',
  },
  'notifications.kind.ingest.question': /*i18n*/ {
    id: 'notifications.kind.ingest.question',
    message: 'An ingest question is waiting',
  },
  'notifications.email.ingest.question.subject': /*i18n*/ {
    id: 'notifications.email.ingest.question.subject',
    message: 'An ingest question is waiting',
  },
  'notifications.email.ingest.question.body': /*i18n*/ {
    id: 'notifications.email.ingest.question.body',
    message: 'A question is waiting on {table}.',
  },
  'notifications.kind.ingest.file.read': /*i18n*/ {
    id: 'notifications.kind.ingest.file.read',
    message: 'An incoming file was read',
  },
  'notifications.email.ingest.file.read.subject': /*i18n*/ {
    id: 'notifications.email.ingest.file.read.subject',
    message: 'An incoming file was read',
  },
  'notifications.email.ingest.file.read.body': /*i18n*/ {
    id: 'notifications.email.ingest.file.read.body',
    message:
      'A file was read for {table}.  Added: {added}, updated: {updated}, identical: {identical}, flagged: {flagged}, and refused: {refused}.',
  },
  'notifications.kind.ingest.file.held': /*i18n*/ {
    id: 'notifications.kind.ingest.file.held',
    message: 'An incoming file is held',
  },
  'notifications.email.ingest.file.held.subject': /*i18n*/ {
    id: 'notifications.email.ingest.file.held.subject',
    message: 'An incoming file is held',
  },
  'notifications.email.ingest.file.held.body': /*i18n*/ {
    id: 'notifications.email.ingest.file.held.body',
    message: 'A file is held on {table}.  {reason}',
  },
  'notifications.kind.ingest.sender.unapproved': /*i18n*/ {
    id: 'notifications.kind.ingest.sender.unapproved',
    message: 'An incoming sender needs approval',
  },
  'notifications.email.ingest.sender.unapproved.subject': /*i18n*/ {
    id: 'notifications.email.ingest.sender.unapproved.subject',
    message: 'An incoming sender needs approval',
  },
  'notifications.email.ingest.sender.unapproved.body': /*i18n*/ {
    id: 'notifications.email.ingest.sender.unapproved.body',
    message: 'Mail arrived for {table} from a sender the table has not approved.',
  },
  'notifications.kind.ingest.format.needsApproval': /*i18n*/ {
    id: 'notifications.kind.ingest.format.needsApproval',
    message: 'Reading rules need approval',
  },
  'notifications.email.ingest.format.needsApproval.subject': /*i18n*/ {
    id: 'notifications.email.ingest.format.needsApproval.subject',
    message: 'Reading rules need approval',
  },
  'notifications.email.ingest.format.needsApproval.body': /*i18n*/ {
    id: 'notifications.email.ingest.format.needsApproval.body',
    message: 'Reading rules for {table} are waiting for someone with schema rights.',
  },
  'notifications.kind.ingest.paused': /*i18n*/ {
    id: 'notifications.kind.ingest.paused',
    message: 'File reading is paused',
  },
  'notifications.email.ingest.paused.subject': /*i18n*/ {
    id: 'notifications.email.ingest.paused.subject',
    message: 'File reading is paused',
  },
  'notifications.email.ingest.paused.body': /*i18n*/ {
    id: 'notifications.email.ingest.paused.body',
    message: 'File reading for {table} was paused because its owner lost access.',
  },

  'notifications.delivery.title': /*i18n*/ {
    id: 'notifications.delivery.title',
    message: 'Riosoma notification',
  },
  'notifications.delivery.body': /*i18n*/ {
    id: 'notifications.delivery.body',
    message: 'There is an unread notification waiting for you.',
  },
  'notifications.digest.title': /*i18n*/ { id: 'notifications.digest.title', message: 'Your Riosoma digest' },
  'notifications.digest.summary': /*i18n*/ {
    id: 'notifications.digest.summary',
    message: 'Unread notifications since your last digest',
  },
  'notifications.digest.group': /*i18n*/ { id: 'notifications.digest.group', message: '{kind}: {count}' },
  'notifications.phone.code': /*i18n*/ {
    id: 'notifications.phone.code',
    message: 'Your Riosoma verification code is {code}.  It expires in 10 minutes.',
  },
  'notifications.kind.adminRolesChanged': /*i18n*/ {
    id: 'notifications.kind.adminRolesChanged',
    message: 'Admin role changes',
  },
  'notifications.kind.mention': /*i18n*/ { id: 'notifications.kind.mention', message: 'Mentions' },
  'notifications.kind.share': /*i18n*/ { id: 'notifications.kind.share', message: 'Database shares' },
  'notifications.kind.automationStopped': /*i18n*/ {
    id: 'notifications.kind.automationStopped',
    message: 'Stopped automations',
  },
  'notifications.kind.automationFailed': /*i18n*/ {
    id: 'notifications.kind.automationFailed',
    message: 'Failed automations',
  },
  'notifications.kind.automationNotification': /*i18n*/ {
    id: 'notifications.kind.automationNotification',
    message: 'Automation notifications',
  },
  'notifications.kind.calendarEventKept': /*i18n*/ {
    id: 'notifications.kind.calendarEventKept',
    message: 'Calendar events kept after an undo',
  },
  'notifications.kind.syncFailed': /*i18n*/ { id: 'notifications.kind.syncFailed', message: 'Failed syncs' },
  'notifications.kind.syncHeld': /*i18n*/ {
    id: 'notifications.kind.syncHeld',
    message: 'Syncs awaiting confirmation',
  },
  'notifications.kind.reportStopped': /*i18n*/ {
    id: 'notifications.kind.reportStopped',
    message: 'Stopped reports',
  },
  'notifications.kind.feedbackReply': /*i18n*/ {
    id: 'notifications.kind.feedbackReply',
    message: 'Feedback replies',
  },
  'notifications.kind.fileScan': /*i18n*/ {
    id: 'notifications.kind.fileScan',
    message: 'Attachment scan alerts',
  },
  'notifications.kind.webhookFailed': /*i18n*/ {
    id: 'notifications.kind.webhookFailed',
    message: 'Failed webhook posts',
  },
  'notifications.kind.domainUnverified': /*i18n*/ {
    id: 'notifications.kind.domainUnverified',
    message: 'Single sign-on domain alerts',
  },
  'notifications.kind.customDomainUnverified': /*i18n*/ {
    id: 'notifications.kind.customDomainUnverified',
    message: 'Custom domain alerts',
  },
  'notifications.kind.routineReport': /*i18n*/ {
    id: 'notifications.kind.routineReport',
    message: 'Routine reports',
  },
  'notifications.kind.routineApproval': /*i18n*/ {
    id: 'notifications.kind.routineApproval',
    message: 'Routine approvals',
  },
  'notifications.kind.routinePaused': /*i18n*/ {
    id: 'notifications.kind.routinePaused',
    message: 'Paused routines',
  },
  'notifications.kind.securityEvent': /*i18n*/ {
    id: 'notifications.kind.securityEvent',
    message: 'Security alerts',
  },
  'notifications.kind.backupFailed': /*i18n*/ {
    id: 'notifications.kind.backupFailed',
    message: 'Failed backups',
  },
  'notifications.kind.credentialVaultUnavailable': /*i18n*/ {
    id: 'notifications.kind.credentialVaultUnavailable',
    message: 'Credential store alerts',
  },
  'notifications.kind.vaultUnavailable': /*i18n*/ {
    id: 'notifications.kind.vaultUnavailable',
    message: 'Notification vault alerts',
  },
  'notifications.kind.updateFailed': /*i18n*/ {
    id: 'notifications.kind.updateFailed',
    message: 'Failed updates',
  },
  'notifications.email.securityEvent.subject': /*i18n*/ {
    id: 'notifications.email.securityEvent.subject',
    message: 'Security alert',
  },
  'notifications.email.securityEvent.body': /*i18n*/ {
    id: 'notifications.email.securityEvent.body',
    message: 'A security event needs an administrator’s attention.',
  },
  'notifications.email.backupFailed.subject': /*i18n*/ {
    id: 'notifications.email.backupFailed.subject',
    message: 'A backup failed',
  },
  'notifications.email.backupFailed.body': /*i18n*/ {
    id: 'notifications.email.backupFailed.body',
    message: 'A backup could not finish.',
  },
  'notifications.email.updateFailed.subject': /*i18n*/ {
    id: 'notifications.email.updateFailed.subject',
    message: 'An update failed',
  },
  'notifications.email.updateFailed.body': /*i18n*/ {
    id: 'notifications.email.updateFailed.body',
    message: 'An update could not finish.',
  },
  'notifications.email.vaultUnavailable.subject': /*i18n*/ {
    id: 'notifications.email.vaultUnavailable.subject',
    message: 'A credential vault can’t be reached',
  },
  'notifications.email.vaultUnavailable.body': /*i18n*/ {
    id: 'notifications.email.vaultUnavailable.body',
    message:
      'The vault that holds your organization’s notification connections couldn’t be reached.  Slack, Teams, and text messages for that time weren’t sent, and each notification stays in the bell.  This alert goes to the owner and Integrations administrators, who can check those connections in the organization’s notification settings.',
  },
} as const;
