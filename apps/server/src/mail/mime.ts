import MailComposer from 'nodemailer/lib/mail-composer';
import type { MailMessage } from './types.js';

/**
 * The raw MIME for a message, built with the same composer the SMTP transport uses, so a message
 * looks the same whichever way it goes out: the same headers, the same folding of long and
 * non-ASCII lines, and the same base64 attachment parts.  The transports that send raw content
 * (Amazon SES, Microsoft Graph, and Gmail) base64-encode the bytes this returns.
 *
 * Nothing is read from a path or an address, since a message's parts come from memory only.
 */
export async function mimeMessage(message: MailMessage, from: string, now?: Date): Promise<Buffer> {
  const composer = new MailComposer({
    from,
    to: message.to,
    subject: message.subject,
    text: message.text,
    html: message.html,
    ...(now ? { date: now } : {}),
    ...(message.attachments?.length
      ? {
          attachments: message.attachments.map(({ filename, content, contentType }) => ({
            filename,
            content,
            contentType,
          })),
        }
      : {}),
    ...(message.headers ? { headers: message.headers } : {}),
    disableFileAccess: true,
    disableUrlAccess: true,
  });
  return await new Promise<Buffer>((resolve, reject) => {
    composer.compile().build((error, built) => (error ? reject(error) : resolve(built)));
  });
}
