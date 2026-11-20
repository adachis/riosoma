import type { Attachment } from '../core/files.js';

/** Reject ambiguous paths before a URL parser or attachment server can normalize them. */
export function safeAttachmentPath(path: string): boolean {
  let decoded = path;
  for (let depth = 0; depth < 5; depth++) {
    if (
      /[\\?#]/.test(decoded) ||
      [...decoded].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)
    )
      return false;
    if (decoded.split('/').some((part) => part === '.' || part === '..')) return false;
    try {
      const next = decodeURIComponent(decoded);
      if (next === decoded) return true;
      decoded = next;
    } catch {
      return false;
    }
  }
  return false;
}

/** Keep credentials and redirects inside the attachment routes on the configured platform. */
export function platformAttachment(
  address: string,
  attachment: Attachment,
  namespace: (path: string) => boolean,
): Attachment {
  const blocked: Attachment = { ...attachment, url: '', headers: undefined, problem: 'blocked' };
  let initial: URL;
  const platform = new URL(address);
  try {
    // Check the unparsed path too, since parsing removes literal and escaped dot segments.
    const path = attachment.url.replace(/^https?:\/\/[^/]+/i, '').split(/[?#]/)[0]!;
    if (!safeAttachmentPath(path)) return blocked;
    initial = new URL(attachment.url);
  } catch {
    return blocked;
  }
  const prefix = platform.pathname.replace(/\/$/, '');
  const allowUrl = (url: URL) => {
    if (url.origin !== initial.origin || url.username || url.password) return false;
    if (!['http:', 'https:'].includes(url.protocol) || !safeAttachmentPath(url.pathname)) return false;
    if (url.origin !== platform.origin) return true;
    return url.pathname.startsWith(`${prefix}/`) && namespace(url.pathname.slice(prefix.length));
  };
  if (!allowUrl(initial)) return blocked;
  return {
    ...attachment,
    headers: initial.origin === platform.origin ? attachment.headers : undefined,
    allowUrl,
  };
}
