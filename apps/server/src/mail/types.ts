/**
 * The shape of a message every transport sends, and of the thing that sends it.  They live apart
 * from the transports so no transport has to reach through another to name them.
 */

export interface MailAttachment {
  filename: string;
  content: Buffer;
  contentType: string;
}

export interface MailMessage {
  to: string;
  subject: string;
  text: string;
  html: string;
  /** Files sent with the message, from memory only: the transport reads no paths or addresses */
  attachments?: MailAttachment[];
  /** Extra headers, such as a list's unsubscribe address */
  headers?: Record<string, string>;
}

export interface Mailer {
  send(message: MailMessage): Promise<void>;
}
