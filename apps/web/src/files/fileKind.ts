import {
  faFile,
  faFileAudio,
  faFileExcel,
  faFileImage,
  faFileLines,
  faFilePdf,
  faFilePowerpoint,
  faFileVideo,
  faFileZipper,
} from '@fortawesome/free-solid-svg-icons';
import type { AttachmentMeta } from '@riosoma/contracts';

export function fileKind(file: Pick<AttachmentMeta, 'type' | 'name'>) {
  if (file.type.startsWith('image/')) return 'image';
  if (file.type.startsWith('audio/')) return 'audio';
  if (file.type.startsWith('video/')) return 'video';
  if (file.type === 'application/pdf') return 'pdf';
  if (file.type === 'text/plain') return 'text';
  if (/spreadsheet|excel|csv/.test(file.type) || /\.(xlsx?|ods|csv)$/i.test(file.name)) return 'spreadsheet';
  if (/presentation|powerpoint/.test(file.type) || /\.(pptx?|odp)$/i.test(file.name)) return 'presentation';
  if (/word|document|rtf/.test(file.type) || /\.(docx?|odt|rtf)$/i.test(file.name)) return 'document';
  if (/zip|compressed|archive|tar|gzip/.test(file.type) || /\.(zip|rar|7z|tar|gz|bz2|xz)$/i.test(file.name))
    return 'archive';
  return 'file';
}
export const fileIcons = {
  image: faFileImage,
  audio: faFileAudio,
  video: faFileVideo,
  pdf: faFilePdf,
  text: faFileLines,
  document: faFileLines,
  spreadsheet: faFileExcel,
  presentation: faFilePowerpoint,
  archive: faFileZipper,
  file: faFile,
};

export function fileSize(bytes: number, locale: string): string {
  const units = ['byte', 'kilobyte', 'megabyte', 'gigabyte', 'terabyte'] as const;
  const index = Math.min(units.length - 1, Math.max(0, Math.floor(Math.log10(bytes || 1) / 3)));
  return new Intl.NumberFormat(locale, {
    style: 'unit',
    unit: units[index],
    unitDisplay: 'short',
    maximumFractionDigits: index ? 1 : 0,
  }).format(bytes / 1000 ** index);
}
