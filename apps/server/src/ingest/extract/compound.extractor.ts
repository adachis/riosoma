import { outcome, type Extractor } from './types.js';

export interface CompoundFile {
  FullPaths: string[];
  FileIndex: Array<{ name: string; type: number; content?: Uint8Array }>;
}

export function isCompound(bytes: Buffer): boolean {
  return bytes.subarray(0, 8).equals(Buffer.from('d0cf11e0a1b11ae1', 'hex'));
}

const containers = new WeakMap<Buffer, CompoundFile | null>();

/** Stream names come from the container reader, so names appearing only in file content cannot claim it. */
export async function compoundFile(bytes: Buffer): Promise<CompoundFile | null> {
  if (!isCompound(bytes)) return null;
  if (!containers.has(bytes)) {
    try {
      const { CFB } = await import('xlsx');
      containers.set(bytes, CFB.read(bytes, { type: 'buffer' }) as CompoundFile);
    } catch {
      containers.set(bytes, null);
    }
  }
  return containers.get(bytes) ?? null;
}

/** Compound signatures and stream-name markers identify unsupported containers without parsing them. */
const extractor: Extractor = {
  priority: 100,
  claims: isCompound,
  async extract(bytes) {
    const marker = (name: string) => bytes.includes(Buffer.from(name, 'utf16le'));
    if (marker('EncryptedPackage') && marker('EncryptionInfo'))
      return outcome('needs-password', 'application/vnd.ms-office');
    if (marker('__properties_version1.0')) return outcome('unclaimed', 'application/vnd.ms-outlook');
    if (marker('Workbook') || marker('Book')) return outcome('unclaimed', 'application/vnd.ms-excel');
    return outcome('unclaimed', 'application/x-ole-storage');
  },
};
export default extractor;
