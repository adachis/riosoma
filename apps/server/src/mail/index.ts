import nodemailer from 'nodemailer';
import type { RuntimeConfig } from '../config.js';
import { acsMailer } from './acs.js';
import { gmailMailer } from './gmail.js';
import { graphMailer } from './graph.js';
import type { MailTransportOptions } from './http.js';
import { relayMailer } from './relay.js';
import { sesMailer } from './ses.js';
import type { Mailer } from './types.js';

/**
 * The mailers email goes out through, all with the same one-method shape, so nothing that sends a
 * message knows or cares which service carried it.  `RIOSOMA_MAIL_TRANSPORT` chooses: SMTP, Amazon
 * SES, Azure Communication Services, Microsoft Graph, Gmail, or a relay of the operator's own.
 */

export type { MailAttachment, MailMessage, Mailer } from './types.js';
export type {
  AcsSettings,
  GmailSettings,
  GraphSettings,
  MailSettingValues,
  MailTransportKind,
  MailTransportSettings,
  RelaySettings,
  SesSettings,
} from './settings.js';
export { mailFailureFields, MailTransportError, TRANSPORT_NAMES } from './http.js';
export type { MailRequestOptions, MailTransportOptions } from './http.js';

/** The SMTP mailer, or null when a URL or a sender is missing, which turns email off. */
export function smtpMailer(config: RuntimeConfig): Mailer | null {
  if (!config.smtpUrl || !config.mailFrom) return null;
  const url = new URL(config.smtpUrl);
  const transport = nodemailer.createTransport(
    {
      host: url.hostname,
      port: Number(url.port || (url.protocol === 'smtps:' ? 465 : 587)),
      secure: url.protocol === 'smtps:',
      requireTLS: url.protocol === 'smtp:' && !config.smtpAllowPlaintext,
      tls: { rejectUnauthorized: true },
      auth: url.username
        ? { user: decodeURIComponent(url.username), pass: decodeURIComponent(url.password) }
        : undefined,
      logger: false,
      debug: false,
    },
    {
      from: config.mailFrom,
      disableFileAccess: true,
      disableUrlAccess: true,
    },
  );
  return {
    async send(message) {
      await transport.sendMail(message);
    },
  };
}

/**
 * The mailer the settings choose, or null when email is off.  Only SMTP can be off by omission: the
 * other transports were asked for by name, so a setting one of them needs was checked when the
 * settings were read, and the server stopped there if it was missing.
 */
export function mailerFrom(config: RuntimeConfig, options: MailTransportOptions = {}): Mailer | null {
  const mail = config.mail;
  if (!mail) return smtpMailer(config);
  switch (mail.kind) {
    case 'ses':
      return sesMailer(mail, options);
    case 'acs':
      return acsMailer(mail, options);
    case 'graph':
      return graphMailer(mail, options);
    case 'gmail':
      return gmailMailer(mail, options);
    case 'relay':
      return relayMailer(mail, options);
  }
}
