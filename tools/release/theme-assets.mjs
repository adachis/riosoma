import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { lstat, mkdir, open, readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createZstdCompress, createZstdDecompress } from 'node:zlib';

// Archives contain only assets, so extraction cannot replace a stylesheet, manifest, or script.
export function assetPath(path) {
  const parts = path.split('/');
  return (
    /^[a-z0-9-]+$/.test(parts[0]) &&
    parts[1] === 'assets' &&
    parts.length > 2 &&
    parts.every((part) => /^[A-Za-z0-9_. -]+$/.test(part) && part !== '.' && part !== '..')
  );
}

export async function sha256(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

export async function pack(source, output) {
  const files = [];
  async function visit(folder, prefix) {
    for (const entry of (await readdir(folder, { withFileTypes: true })).sort((a, b) =>
      a.name.localeCompare(b.name, 'en'),
    )) {
      const path = `${prefix}/${entry.name}`;
      if (entry.isDirectory()) await visit(join(folder, entry.name), path);
      else if (entry.isFile() && assetPath(path)) files.push(path);
      else throw new Error(`Unsupported asset: ${path}`);
    }
  }
  for (const theme of (await readdir(source, { withFileTypes: true })).sort((a, b) =>
    a.name.localeCompare(b.name, 'en'),
  )) {
    if (!theme.isDirectory() || !/^[a-z0-9-]+$/.test(theme.name)) continue;
    const assets = join(source, theme.name, 'assets');
    try {
      if (!(await lstat(assets)).isDirectory())
        throw new Error(`Unsupported assets directory: ${theme.name}`);
      await visit(assets, `${theme.name}/assets`);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  if (!files.length) throw new Error('No theme assets found');
  async function* archive() {
    for (const path of files) {
      const header = Buffer.alloc(512);
      let name = path;
      let prefix = '';
      if (Buffer.byteLength(name) > 100) {
        const split = path.lastIndexOf('/');
        name = path.slice(split + 1);
        prefix = path.slice(0, split);
      }
      if (Buffer.byteLength(name) > 100 || Buffer.byteLength(prefix) > 155)
        throw new Error(`Asset path too long: ${path}`);
      const size = (await lstat(join(source, path))).size;
      header.write(name, 0, 100);
      header.write('0000644\0', 100);
      header.write('0000000\0', 108);
      header.write('0000000\0', 116);
      header.write(`${size.toString(8).padStart(11, '0')}\0`, 124);
      header.write('00000000000\0', 136);
      header.fill(32, 148, 156);
      header.write('0', 156);
      header.write('ustar\0', 257);
      header.write('00', 263);
      header.write(prefix, 345, 155);
      const checksum = header.reduce((sum, byte) => sum + byte, 0);
      header.write(`${checksum.toString(8).padStart(6, '0')}\0 `, 148);
      yield header;
      yield* createReadStream(join(source, path));
      if (size % 512) yield Buffer.alloc(512 - (size % 512));
    }
    yield Buffer.alloc(1024);
  }
  await pipeline(Readable.from(archive()), createZstdCompress(), createWriteStream(output, { flags: 'wx' }));
}

export async function unpack(bundle, tarPath, destination) {
  await pipeline(
    createReadStream(bundle),
    createZstdDecompress(),
    createWriteStream(tarPath, { flags: 'wx' }),
  );
  const archive = await open(tarPath, 'r');
  let position = 0;
  let total = 0;
  let count = 0;
  const seen = new Set();
  try {
    while (true) {
      const header = Buffer.alloc(512);
      const read = await archive.read(header, 0, 512, position);
      if (read.bytesRead !== 512) throw new Error('Truncated asset archive');
      if (header.every((byte) => byte === 0)) break;
      const field = (offset, length) =>
        header
          .subarray(offset, offset + length)
          .toString()
          .split('\0')[0]
          .trim();
      const recorded = Number.parseInt(field(148, 8), 8);
      const checksum = header.reduce(
        (sum, byte, index) => sum + (index >= 148 && index < 156 ? 32 : byte),
        0,
      );
      if (checksum !== recorded || field(257, 6) !== 'ustar' || ![0, 48].includes(header[156]))
        throw new Error('Unsupported asset archive');
      const path = [field(345, 155), field(0, 100)].filter(Boolean).join('/');
      if (!assetPath(path) || seen.has(path)) throw new Error(`Invalid asset path: ${path}`);
      seen.add(path);
      const sizeField = field(124, 12);
      if (!/^[0-7]+$/.test(sizeField)) throw new Error('Invalid asset size');
      const size = Number.parseInt(sizeField, 8);
      total += size;
      if (total > 2 * 1024 ** 3 || ++count > 100_000)
        throw new Error('Asset archive exceeds extraction limits');
      position += 512;
      const target = join(destination, path);
      await mkdir(dirname(target), { recursive: true });
      if (size) {
        await pipeline(
          createReadStream(tarPath, { start: position, end: position + size - 1 }),
          createWriteStream(target, { flags: 'wx' }),
        );
        if ((await lstat(target)).size !== size) throw new Error('Truncated asset');
      } else {
        await (await open(target, 'wx')).close();
      }
      position += Math.ceil(size / 512) * 512;
    }
    if (!count) throw new Error('Empty asset archive');
  } finally {
    await archive.close();
  }
}
