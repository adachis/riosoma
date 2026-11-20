import { AppError, FILE_LIMITS } from '@riosoma/contracts';

export const SNIFF_BYTES = 64 * 1024;

export function fileName(header: unknown): string {
  if (typeof header !== 'string') throw new AppError('validation_failed', 'data.file.name');
  let decoded: string;
  try {
    decoded = decodeURIComponent(header);
  } catch {
    throw new AppError('validation_failed', 'data.file.name');
  }
  const name = decoded
    .replace(/[\\/\p{Cc}\p{Cf}]/gu, '')
    .trim()
    .slice(0, FILE_LIMITS.nameLength)
    .replace(/[\uD800-\uDBFF]$/, '');
  if (!name || /^\.+$/.test(name)) throw new AppError('validation_failed', 'data.file.name');
  return name;
}

/** Only content signatures select an inline type; names and declared media types cannot do so. */
export function detectType(bytes: Buffer): string {
  const at = (text: string, offset = 0) =>
    bytes.subarray(offset, offset + text.length).toString('latin1') === text;
  const hex = (value: string) => bytes.subarray(0, value.length / 2).equals(Buffer.from(value, 'hex'));
  if (hex('89504e470d0a1a0a')) return 'image/png';
  if (hex('ffd8ff')) return 'image/jpeg';
  if (at('GIF87a') || at('GIF89a')) return 'image/gif';
  if (at('RIFF') && at('WEBP', 8)) return 'image/webp';
  if (at('BM')) return 'image/bmp';
  if (hex('49492a00') || hex('4d4d002a') || hex('49492b00') || hex('4d4d002b')) return 'image/tiff';
  if (at('%PDF-')) return 'application/pdf';
  // A file type box is at least its 16-byte header, a whole number of 4-byte brands, and short.
  // Text can't pass for one, since a length that small starts with bytes no text holds.
  const box = at('ftyp', 4) ? bytes.readUInt32BE(0) : 0;
  if (box >= 16 && box <= 2048 && box % 4 === 0) {
    const brands: string[] = [];
    const end = Math.min(bytes.length, box, 256);
    for (let i = 8; i + 4 <= end; i += 4) if (i !== 12) brands.push(bytes.toString('latin1', i, i + 4));
    if (brands.some((b) => ['avif', 'avis'].includes(b))) return 'image/avif';
    if (brands.some((b) => ['heic', 'heix', 'hevc', 'hevx', 'mif1', 'msf1'].includes(b))) return 'image/heic';
    if (brands.includes('qt  ')) return 'video/quicktime';
    return 'video/mp4';
  }
  if (at('moov', 4) || at('mdat', 4)) return 'video/quicktime';
  if (hex('1a45dfa3') && bytes.includes(Buffer.from('webm'))) return 'video/webm';
  if (at('ID3') || (bytes.length > 2 && bytes[0] === 0xff && (bytes[1]! & 0xe6) === 0xe2))
    return 'audio/mpeg';
  if (at('RIFF') && at('WAVE', 8)) return 'audio/wav';
  if (at('fLaC')) return 'audio/flac';
  if (at('FORM') && (at('AIFF', 8) || at('AIFC', 8))) return 'audio/aiff';
  if (at('MThd')) return 'audio/midi';
  if (bytes.length > 2 && bytes[0] === 0xff && (bytes[1]! & 0xf6) === 0xf0) return 'audio/aac';
  if (at('RIFF') && at('AVI ', 8)) return 'video/x-msvideo';
  if (hex('1a45dfa3') && bytes.includes(Buffer.from('matroska'))) return 'video/x-matroska';
  if (at('OggS')) return bytes.includes(Buffer.from('theora')) ? 'video/ogg' : 'audio/ogg';
  if (hex('504b0304') || hex('504b0506') || hex('504b0708')) {
    // Entry names in local ZIP headers distinguish Office containers without inflating user data.
    const names: string[] = [];
    for (let i = 0; i + 30 <= bytes.length; i++) {
      if (bytes.readUInt32LE(i) !== 0x04034b50) continue;
      const length = bytes.readUInt16LE(i + 26);
      if (i + 30 + length <= bytes.length) names.push(bytes.toString('utf8', i + 30, i + 30 + length));
    }
    if (names.some((n) => n.startsWith('word/')))
      return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
    if (names.some((n) => n.startsWith('xl/')))
      return 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
    if (names.some((n) => n.startsWith('ppt/')))
      return 'application/vnd.openxmlformats-officedocument.presentationml.presentation';
    return 'application/zip';
  }
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes, { stream: true });
  } catch {
    return 'application/octet-stream';
  }
  const trimmed = text.replace(/^\uFEFF/, '').trimStart();
  if (/^(?:<\?xml[^>]*>\s*)?(?:<!--[\s\S]*?-->\s*)*<svg(?:\s|>)/i.test(trimmed)) return 'image/svg+xml';
  const binary = [...text].some((char) => {
    const code = char.charCodeAt(0);
    return (code < 32 && code !== 9 && code !== 10 && code !== 13) || code === 127;
  });
  if (trimmed.startsWith('<') || binary) return 'application/octet-stream';
  return 'text/plain';
}

export function inlineType(type: string): boolean {
  return (
    (type.startsWith('image/') && type !== 'image/svg+xml') ||
    type === 'application/pdf' ||
    type.startsWith('audio/') ||
    type.startsWith('video/') ||
    type === 'text/plain'
  );
}

export function encodedName(name: string): string {
  return encodeURIComponent(name).replace(
    /['()*]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

export function disposition(type: string, name: string): string {
  const fallback = name.replace(/[^\x20-\x7E]|["\\]/g, '_');
  return `${inlineType(type) ? 'inline' : 'attachment'}; filename="${fallback}"; filename*=UTF-8''${encodedName(name)}`;
}
