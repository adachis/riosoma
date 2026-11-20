import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { crc32, deflateRawSync, gzipSync } from 'node:zlib';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  catalogHash,
  connectorFor,
  installedDriver,
  installedDriverUrl,
  licenseHash,
  type DriverDefinition,
  type SourceRow,
} from '@riosoma/connectors';
import { SourceConnection } from '@riosoma/contracts';
import { STARTED } from '../shared/processes.js';
import { extractAddon, MAX_DRIVER_BYTES, unpackDriver } from './archive.js';
import { DriverInstaller, LOCK_STALE_MS, type InstallerOptions } from './installer.js';

const directories: string[] = [];
afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

function archive(
  files: Array<{ name: string; body?: string | Buffer; kind?: string; link?: string }>,
): Buffer {
  const parts: Buffer[] = [];
  for (const file of files) {
    const body = Buffer.from(file.body ?? '');
    const header = Buffer.alloc(512);
    header.write(file.name);
    header.write('0000600\0', 100);
    header.write(body.length.toString(8).padStart(11, '0') + '\0', 124);
    header.fill(32, 148, 156);
    header.write(file.kind ?? '0', 156);
    if (file.link) header.write(file.link, 157);
    header.write('ustar\0', 257);
    const checksum = header.reduce((sum, value) => sum + value, 0);
    header.write(checksum.toString(8).padStart(6, '0') + '\0 ', 148);
    parts.push(header, body, Buffer.alloc((512 - (body.length % 512)) % 512));
  }
  return gzipSync(Buffer.concat([...parts, Buffer.alloc(1024)]));
}
const integrity = (bytes: Buffer) => `sha512-${createHash('sha512').update(bytes).digest('base64')}`;
const sha256 = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest();

/** One extended header record, whose length counts its own digits */
function paxRecord(key: string, value: string): string {
  const rest = ` ${key}=${value}\n`;
  let length = rest.length + 1;
  while (`${length}${rest}`.length !== length) length += 1;
  return `${length}${rest}`;
}

/** A zip the way package builds ship one, with deflated entries unless an entry says it's stored */
function zip(files: Array<{ name: string; body: string; stored?: boolean; flags?: number }>): Buffer {
  const locals: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const file of files) {
    const body = Buffer.from(file.body);
    const packed = file.stored ? body : deflateRawSync(body);
    const name = Buffer.from(file.name);
    const method = file.stored ? 0 : 8;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(file.flags ?? 0, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc32(body), 14);
    local.writeUInt32LE(packed.length, 18);
    local.writeUInt32LE(body.length, 22);
    local.writeUInt16LE(name.length, 26);
    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE(20, 4);
    entry.writeUInt16LE(20, 6);
    entry.writeUInt16LE(file.flags ?? 0, 8);
    entry.writeUInt16LE(method, 10);
    entry.writeUInt32LE(crc32(body), 16);
    entry.writeUInt32LE(packed.length, 20);
    entry.writeUInt32LE(body.length, 24);
    entry.writeUInt16LE(name.length, 28);
    entry.writeUInt32LE(offset, 42);
    locals.push(local, name, packed);
    central.push(entry, name);
    offset += 30 + name.length + packed.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

async function fixture(
  options: InstallerOptions = {},
  files: Record<string, string> = { 'package/lib/index.js': 'module.exports = { verified: true }' },
) {
  const directory = await mkdtemp(join(tmpdir(), 'drivers-install-'));
  directories.push(directory);
  const bytes = archive([
    {
      name: 'package/package.json',
      body: JSON.stringify({
        name: 'teradatasql',
        version: '1.0.0',
        scripts: { install: 'exit 81', postinstall: 'exit 82' },
      }),
    },
    ...Object.entries(files).map(([name, body]) => ({ name, body })),
  ]);
  const definition: DriverDefinition = {
    id: 'teradatasql',
    version: '1.0.0',
    entry: 'package/lib/index.js',
    platforms: ['test'],
    licenseName: 'Test license',
    licenseText: 'Full test license.  Acceptance is required.',
    licenseUrl: 'https://example.com/license',
    ready: true,
    artifacts: [
      {
        id: 'teradatasql',
        version: '1.0.0',
        url: 'https://registry.npmjs.org/teradatasql/-/test.tgz',
        integrity: integrity(bytes),
        unpackedSize: 4096,
        target: 'package',
        root: 'package',
      },
    ],
  };
  const audit = vi.fn(async (_action: string, _metadata: Record<string, unknown>) => undefined);
  const input = { licenseHash: licenseHash(definition), catalogHash: catalogHash(definition), offline: true };
  const installer = new DriverInstaller(directory, true, audit, {
    catalog: [definition],
    platform: 'test',
    ...options,
  });
  /** Uploads an archive the way the route passes one on: as the stream its bytes arrive on */
  const upload = (payload: Buffer = bytes, into = installer) =>
    into.upload('teradatasql', 'teradatasql', Readable.from([payload]), payload.length);
  return { directory, bytes, definition, audit, input, installer, upload };
}

/** A lock as a process would have left it, holding what `owner` says */
async function leaveLock(directory: string, owner: Record<string, unknown> | null) {
  const lock = join(directory, '.teradatasql.lock');
  await mkdir(lock, { recursive: true });
  if (owner)
    await writeFile(
      join(lock, 'owner.json'),
      JSON.stringify({ host: hostname(), started: STARTED, at: Date.now(), token: randomUUID(), ...owner }),
    );
  return lock;
}

/** A process that has run and stopped, whose ID no process holds now */
async function stoppedProcess(): Promise<number> {
  const child = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' });
  await new Promise((resolve) => child.once('exit', resolve));
  return child.pid!;
}

describe('driver installation', () => {
  it('installs a catalog archive without executing its scripts and records the exact license hash', async () => {
    const { directory, definition, audit, input, installer, upload } = await fixture();
    await upload();
    const installed = await installer.install('teradatasql', input);
    expect(installed.licenseHash).toBe(createHash('sha256').update(definition.licenseText).digest('hex'));
    expect(await installedDriver(directory, 'teradatasql')).toEqual(installed);
    expect(audit.mock.calls.map(([action]) => action)).toEqual([
      'sources.drivers.licenseAccepted',
      'sources.drivers.installing',
      'sources.drivers.installed',
    ]);
    expect(audit.mock.calls[0]![1]).toMatchObject({ licenseHash: input.licenseHash });
    expect(
      await readFile(join(directory, 'teradatasql', installed.revision, 'package/lib/index.js'), 'utf8'),
    ).toContain('verified');
    expect(await installedDriverUrl('teradatasql', directory)).toContain(installed.revision);
    // The uploaded archive served this install and is gone with it.
    expect((await readdir(join(directory, 'teradatasql'))).sort()).toEqual(
      ['active.json', installed.revision].sort(),
    );
  });

  it('refuses noncatalog drivers and a disabled installation before downloading or auditing', async () => {
    const { installer, input, directory, definition, audit, bytes } = await fixture();
    const network = vi.fn();
    vi.stubGlobal('fetch', network);
    await expect(installer.install('../outside', input)).rejects.toMatchObject({
      messageKey: 'sources.drivers.unknown',
    });
    await expect(
      installer.upload('teradatasql', '../outside', Readable.from([bytes]), bytes.length),
    ).rejects.toMatchObject({ messageKey: 'sources.drivers.unknown' });
    const disabled = new DriverInstaller(directory, false, audit, {
      catalog: [definition],
      platform: 'test',
    });
    await expect(disabled.install('teradatasql', { ...input, offline: false })).rejects.toMatchObject({
      messageKey: 'sources.drivers.disabled',
    });
    await expect(
      disabled.upload('teradatasql', 'teradatasql', Readable.from([bytes]), bytes.length),
    ).rejects.toMatchObject({ messageKey: 'sources.drivers.disabled' });
    expect(network).not.toHaveBeenCalled();
    expect(audit).not.toHaveBeenCalled();
  });

  it('refuses changed bytes as they are uploaded and leaves nothing to install from', async () => {
    const { installer, directory, input, bytes, upload, audit } = await fixture();
    const changed = Buffer.from(bytes);
    changed[20] = changed[20]! ^ 1;
    await expect(upload(changed)).rejects.toMatchObject({ messageKey: 'sources.drivers.integrity' });
    expect(await readdir(join(directory, 'teradatasql', 'uploads'))).toEqual([]);
    await expect(installer.install('teradatasql', input)).rejects.toMatchObject({
      messageKey: 'sources.drivers.uploadsRequired',
    });
    expect(await installedDriver(directory, 'teradatasql')).toBeNull();
    expect(audit).not.toHaveBeenCalled();
  });

  it('stops reading an upload the moment it passes the size limit', async () => {
    const { installer, directory } = await fixture();
    const chunk = Buffer.alloc(1024 * 1024);
    let sent = 0;
    const endless = Readable.from(
      (function* () {
        for (;;) {
          sent += 1;
          yield chunk;
        }
      })(),
    );
    await expect(installer.upload('teradatasql', 'teradatasql', endless)).rejects.toMatchObject({
      code: 'payload_too_large',
      messageKey: 'sources.drivers.archiveInvalid',
    });
    // One chunk past the limit, plus what the stream had buffered ahead, and no more.
    expect(sent).toBeLessThan(MAX_DRIVER_BYTES / chunk.length + 20);
    expect(await readdir(join(directory, 'teradatasql', 'uploads'))).toEqual([]);
    endless.destroy();
  });

  it('refuses an upload that says it is larger than the limit before reading it', async () => {
    const { installer } = await fixture();
    let read = false;
    const source = new Readable({
      read() {
        read = true;
        this.push(null);
      },
    });
    await expect(
      installer.upload('teradatasql', 'teradatasql', source, MAX_DRIVER_BYTES + 1),
    ).rejects.toMatchObject({ code: 'payload_too_large' });
    expect(read).toBe(false);
  });

  it.each([false, true])(
    'verifies downloaded bytes before activation with tampering %s',
    async (tampered) => {
      const { installer, directory, input, bytes, audit, definition } = await fixture();
      const payload = Buffer.from(bytes);
      if (tampered) payload[20] = payload[20]! ^ 1;
      const network = vi.fn(async () => {
        expect(audit.mock.calls[0]?.[0]).toBe('sources.drivers.licenseAccepted');
        return new Response(new Uint8Array(payload));
      });
      vi.stubGlobal('fetch', network);
      const pending = installer.install('teradatasql', { ...input, offline: false });
      if (tampered) {
        await expect(pending).rejects.toMatchObject({ messageKey: 'sources.drivers.integrity' });
        expect(await installedDriver(directory, 'teradatasql')).toBeNull();
        expect(await readdir(join(directory, 'teradatasql'))).toEqual([]);
      } else {
        const installed = await pending;
        expect(await installedDriver(directory, 'teradatasql')).toEqual(installed);
        // The downloaded archive is gone once unpacked.
        expect((await readdir(join(directory, 'teradatasql'))).sort()).toEqual(
          ['active.json', installed.revision].sort(),
        );
      }
      expect(network).toHaveBeenCalledWith(
        definition.artifacts[0]!.url,
        expect.objectContaining({ redirect: 'error' }),
      );
    },
  );

  it('refuses clearly when the drivers folder lacks room, before downloading or auditing', async () => {
    const freeSpace = vi.fn(async () => 1024 * 1024);
    const { installer, input, audit, bytes } = await fixture({ freeSpace });
    const network = vi.fn();
    vi.stubGlobal('fetch', network);
    const refusal = {
      code: 'validation_failed',
      messageKey: 'sources.drivers.space',
      params: { needed: 97, available: 1 },
    };
    await expect(installer.install('teradatasql', { ...input, offline: false })).rejects.toMatchObject(
      refusal,
    );
    let read = false;
    const source = new Readable({
      read() {
        read = true;
        this.push(bytes);
        this.push(null);
      },
    });
    await expect(
      installer.upload('teradatasql', 'teradatasql', source, 2 * 1024 * 1024),
    ).rejects.toMatchObject({ messageKey: 'sources.drivers.space', params: { needed: 3, available: 1 } });
    expect(read).toBe(false);
    expect(freeSpace).toHaveBeenCalledWith(installer.directory);
    expect(network).not.toHaveBeenCalled();
    expect(audit).not.toHaveBeenCalled();
  });

  it.each([
    'package/../../outside',
    '/package/outside',
    'package/../outside',
    'package\\outside',
    'package/C:outside',
  ])('refuses unsafe archive path %s', async (name) => {
    const { directory } = await fixture();
    const bytes = archive([{ name, body: 'untrusted' }]);
    await expect(
      unpackDriver(bytes, integrity(bytes), join(directory, 'output'), 'package'),
    ).rejects.toMatchObject({ messageKey: 'sources.drivers.archiveInvalid' });
  });

  it.each(['1', '2', '3', '4', '6', 'x', 'g', 'L'])('refuses archive entry type %s', async (kind) => {
    const { directory } = await fixture();
    const bytes = archive([{ name: 'package/link', kind }]);
    await expect(unpackDriver(bytes, integrity(bytes), directory, 'package')).rejects.toMatchObject({
      messageKey: 'sources.drivers.archiveInvalid',
    });
  });

  it('ignores extended headers that give only times, owners, and attributes', async () => {
    const { directory } = await fixture();
    const bytes = archive([
      {
        name: 'PaxHeader/clidriver',
        kind: 'x',
        body: paxRecord('mtime', '1784661283.372535925') + paxRecord('uid', '541717335'),
      },
      { name: 'clidriver/', kind: '5' },
      {
        name: './PaxHeaders/clidriver/license',
        kind: 'x',
        body:
          paxRecord('atime', '1784661283.389712679') +
          paxRecord('LIBARCHIVE.xattr.com.apple.FinderInfo', 'AAAA'),
      },
      { name: 'clidriver/license', body: 'client license' },
    ]);
    const output = join(directory, 'output');
    await unpackDriver(bytes, integrity(bytes), output, 'clidriver');
    expect(await readFile(join(output, 'license'), 'utf8')).toBe('client license');
    expect(await readdir(output)).toEqual(['license']);
  });

  it.each([
    ['a new name', paxRecord('path', 'clidriver/elsewhere')],
    ['a link', paxRecord('linkpath', '/etc/passwd')],
    ['a size', paxRecord('size', '0')],
    ['a sparse map', paxRecord('GNU.sparse.map', '0,1')],
    ['a record whose length is wrong', '99 mtime=1\n'],
    ['a record with no value', '9 mtime\n\n'],
  ])('refuses an extended header that gives %s', async (_name, body) => {
    const { directory } = await fixture();
    const bytes = archive([
      { name: 'PaxHeader/file', kind: 'x', body },
      { name: 'clidriver/file', body: 'file' },
    ]);
    await expect(unpackDriver(bytes, integrity(bytes), directory, 'clidriver')).rejects.toMatchObject({
      messageKey: 'sources.drivers.archiveInvalid',
    });
  });

  it('refuses two extended headers in a row, and one with no entry after it', async () => {
    const { directory } = await fixture();
    const twice = archive([
      { name: 'PaxHeader/one', kind: 'x', body: paxRecord('mtime', '1') },
      { name: 'PaxHeader/two', kind: 'x', body: paxRecord('mtime', '2') },
      { name: 'clidriver/file', body: 'file' },
    ]);
    const trailing = archive([
      { name: 'clidriver/file', body: 'file' },
      { name: 'PaxHeader/last', kind: 'x', body: paxRecord('mtime', '1') },
    ]);
    for (const bytes of [twice, trailing])
      await expect(unpackDriver(bytes, integrity(bytes), directory, 'clidriver')).rejects.toMatchObject({
        messageKey: 'sources.drivers.archiveInvalid',
      });
  });

  it('copies a link to a file in its own folder, only for an archive that allows it', async () => {
    const { directory } = await fixture();
    const bytes = archive([
      { name: 'clidriver/lib/libdb2.so.1', body: 'client library' },
      { name: 'clidriver/lib/libdb2.so', kind: '2', link: 'libdb2.so.1' },
      { name: 'clidriver/lib/libdb2.so.0', kind: '2', link: 'libdb2.so' },
    ]);
    await expect(
      unpackDriver(bytes, integrity(bytes), join(directory, 'refused'), 'clidriver'),
    ).rejects.toMatchObject({ messageKey: 'sources.drivers.archiveInvalid' });
    const output = join(directory, 'copied');
    await unpackDriver(bytes, integrity(bytes), output, 'clidriver', { links: 'copy' });
    for (const name of ['libdb2.so', 'libdb2.so.0']) {
      const path = join(output, 'lib', name);
      expect((await lstat(path)).isSymbolicLink()).toBe(false);
      expect(await readFile(path, 'utf8')).toBe('client library');
    }
  });

  it.each([
    ['a parent folder', [{ name: 'clidriver/lib/link', kind: '2', link: '../outside' }]],
    ['an absolute path', [{ name: 'clidriver/lib/link', kind: '2', link: '/etc/passwd' }]],
    [
      'another folder',
      [
        { name: 'clidriver/bin/file', body: 'file' },
        { name: 'clidriver/lib/link', kind: '2', link: 'bin/file' },
      ],
    ],
    ['a missing file', [{ name: 'clidriver/lib/link', kind: '2', link: 'missing' }]],
    [
      'a folder',
      [
        { name: 'clidriver/lib/folder/', kind: '5' },
        { name: 'clidriver/lib/link', kind: '2', link: 'folder' },
      ],
    ],
    [
      'itself, through another link',
      [
        { name: 'clidriver/lib/one', kind: '2', link: 'two' },
        { name: 'clidriver/lib/two', kind: '2', link: 'one' },
      ],
    ],
  ])('refuses a link to %s even when links are copied', async (_name, files) => {
    const { directory } = await fixture();
    const bytes = archive(files);
    await expect(
      unpackDriver(bytes, integrity(bytes), join(directory, 'output'), 'clidriver', { links: 'copy' }),
    ).rejects.toMatchObject({ messageKey: 'sources.drivers.archiveInvalid' });
  });

  it('checks a vendor archive against its pinned SHA-256', async () => {
    const { directory } = await fixture();
    const bytes = archive([{ name: 'clidriver/file', body: 'file' }]);
    const pinned = `sha256-${sha256(bytes).toString('base64')}`;
    await unpackDriver(bytes, pinned, join(directory, 'output'), 'clidriver');
    const changed = Buffer.from(bytes);
    changed[20] = changed[20]! ^ 1;
    await expect(
      unpackDriver(changed, pinned, join(directory, 'changed'), 'clidriver'),
    ).rejects.toMatchObject({ messageKey: 'sources.drivers.integrity' });
    const weak = `sha1-${createHash('sha1').update(bytes).digest('base64')}`;
    await expect(unpackDriver(bytes, weak, join(directory, 'weak'), 'clidriver')).rejects.toMatchObject({
      messageKey: 'sources.drivers.archiveInvalid',
    });
  });

  it('takes an add-on out of a zip only when its size, checksum, and SHA-256 match', async () => {
    const { directory } = await fixture();
    const body = 'native add-on';
    const path = join(directory, 'build.zip');
    const target = (name: string) => join(directory, name, 'odbc_bindings.node');
    const pinned = sha256(body).toString('hex');
    await writeFile(path, zip([{ name: 'build/Release/addon.node', body }]));
    await extractAddon(path, 'build/Release/addon.node', pinned, body.length, target('deflated'));
    expect(await readFile(target('deflated'), 'utf8')).toBe(body);
    await rm(path);
    await writeFile(path, zip([{ name: 'build/Release/addon.node', body, stored: true }]));
    await extractAddon(path, 'build/Release/addon.node', pinned, body.length, target('stored'));
    expect(await readFile(target('stored'), 'utf8')).toBe(body);

    const refusals: Array<[Buffer, string, number, string]> = [
      // Another file's hash
      [
        zip([{ name: 'addon', body }]),
        sha256('other').toString('hex'),
        body.length,
        'sources.drivers.integrity',
      ],
      // Another size than the catalog's
      [zip([{ name: 'addon', body }]), pinned, body.length + 1, 'sources.drivers.archiveInvalid'],
      // An encrypted entry
      [zip([{ name: 'addon', body, flags: 1 }]), pinned, body.length, 'sources.drivers.archiveInvalid'],
      // Two entries with the add-on's name
      [
        zip([
          { name: 'addon', body },
          { name: 'addon', body },
        ]),
        pinned,
        body.length,
        'sources.drivers.archiveInvalid',
      ],
      // No zip at all
      [Buffer.from('not a zip'), pinned, body.length, 'sources.drivers.archiveInvalid'],
    ];
    // Stored bytes that no longer match their checksum
    const damaged = zip([{ name: 'addon', body, stored: true }]);
    damaged[30 + 'addon'.length] = damaged[30 + 'addon'.length]! ^ 1;
    refusals.push([damaged, pinned, body.length, 'sources.drivers.archiveInvalid']);
    for (const [index, [bytes, hash, size, messageKey]] of refusals.entries()) {
      await rm(path, { force: true });
      await writeFile(path, bytes);
      await expect(extractAddon(path, 'addon', hash, size, target(`refused-${index}`))).rejects.toMatchObject(
        {
          messageKey,
        },
      );
      await expect(lstat(target(`refused-${index}`))).rejects.toMatchObject({ code: 'ENOENT' });
    }
  });

  it('requires fresh acceptance after the license text changes and preserves the old driver', async () => {
    const { directory, definition, installer, input, audit, upload } = await fixture();
    await upload();
    const old = await installer.install('teradatasql', input);
    const next = { ...definition, licenseText: definition.licenseText + '  Revised terms.' };
    const update = new DriverInstaller(directory, true, audit, { catalog: [next], platform: 'test' });
    const listing = await update.list();
    expect(listing.drivers[0]!.licenseHash).not.toBe(old.licenseHash);
    await expect(update.install('teradatasql', input)).rejects.toMatchObject({
      messageKey: 'sources.drivers.licenseChanged',
    });
    expect(await installedDriver(directory, 'teradatasql')).toEqual(old);
    await upload(undefined, update);
    const installed = await update.install('teradatasql', {
      ...input,
      licenseHash: licenseHash(next),
      catalogHash: catalogHash(next),
    });
    expect(installed.revision).not.toBe(old.revision);
  });

  it('keeps only the active revision once an update activates', async () => {
    const { directory, definition, installer, input, audit, upload } = await fixture();
    const revisions: string[] = [];
    let catalog = definition;
    let current = installer;
    for (let round = 0; round < 3; round++) {
      await upload(undefined, current);
      const installed = await current.install('teradatasql', {
        ...input,
        licenseHash: licenseHash(catalog),
        catalogHash: catalogHash(catalog),
      });
      revisions.push(installed.revision);
      expect((await readdir(join(directory, 'teradatasql'))).sort()).toEqual(
        ['active.json', installed.revision].sort(),
      );
      catalog = { ...catalog, licenseText: `${catalog.licenseText}  Round ${round + 1}.` };
      current = new DriverInstaller(directory, true, audit, { catalog: [catalog], platform: 'test' });
    }
    expect(new Set(revisions).size).toBe(3);
    expect(await installedDriverUrl('teradatasql', directory)).toContain(revisions.at(-1));
  });

  it('keeps the revision a running sync has open through an update, and removes it when the sync ends', async () => {
    // A driver that loads its second batch from a file it reads only when that batch is asked for
    const lazy = `let fetches = 0;
module.exports = {
  async connectAsync() {
    return { cursor() { return {
      description: [], columntypename: [],
      async executeAsync() { this.description = [['id', null, null, 255, 0, 0, true]]; this.columntypename = ['VARCHAR']; },
      fetchmany() { fetches += 1; return fetches === 1 ? [['1']] : fetches === 2 ? require('./later.js') : []; },
      close() {},
    }; } };
  },
};`;
    const { directory, installer, input, upload } = await fixture(
      {},
      {
        'package/lib/index.js': lazy,
        'package/lib/later.js': "module.exports = [['2']];",
      },
    );
    await upload();
    const first = await installer.install('teradatasql', input);
    const folder = join(directory, 'teradatasql');
    const reading = connectorFor('teradata')!.read(
      {
        connection: SourceConnection.parse({
          kind: 'teradata',
          host: '127.0.0.1',
          port: 1025,
          database: 'sample',
          user: 'reader',
          secure: false,
        }),
        secrets: { password: 'reader password' },
        driversDir: directory,
        timeoutMs: 10_000,
      },
      { kind: 'object', object: { schema: 'sample', name: 'items' } },
      { columns: ['id'], types: { id: 'text' }, keyColumns: ['id'], batchSize: 1 },
    );
    const sync = reading[Symbol.asyncIterator]();
    /** The keys of the sync's next batch, or `undefined` once it has read everything */
    const nextBatch = async () =>
      ((await sync.next()).value as SourceRow[] | undefined)?.map((row) => row.key);
    try {
      expect(await nextBatch()).toEqual(['["1"]']);
      // An update activates while the sync is between batches.
      await upload();
      const second = await installer.install('teradatasql', input);
      expect(await installedDriverUrl('teradatasql', directory)).toContain(second.revision);
      expect((await readdir(folder)).sort()).toEqual(['active.json', first.revision, second.revision].sort());
      // The sync's next batch loads its file from the revision it started with.
      expect(await nextBatch()).toEqual(['["2"]']);
      expect(await nextBatch()).toBeUndefined();
      // With its connection closed, the revision it used goes.
      await vi.waitFor(async () =>
        expect((await readdir(folder)).sort()).toEqual(['active.json', second.revision].sort()),
      );
    } finally {
      await sync.return?.(undefined);
    }
  });

  it('removes what a crashed install left when the server starts', async () => {
    const { directory, installer, input, upload } = await fixture();
    await upload();
    const installed = await installer.install('teradatasql', input);
    const folder = join(directory, 'teradatasql');
    const crashed = randomUUID();
    await mkdir(join(folder, crashed, 'package'), { recursive: true });
    await writeFile(join(folder, crashed, 'package', 'package.json'), '{}');
    await writeFile(join(folder, `${crashed}.json`), '{}');
    await writeFile(join(folder, `${crashed}.teradatasql.tgz`), 'partial download');
    await mkdir(join(folder, 'uploads'));
    await writeFile(join(folder, 'uploads', `.${randomUUID()}.partial`), 'partial upload');
    const lock = await leaveLock(directory, { pid: await stoppedProcess() });
    await mkdir(join(directory, `.teradatasql.lock.stale-${randomUUID()}`));
    await installer.cleanup();
    expect((await readdir(folder)).sort()).toEqual(['active.json', installed.revision].sort());
    expect(await readdir(directory)).toEqual(['teradatasql']);
    expect(await installedDriverUrl('teradatasql', directory)).toContain(installed.revision);
    await expect(readdir(lock)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('leaves a driver alone at start while a live process holds its lock', async () => {
    const { directory, installer, input, upload } = await fixture();
    await upload();
    await installer.install('teradatasql', input);
    const leftover = join(directory, 'teradatasql', randomUUID());
    await mkdir(leftover);
    await leaveLock(directory, { pid: process.pid });
    await installer.cleanup();
    expect(await readdir(leftover)).toEqual([]);
  });

  it('fails closed when audit persistence fails', async () => {
    const { directory, installer, input, audit, upload } = await fixture();
    await upload();
    audit.mockRejectedValueOnce(new Error('audit unavailable'));
    await expect(installer.install('teradatasql', input)).rejects.toThrow('audit unavailable');
    expect(await installedDriver(directory, 'teradatasql')).toBeNull();
  });

  it('restores the previous active driver when the completion audit fails', async () => {
    const { directory, installer, input, audit, upload } = await fixture();
    await upload();
    const before = await installer.install('teradatasql', input);
    audit.mockImplementation(async (action) => {
      if (action === 'sources.drivers.installed') throw new Error('audit unavailable');
    });
    await upload();
    await expect(installer.install('teradatasql', input)).rejects.toThrow('audit unavailable');
    expect(await installedDriver(directory, 'teradatasql')).toEqual(before);
    expect(await readdir(join(directory, 'teradatasql'))).toEqual(
      expect.arrayContaining(['active.json', before.revision]),
    );
    expect(await readdir(join(directory, 'teradatasql'))).toHaveLength(2);
  });

  it('removes all revisions and subsequently reports a missing driver', async () => {
    const { directory, installer, input, audit, upload } = await fixture();
    await upload();
    await installer.install('teradatasql', input);
    await installer.remove('teradatasql');
    await expect(installedDriverUrl('teradatasql', directory)).rejects.toMatchObject({
      messageKey: 'sources.test.driverMissing',
    });
    expect(audit.mock.calls.at(-1)![0]).toBe('sources.drivers.removed');
  });

  it('refuses installation through a symlink', async () => {
    const { directory, installer, input, upload } = await fixture();
    const target = join(directory, 'target');
    await writeFile(target, 'unchanged');
    await symlink(target, join(directory, 'teradatasql'));
    await expect(upload()).rejects.toBeDefined();
    await expect(installer.install('teradatasql', input)).rejects.toBeDefined();
    expect(await readFile(target, 'utf8')).toBe('unchanged');
  });
});

describe('driver locks', () => {
  it('clears the lock a crashed install left once its process is gone', async () => {
    const { directory, installer, input, upload, audit } = await fixture();
    // The install's process is still running, so its lock holds.
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
    try {
      await new Promise((resolve) => child.once('spawn', resolve));
      await leaveLock(directory, { pid: child.pid, started: Date.now() });
      const crashed = join(directory, 'teradatasql', randomUUID());
      await mkdir(crashed, { recursive: true });
      await expect(installer.remove('teradatasql')).rejects.toMatchObject({
        code: 'conflict',
        messageKey: 'sources.drivers.busy',
      });
    } finally {
      child.kill('SIGKILL');
    }
    await new Promise((resolve) => (child.exitCode === null ? child.once('exit', resolve) : resolve(null)));
    // Now the process is gone, so the next install takes the lock over and clears what it left.
    await upload();
    const installed = await installer.install('teradatasql', input);
    expect((await readdir(join(directory, 'teradatasql'))).sort()).toEqual(
      ['active.json', installed.revision].sort(),
    );
    expect(await readdir(directory)).toEqual(['teradatasql']);
    expect(audit.mock.calls.at(-1)![0]).toBe('sources.drivers.installed');
  });

  it('takes over a lock this process ID held before the server restarted', async () => {
    const { directory, installer } = await fixture();
    await leaveLock(directory, { pid: process.pid, started: STARTED - 10 * 60_000 });
    await installer.remove('teradatasql');
    await leaveLock(directory, { pid: process.pid });
    await expect(installer.remove('teradatasql')).rejects.toMatchObject({
      messageKey: 'sources.drivers.busy',
    });
  });

  it('waits out a lock from another host, or with no owner, until it is older than any install', async () => {
    const { directory, installer } = await fixture();
    const elsewhere = `elsewhere-${randomUUID()}`;
    let lock = await leaveLock(directory, { host: elsewhere, pid: process.pid });
    await expect(installer.remove('teradatasql')).rejects.toMatchObject({
      messageKey: 'sources.drivers.busy',
    });
    await rm(lock, { recursive: true });
    await leaveLock(directory, { host: elsewhere, pid: process.pid, at: Date.now() - 2 * LOCK_STALE_MS });
    await installer.remove('teradatasql');

    lock = await leaveLock(directory, null);
    await expect(installer.remove('teradatasql')).rejects.toMatchObject({
      messageKey: 'sources.drivers.busy',
    });
    const old = new Date(Date.now() - 2 * LOCK_STALE_MS);
    await utimes(lock, old, old);
    await installer.remove('teradatasql');
    expect(await readdir(directory)).toEqual([]);
  });

  it('refuses a second change while the first holds the lock', async () => {
    const { installer, input, upload, definition } = await fixture();
    await upload();
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    const audit = vi.fn(async (action: string) => {
      if (action === 'sources.drivers.licenseAccepted') await held;
    });
    const slow = new DriverInstaller(installer.directory, true, audit, {
      catalog: [definition],
      platform: 'test',
    });
    const first = slow.install('teradatasql', input);
    await vi.waitFor(() => expect(audit).toHaveBeenCalled());
    await expect(installer.remove('teradatasql')).rejects.toMatchObject({
      messageKey: 'sources.drivers.busy',
    });
    release();
    await first;
  });
});

describe('drivers with a vendor client', () => {
  const addonBody = 'native add-on for this platform';
  const packageBytes = archive([
    { name: 'package/package.json', body: JSON.stringify({ name: 'ibm_db', version: '1.0.0' }) },
    { name: 'package/lib/odbc.js', body: 'module.exports = { verified: true }' },
    {
      name: 'package/build.zip',
      body: zip([
        { name: 'build/Release/odbc_bindings_test.node', body: addonBody },
        { name: 'build/Release/odbc_bindings_other.node', body: 'native add-on for another platform' },
      ]),
    },
  ]);
  const clientBytes = archive([
    { name: 'PaxHeader/clidriver', kind: 'x', body: paxRecord('mtime', '1784661283.372535925') },
    { name: 'clidriver/', kind: '5' },
    { name: 'clidriver/lib/libdb2.so.1', body: 'client library' },
    { name: 'clidriver/lib/libdb2.so', kind: '2', link: 'libdb2.so.1' },
  ]);
  const otherClientBytes = archive([{ name: 'clidriver/lib/other', body: 'another platform' }]);
  const sri = (bytes: Buffer) => `sha256-${sha256(bytes).toString('base64')}`;

  async function vendorFixture(addonHash = sha256(addonBody).toString('hex')) {
    const directory = await mkdtemp(join(tmpdir(), 'drivers-vendor-'));
    directories.push(directory);
    const client = 'https://public.dhe.ibm.com/ibmdl/export/pub/software/data/db2/drivers/odbc_cli/v1/';
    const definition: DriverDefinition = {
      id: 'ibm_db',
      version: '1.0.0',
      entry: 'package/lib/odbc.js',
      platforms: ['test', 'other'],
      licenseName: 'Test client license',
      licenseText: 'Full client license.  Acceptance is required.',
      licenseUrl: 'https://example.com/client-license',
      ready: true,
      artifacts: [
        {
          id: 'ibm_db',
          version: '1.0.0',
          url: 'https://registry.npmjs.org/ibm_db/-/test.tgz',
          integrity: integrity(packageBytes),
          unpackedSize: 4096,
          target: 'package',
          root: 'package',
        },
        {
          id: 'clidriver-test',
          version: '1.0.0',
          url: `${client}test_odbc_cli.tar.gz`,
          integrity: sri(clientBytes),
          unpackedSize: 4096,
          target: 'package/installer/clidriver',
          root: 'clidriver',
          platforms: ['test'],
          links: 'copy',
        },
        {
          id: 'clidriver-other',
          version: '1.0.0',
          url: `${client}other_odbc_cli.tar.gz`,
          integrity: sri(otherClientBytes),
          unpackedSize: 4096,
          target: 'package/installer/clidriver',
          root: 'clidriver',
          platforms: ['other'],
          links: 'copy',
        },
      ],
      addons: [
        {
          id: 'addon-test',
          archive: 'package/build.zip',
          entry: 'build/Release/odbc_bindings_test.node',
          sha256: addonHash,
          size: addonBody.length,
          target: 'package/build/Release/odbc_bindings.node',
          platforms: ['test'],
        },
        {
          id: 'addon-other',
          archive: 'package/build.zip',
          entry: 'build/Release/odbc_bindings_other.node',
          sha256: sha256('native add-on for another platform').toString('hex'),
          size: 'native add-on for another platform'.length,
          target: 'package/build/Release/odbc_bindings.node',
          platforms: ['other'],
        },
      ],
      client: 'package/installer/clidriver',
    };
    const served = new Map([
      [definition.artifacts[0]!.url, packageBytes],
      [definition.artifacts[1]!.url, clientBytes],
      [definition.artifacts[2]!.url, otherClientBytes],
    ]);
    const network = vi.fn(async (url: string) => new Response(new Uint8Array(served.get(url)!)));
    vi.stubGlobal('fetch', network);
    const audit = vi.fn(async (_action: string, _metadata: Record<string, unknown>) => undefined);
    const installer = new DriverInstaller(directory, true, audit, {
      catalog: [definition],
      platform: 'test',
    });
    const input = { licenseHash: licenseHash(definition), catalogHash: catalogHash(definition) };
    return { directory, definition, network, audit, installer, input };
  }

  it('installs this platform’s client and add-on, and nothing built for another platform', async () => {
    const { directory, definition, network, installer, input } = await vendorFixture();
    const listing = await installer.list();
    expect(listing.drivers[0]!.artifacts.map((artifact) => artifact.id)).toEqual([
      'ibm_db',
      'clidriver-test',
    ]);
    const installed = await installer.install('ibm_db', input);
    expect(network.mock.calls.map(([url]) => url)).toEqual([
      definition.artifacts[0]!.url,
      definition.artifacts[1]!.url,
    ]);
    const revision = join(directory, 'ibm_db', installed.revision, 'package');
    expect(await readFile(join(revision, 'build/Release/odbc_bindings.node'), 'utf8')).toBe(addonBody);
    expect(await readdir(join(revision, 'build/Release'))).toEqual(['odbc_bindings.node']);
    expect(await readFile(join(revision, 'installer/clidriver/lib/libdb2.so'), 'utf8')).toBe(
      'client library',
    );
    expect((await lstat(join(revision, 'installer/clidriver/lib/libdb2.so'))).isSymbolicLink()).toBe(false);
    await expect(lstat(join(revision, 'installer/clidriver/lib/other'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('refuses an upload of an archive built for another platform', async () => {
    const { installer, network } = await vendorFixture();
    await expect(
      installer.upload(
        'ibm_db',
        'clidriver-other',
        Readable.from([otherClientBytes]),
        otherClientBytes.length,
      ),
    ).rejects.toMatchObject({ messageKey: 'sources.drivers.unknown' });
    expect(network).not.toHaveBeenCalled();
  });

  it('installs from uploads of this platform’s archives alone', async () => {
    const { directory, installer, input, network } = await vendorFixture();
    await installer.upload('ibm_db', 'ibm_db', Readable.from([packageBytes]), packageBytes.length);
    await installer.upload('ibm_db', 'clidriver-test', Readable.from([clientBytes]), clientBytes.length);
    const installed = await installer.install('ibm_db', { ...input, offline: true });
    expect(network).not.toHaveBeenCalled();
    expect(
      await readFile(
        join(directory, 'ibm_db', installed.revision, 'package/build/Release/odbc_bindings.node'),
        'utf8',
      ),
    ).toBe(addonBody);
  });

  it('activates nothing when the add-on isn’t the one the catalog pins', async () => {
    const { directory, installer, input } = await vendorFixture(sha256('another add-on').toString('hex'));
    await expect(installer.install('ibm_db', input)).rejects.toMatchObject({
      messageKey: 'sources.drivers.integrity',
    });
    expect(await installedDriver(directory, 'ibm_db')).toBeNull();
    expect(await readdir(join(directory, 'ibm_db'))).toEqual([]);
  });

  it('downloads only from the npm registry and IBM’s client folder', async () => {
    const { directory, definition, audit, network } = await vendorFixture();
    const elsewhere: DriverDefinition = {
      ...definition,
      artifacts: definition.artifacts.map((artifact) =>
        artifact.id === 'clidriver-test'
          ? { ...artifact, url: 'https://public.dhe.ibm.com/elsewhere/test_odbc_cli.tar.gz' }
          : artifact,
      ),
    };
    const installer = new DriverInstaller(directory, true, audit, { catalog: [elsewhere], platform: 'test' });
    await expect(
      installer.install('ibm_db', {
        licenseHash: licenseHash(elsewhere),
        catalogHash: catalogHash(elsewhere),
      }),
    ).rejects.toMatchObject({ messageKey: 'sources.drivers.unknown' });
    expect(network.mock.calls.map(([url]) => url)).toEqual([definition.artifacts[0]!.url]);
    expect(await installedDriver(directory, 'ibm_db')).toBeNull();
  });
});
