import { createRequire } from 'node:module';
import type { AttachmentData, FieldsData } from '@kenjiuno/msgreader';
import type { ExtractedSource, SourcePart } from '@riosoma/ingest';
import { detectType } from '../../data/files/detect.js';
import { compoundFile } from './compound.extractor.js';
import { forwarded, isoDate } from './email.extractor.js';
import {
  ExtractionFailure,
  LIMITS,
  outcome,
  type ExtractionContext,
  type Extractor,
  type ExtractionResult,
} from './types.js';

interface Reader {
  getFileData(): FieldsData;
  getAttachment(attachment: FieldsData): AttachmentData;
}
const mediaType = 'application/vnd.ms-outlook';

async function readMessage(
  bytes: Buffer,
  context: ExtractionContext,
  budget: { parts: number; messages: number },
): Promise<ExtractedSource | ExtractionResult> {
  // The package uses a CommonJS default export, so loading it explicitly keeps source and built workers consistent.
  const Reader = (
    createRequire(import.meta.url)('@kenjiuno/msgreader') as {
      default: new (bytes: ArrayBuffer | DataView) => Reader;
    }
  ).default;
  const reader = new Reader(new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength));
  const fields = reader.getFileData();
  if (fields.error || fields.dataType !== 'msg') throw new ExtractionFailure('invalid');
  return adaptMessage(fields, reader, context, budget);
}

async function adaptMessage(
  fields: FieldsData,
  reader: Reader,
  context: ExtractionContext,
  budget: { parts: number; messages: number },
): Promise<ExtractedSource | ExtractionResult> {
  const protectedClass = /^(?:IPM\.Note\.SMIME$|IPM\.Note\.rpmsg(?:\.|$))/i.test(fields.messageClass ?? '');
  const protectedAttachment = fields.attachments?.some(
    (part) =>
      /^(?:message\.rpmsg|smime\.p7m)$/i.test(part.fileName ?? '') ||
      /^(?:application\/x-microsoft-rpmsg-message|application\/pkcs7-mime)$/i.test(part.attachMimeTag ?? ''),
  );
  if (protectedClass || protectedAttachment) return outcome('needs-password', mediaType);
  const [{ extractHtmlText }, { htmlTables }] = await Promise.all([
    import('../../data/library-text-parser.js'),
    import('./html.js'),
  ]);
  let html = fields.bodyHtml ?? '';
  if (!html && fields.html) {
    const encoding = fields.internetCodepage ?? fields.messageCodepage;
    let decoder: InstanceType<typeof TextDecoder>;
    try {
      decoder = new TextDecoder(encoding && encoding !== 65001 ? `windows-${encoding}` : 'utf-8');
    } catch {
      decoder = new TextDecoder('windows-1252');
    }
    html = decoder.decode(fields.html);
  }
  const bodyText = fields.body ?? extractHtmlText(html);
  const warnings: string[] = [];
  const parts: SourcePart[] = [];
  for (const attachment of fields.attachments ?? []) {
    if (++budget.parts > LIMITS.mimeParts) throw new ExtractionFailure('email-limit');
    const data = reader.getAttachment(attachment);
    const body = Buffer.from(data.content);
    const name = attachment.fileName ?? data.fileName ?? attachment.name ?? '';
    const nested = Boolean(
      attachment.innerMsgContent ||
      (await compoundFile(body))?.FullPaths.some((path) => /^[^/]+\/__properties_version1\.0$/.test(path)),
    );
    if (nested) {
      if (++budget.messages > LIMITS.nestedMessages) throw new ExtractionFailure('email-limit');
      const part: SourcePart = {
        name,
        bytes: body,
        mediaType,
        archiveDepth: context.archiveDepth,
        emailDepth: context.emailDepth + 1,
      };
      if (context.emailDepth < 1) {
        const nestedContext = { ...context, name, emailDepth: 1 };
        const result = attachment.innerMsgContentFields
          ? await adaptMessage(attachment.innerMsgContentFields, reader, nestedContext, budget)
          : await readMessage(body, nestedContext, budget);
        if (!('status' in result)) part.source = result;
        else if (result.status === 'needs-password') warnings.push(result.messageKey);
      } else warnings.push('ingest.extract.nestedMessage');
      parts.push(part);
    } else {
      const contentId = (attachment.pidContentId ?? '').replace(/^<|>$/g, '');
      parts.push({
        name,
        bytes: body,
        mediaType: detectType(body),
        inline: Boolean(contentId || attachment.attachmentHidden),
        ...(contentId ? { contentId } : {}),
        archiveDepth: context.archiveDepth,
        emailDepth: context.emailDepth,
      });
    }
  }
  if (!bodyText.trim() && !parts.length) warnings.push('ingest.extract.empty');
  const date = isoDate(fields.clientSubmitTime ?? fields.messageDeliveryTime ?? '');
  if (!date) warnings.push('ingest.extract.emailDate');
  const address = fields.senderSmtpAddress ?? fields.senderEmail ?? '';
  const from =
    fields.senderName && address ? `${fields.senderName} <${address}>` : fields.senderName || address;
  return {
    kind: 'email',
    name: context.name,
    parts,
    warnings,
    email: {
      from,
      subject: fields.subject ?? '',
      date,
      messageId: fields.messageId ?? '',
      bodyText,
      tables: htmlTables(html),
      ...forwarded(bodyText),
    },
  };
}

const extractor: Extractor = {
  priority: 110,
  async claims(bytes) {
    return Boolean(
      (await compoundFile(bytes))?.FullPaths.some((path) => /^[^/]+\/__properties_version1\.0$/.test(path)),
    );
  },
  async extract(bytes, context) {
    if (context.emailDepth > 1) return outcome('unclaimed', mediaType);
    const container = (await compoundFile(bytes))!;
    // The message library walks embedded storages eagerly, so bound their depth before it starts.
    if (
      container.FullPaths.some(
        (path) => path.split('/').filter((name) => name === '__substg1.0_3701000D').length > LIMITS.mimeDepth,
      )
    )
      throw new ExtractionFailure('email-limit');
    return readMessage(bytes, context, { parts: 0, messages: 0 });
  },
};
export default extractor;
