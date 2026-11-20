import type { ExtractedSource, SourcePart } from '@riosoma/ingest';
import { decodeWords } from 'postal-mime';
import { detectType } from '../../data/files/detect.js';
import type { extractHtmlText } from '../../data/library-text-parser.js';
import type { htmlTables } from './html.js';
import { ExtractionFailure, LIMITS, outcome, type ExtractionContext, type Extractor } from './types.js';

interface HtmlReaders {
  extractHtmlText: typeof extractHtmlText;
  htmlTables: typeof htmlTables;
}

/** The aggregate bodies lose mixed-part order, so adaptation uses the library's decoded tree. */
interface MimeNode {
  childNodes: MimeNode[];
  contentType: { parsed: { value: string; params: Record<string, string> }; multipart: string | false };
  contentDisposition: { parsed: { value: string; params: Record<string, string> } };
  contentTransferEncoding: { encoding: string };
  contentId?: string;
  content: ArrayBuffer | null;
  getTextContent(): string;
}

export function isoDate(value: string): string {
  const time = Date.parse(value);
  return Number.isFinite(time) ? new Date(time).toISOString() : '';
}

export function forwarded(body: string): { originalFrom?: string; originalDate?: string } {
  const lines = body
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.replace(/^\s*>\s?/, '').trim());
  for (let at = 0; at < lines.length; at++) {
    const from = /^From:\s*(.+)$/i.exec(lines[at]!);
    if (!from) continue;
    let date = '',
      subject = false;
    for (const line of lines.slice(at + 1, at + 9)) {
      const match = /^(?:Date|Sent):\s*(.+)$/i.exec(line);
      if (match) date = isoDate(match[1]!);
      if (/^Subject:/i.test(line)) subject = true;
    }
    if (date && subject) return { originalFrom: from[1]!, originalDate: date };
  }
  return {};
}

async function readEmail(
  bytes: Buffer,
  context: ExtractionContext,
  budget: { parts: number; messages: number },
  readers: HtmlReaders,
): Promise<ExtractedSource> {
  if (budget.parts >= LIMITS.mimeParts) throw new ExtractionFailure('email-limit');
  const { default: PostalMime } = await import('postal-mime');
  const parser = new PostalMime({
    forceRfc822Attachments: true,
    maxRfc822NestingDepth: 0,
    maxNestingDepth: LIMITS.mimeDepth,
    maxPartCount: Math.max(0, LIMITS.mimeParts - budget.parts),
    maxHeadersSize: LIMITS.inputBytes,
    attachmentEncoding: 'arraybuffer',
  });
  let envelope;
  try {
    envelope = await parser.parse(bytes);
  } catch (error) {
    if (error instanceof Error && /^Maximum MIME (?:part count|nesting depth)/.test(error.message))
      throw new ExtractionFailure('email-limit');
    throw error;
  }
  const tree = parser as unknown as { root: MimeNode; currentNode: MimeNode };
  const last = tree.currentNode;
  // The library adds LF to an unterminated final line, but parts must retain their original bytes.
  if (
    bytes.at(-1) !== 0x0a &&
    last.content &&
    !['base64', 'quoted-printable'].includes(last.contentTransferEncoding.encoding)
  ) {
    const content = new Uint8Array(last.content);
    if (content.at(-1) === 0x0a) last.content = last.content.slice(0, -1);
  }
  const html: string[] = [],
    parts: SourcePart[] = [],
    warnings: string[] = [];
  type BodyPart = { text: string; plain: boolean };
  const visit = async (item: MimeNode): Promise<BodyPart[]> => {
    if (++budget.parts > LIMITS.mimeParts) throw new ExtractionFailure('email-limit');
    const content = item.contentType.parsed;
    const disposition = item.contentDisposition.parsed;
    if (item.contentType.multipart) {
      const bodies: BodyPart[][] = [];
      for (const child of item.childNodes) bodies.push(await visit(child));
      // Equivalent alternatives share one body position, while mixed parts stay in sender order.
      if (item.contentType.multipart === 'alternative')
        return (
          bodies.find((body) => body.some((part) => part.plain)) ?? bodies.find((body) => body.length) ?? []
        );
      return bodies.flat();
    }
    const body = Buffer.from(item.content ?? new ArrayBuffer(0));
    const name = decodeWords(disposition.params.filename ?? content.params.name ?? '');
    const contentId = (item.contentId ?? '').replace(/^<|>$/g, '');
    if (content.value === 'message/rfc822') {
      if (++budget.messages > LIMITS.nestedMessages) throw new ExtractionFailure('email-limit');
      const part: SourcePart = {
        name,
        bytes: body,
        mediaType: content.value,
        archiveDepth: context.archiveDepth,
        emailDepth: context.emailDepth + 1,
      };
      if (context.emailDepth < 1)
        part.source = await readEmail(body, { ...context, name, emailDepth: 1 }, budget, readers);
      else warnings.push('ingest.extract.nestedMessage');
      parts.push(part);
    } else if (
      disposition.value === 'attachment' ||
      name ||
      contentId ||
      !['text/plain', 'text/html'].includes(content.value)
    ) {
      parts.push({
        name,
        bytes: body,
        mediaType: detectType(body),
        inline: disposition.value === 'inline' || Boolean(contentId),
        ...(contentId ? { contentId } : {}),
        archiveDepth: context.archiveDepth,
        emailDepth: context.emailDepth,
      });
    } else {
      if (content.params.charset) {
        try {
          new TextDecoder(content.params.charset);
        } catch {
          // A declared but unknown encoding gets a deterministic single-byte fallback.
          content.params.charset = 'windows-1252';
          if (!warnings.includes('ingest.extract.emailCharset')) warnings.push('ingest.extract.emailCharset');
        }
      }
      const text = item.getTextContent();
      if (content.value === 'text/html') {
        html.push(text);
        return [{ text: readers.extractHtmlText(text), plain: false }];
      }
      return [{ text, plain: true }];
    }
    return [];
  };
  // The installed library exposes the tree at runtime, while its public declarations omit it.
  const bodyText = (await visit(tree.root)).map((part) => part.text).join('\n');
  if (!bodyText.trim() && !parts.length) warnings.push('ingest.extract.empty');
  const date = isoDate(envelope.date ?? '');
  if (!date) warnings.push('ingest.extract.emailDate');
  return {
    kind: 'email',
    name: context.name,
    parts,
    warnings,
    email: {
      from: decodeWords(envelope.headers.find((entry) => entry.key === 'from')?.value ?? ''),
      subject: envelope.subject ?? '',
      date,
      messageId: envelope.messageId ?? '',
      bodyText,
      tables: html.flatMap(readers.htmlTables),
      ...forwarded(bodyText),
    },
  };
}

const extractor: Extractor = {
  priority: 50,
  claims(bytes) {
    // Recognition only checks for an envelope before the first blank line, even if another line is malformed.
    const prefix =
      bytes
        .subarray(0, 65536)
        .toString('latin1')
        .split(/\r?\n\r?\n/, 1)[0] ?? '';
    return /^from:/im.test(prefix) && /^(?:subject|date|message-id|mime-version):/im.test(prefix);
  },
  async extract(bytes, context) {
    if (context.emailDepth > 1) return outcome('unclaimed', 'message/rfc822');
    const [{ extractHtmlText }, { htmlTables }] = await Promise.all([
      import('../../data/library-text-parser.js'),
      import('./html.js'),
    ]);
    return readEmail(bytes, context, { parts: 0, messages: 0 }, { extractHtmlText, htmlTables });
  },
};
export default extractor;
