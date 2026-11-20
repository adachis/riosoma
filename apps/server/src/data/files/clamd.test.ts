import { Readable } from 'node:stream';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { detectScanner, ScanTooLarge, scannerStatus, scanStream } from './clamd.js';
import { eicar, standIn, unreachableScanner } from './scan-test-support.js';

describe('scanner protocol', () => {
  it('classifies an early stream rejection without waiting for the whole source', async () => {
    const scanner = await standIn({ maxBytes: 10 });
    const source = new Readable({
      read() {
        this.push(Buffer.alloc(64 * 1024));
      },
    });
    try {
      await expect(scanStream(scanner.url, source)).rejects.toBeInstanceOf(ScanTooLarge);
      expect(source.destroyed).toBe(true);
    } finally {
      await scanner.close();
    }
  });

  it('keeps internal engine limits distinct from infections', async () => {
    const scanner = await standIn({ result: 'stream: Heuristics.Limits.Exceeded.MaxFileSize FOUND\0' });
    try {
      await expect(scanStream(scanner.url, Readable.from([Buffer.from('safe')]))).rejects.toBeInstanceOf(
        ScanTooLarge,
      );
    } finally {
      await scanner.close();
    }
  });

  it('refuses an OK response before the stream has finished', async () => {
    const scanner = await standIn({ earlyOk: true });
    const source = new Readable({ read() {} });
    try {
      await expect(scanStream(scanner.url, source)).rejects.toThrow('complete file');
      expect(source.destroyed).toBe(true);
    } finally {
      await scanner.close();
    }
  });

  it('detects a configured daemon and tests EICAR entirely in memory', async () => {
    const scanner = await standIn();
    try {
      expect(await detectScanner(scanner.url)).toMatchObject({
        address: scanner.url,
        reachable: true,
        tested: true,
        signatureDate: '2026-10-01T08:00:00.000Z',
        lastError: null,
      });
      expect(scanner.received).toEqual([eicar]);
    } finally {
      await scanner.close();
    }
    expect(await scannerStatus(await unreachableScanner(), true)).toMatchObject({
      reachable: false,
      tested: false,
      lastError: 'files.scanner.unreachable',
    });
  });

  it('supports a local Unix socket and a daemon that omits its signature date', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'rio-clamd-'));
    const scanner = await standIn({ socketPath: join(directory, 'clamd.sock'), version: 'ClamAV 1.4.6' });
    try {
      expect(await detectScanner(scanner.url)).toMatchObject({
        reachable: true,
        tested: true,
        signatureDate: null,
      });
    } finally {
      await scanner.close();
      await rm(directory, { recursive: true });
    }
  });

  it('rejects a daemon that approves the test signature as clean', async () => {
    const scanner = await standIn({ result: 'stream: OK\0' });
    try {
      expect(await scannerStatus(scanner.url, true)).toMatchObject({
        reachable: true,
        tested: false,
        lastError: 'files.scanner.testFailed',
      });
    } finally {
      await scanner.close();
    }
  });
  it('frames streamed bytes and accepts only clean results', async () => {
    const scanner = await standIn();
    try {
      const bytes = Buffer.alloc(130_000, 0x61);
      expect(await scanStream(scanner.url, Readable.from([bytes]))).toBeNull();
      expect(await scanStream(scanner.url, Readable.from([eicar]))).toBe('Eicar-Test-Signature');
      expect(scanner.received).toEqual([bytes, eicar]);
    } finally {
      await scanner.close();
    }
    // A scanner that is gone refuses the connection, and a scan against it fails rather than passes.
    await expect(
      scanStream(await unreachableScanner(), Readable.from([Buffer.from('safe')])),
    ).rejects.toThrow();
  });
});

describe.skipIf(!process.env.RIOSOMA_TEST_CLAMAV_URL)('live scanner', () => {
  it('releases clean bytes and detects the standard test signature', async () => {
    const address = process.env.RIOSOMA_TEST_CLAMAV_URL!;
    expect(await scanStream(address, Readable.from([Buffer.from('safe')]))).toBeNull();
    expect(await scanStream(address, Readable.from([eicar]))).toMatch(/Eicar|EICAR/i);
  }, 120_000);
  it('verifies the setup diagnostics against a live daemon', async () => {
    expect(await scannerStatus(process.env.RIOSOMA_TEST_CLAMAV_URL!, true)).toMatchObject({
      reachable: true,
      tested: true,
      lastError: null,
    });
  }, 120_000);
});
