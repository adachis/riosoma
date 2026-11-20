import type { MailMessage } from './index.js';

const messages = {
  'en-US': {
    'auth.reset.subject': 'Reset your Riosoma password',
    'auth.reset.introduction': 'Use this link to choose a new password for Riosoma.',
    'auth.reset.expiry': 'This link works once and expires in 30 minutes.  A newer request replaces it.',
    'auth.reset.contact': 'If you did not ask for this, contact your organization’s administrator.',
    'auth.reset.action': 'Choose a new password',
    'auth.reset.changedSubject': 'Your Riosoma password changed',
    'auth.reset.changedBody':
      'Your password changed, and earlier reset links no longer work.  If you did not make this change, contact your organization’s administrator right away.',
    'auth.reset.ssoSubject': 'Use your organization’s sign-in',
    'auth.reset.ssoBody':
      'Your organization manages your sign-in.  Open Riosoma and choose your organization’s sign-in.  Contact your organization’s administrator if you need help.',
    'profile.email.verify.subject': 'Confirm your new email address',
    'profile.email.verify.body':
      'Confirm this address for your Riosoma account using the link below.  It expires in 15 minutes and can be used once.  Your current address stays in use until you confirm.',
    'profile.email.changed.subject': 'Your Riosoma email address changed',
    'profile.email.changed.body':
      'Your Riosoma email address is now {email}.  If you did not make this change, contact your administrator.',
    'auth.link.subject': 'Sign in to Riosoma',
    'auth.link.introduction': 'Use this link to sign in to your Riosoma account.',
    'auth.link.expiry': 'This link expires in 15 minutes and can be used once.',
    'auth.link.ignore': 'If you did not ask for this email, you can ignore it.',
    'auth.link.action': 'Sign in',
    'org.invite.subject': 'You’re invited to {org} on Riosoma',
    'org.invite.body':
      '{inviter} invited you to join {org} on Riosoma.  Use this link to accept: {link}  It works for 7 days.  If you weren’t expecting this, you can ignore this email.',
    'org.invite.shareBody':
      '{inviter} shared {item} with you in {org} on Riosoma.  Create an account with this email address, or sign in through the organization’s single sign-on, to accept all your pending shares: {link}  It works for 7 days.  Access begins when you accept.',
  },
};

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]!;
  });
}

export function invitationMessage(
  to: string,
  locale: string,
  org: string,
  inviter: string,
  link: string,
  item?: string,
): MailMessage {
  const copy = Object.hasOwn(messages, locale)
    ? messages[locale as keyof typeof messages]
    : messages['en-US'];
  const values: Record<string, string> = { org, inviter, link, item: item ?? '' };
  const body = item === undefined ? copy['org.invite.body'] : copy['org.invite.shareBody'];
  const format = (template: string) =>
    template.replace(/\{(org|inviter|link|item)\}/g, (_, key: string) => values[key]!);
  const text = format(body);
  const html = body.replace(/\{(org|inviter|link|item)\}/g, (_, key: string) =>
    key === 'link' ? `<a href="${escapeHtml(link)}">${escapeHtml(link)}</a>` : escapeHtml(values[key]!),
  );
  return { to, subject: format(copy['org.invite.subject']), text, html: `<p>${html}</p>` };
}

export function signInMessage(to: string, locale: string, link: string): MailMessage {
  const copy = Object.hasOwn(messages, locale)
    ? messages[locale as keyof typeof messages]
    : messages['en-US'];
  const paragraphs = [copy['auth.link.introduction'], copy['auth.link.expiry'], copy['auth.link.ignore']];
  return {
    to,
    subject: copy['auth.link.subject'],
    text: [paragraphs[0], link, ...paragraphs.slice(1)].join('\n\n'),
    html: `<p>${escapeHtml(paragraphs[0]!)}</p><p><a href="${escapeHtml(link)}">${escapeHtml(copy['auth.link.action'])}</a></p>${paragraphs
      .slice(1)
      .map((text) => `<p>${escapeHtml(text)}</p>`)
      .join('')}`,
  };
}

function securityMessage(to: string, subject: string, paragraphs: string[], link?: string): MailMessage {
  return {
    to,
    subject,
    text: [...paragraphs, ...(link ? [link] : [])].join('\n\n'),
    html:
      paragraphs.map((paragraph) => `<p>${escapeHtml(paragraph)}</p>`).join('') +
      (link
        ? `<p><a href="${escapeHtml(link)}">${escapeHtml(messages['en-US']['auth.reset.action'])}</a></p>`
        : ''),
  };
}

export function passwordResetMessage(to: string, _locale: string, link: string): MailMessage {
  const copy = messages['en-US'];
  return securityMessage(
    to,
    copy['auth.reset.subject'],
    [copy['auth.reset.introduction'], copy['auth.reset.expiry'], copy['auth.reset.contact']],
    link,
  );
}

export function passwordChangedMessage(to: string, _locale: string): MailMessage {
  const copy = messages['en-US'];
  return securityMessage(to, copy['auth.reset.changedSubject'], [copy['auth.reset.changedBody']]);
}

export function passwordSsoMessage(to: string, _locale: string, base: string): MailMessage {
  const copy = messages['en-US'];
  const link = `${base.replace(/\/+$/, '')}/sign-in`;
  return {
    to,
    subject: copy['auth.reset.ssoSubject'],
    text: `${copy['auth.reset.ssoBody']}\n\n${link}`,
    html: `<p>${escapeHtml(copy['auth.reset.ssoBody'])}</p><p><a href="${escapeHtml(link)}">${escapeHtml(link)}</a></p>`,
  };
}

export function profileEmailMessage(to: string, link?: string, newEmail?: string): MailMessage {
  const copy = messages['en-US'];
  const text = link
    ? `${copy['profile.email.verify.body']}\n\n${link}`
    : copy['profile.email.changed.body'].replace('{email}', newEmail ?? '');
  return {
    to,
    subject: link ? copy['profile.email.verify.subject'] : copy['profile.email.changed.subject'],
    text,
    html: `<p>${escapeHtml(text)}</p>`,
  };
}
