import { delimiter, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  DRIVER_CATALOG,
  driverAddons,
  driverArtifacts,
  driverDefinition,
  licenseHash,
  unpackedBytes,
} from './catalog.js';
import { driverEnvironment } from './process.js';

const ibm = driverDefinition('ibm_db')!;

describe('driver catalog', () => {
  it('carries IBM’s license text exactly as IBM ships it with the client', () => {
    // The SHA-256 of the client's own English license file, license/UNIX/odbc_LI_en, in v12.1.4.
    expect(licenseHash(ibm)).toBe('ccf2074cbf9317198bea5560cdfb728092c909589accbefe70c9680b95269a31');
    expect(ibm.licenseText).toContain('IBM Data Server Driver for ODBC and CLI v12.1.4');
    expect(ibm.licenseUrl).toBe('https://www.ibm.com/terms/?id=L-WNKS-F8PR3U');
    expect(ibm.ready).toBe(true);
  });

  it('pins a client and an add-on for every platform IBM’s driver offers, and none for Linux on arm64', () => {
    expect(ibm.platforms).toEqual(['linux-x64', 'darwin-arm64']);
    expect(ibm.platforms).not.toContain('linux-arm64');
    for (const platform of ibm.platforms) {
      const clients = driverArtifacts(ibm, platform).filter((artifact) => artifact.platforms);
      expect(clients).toHaveLength(1);
      expect(clients[0]).toMatchObject({
        target: ibm.client,
        root: 'clidriver',
        links: 'copy',
        url: expect.stringMatching(
          /^https:\/\/public\.dhe\.ibm\.com\/ibmdl\/export\/pub\/software\/data\/db2\/drivers\/odbc_cli\/v12\.1\.4\//,
        ),
        integrity: expect.stringMatching(/^sha256-[A-Za-z0-9+/]{43}=$/),
      });
      const addons = driverAddons(ibm, platform);
      expect(addons).toHaveLength(1);
      expect(addons[0]!.sha256).toMatch(/^[a-f0-9]{64}$/);
      expect(addons[0]!.target).toBe('package/build/Release/odbc_bindings.node');
    }
    expect(driverArtifacts(ibm, 'linux-arm64').some((artifact) => artifact.platforms)).toBe(false);
    expect(driverAddons(ibm, 'linux-arm64')).toEqual([]);
  });

  it('counts only the platform’s own client toward the room an install needs', () => {
    const shared = driverArtifacts(ibm, 'linux-x64')
      .filter((artifact) => !artifact.platforms)
      .reduce((total, artifact) => total + artifact.unpackedSize, 0);
    expect(unpackedBytes(ibm, 'linux-x64')).toBe(shared + 124_616_044 + 3_207_656);
    expect(unpackedBytes(ibm, 'darwin-arm64')).toBe(shared + 60_945_039 + 332_336);
    expect(unpackedBytes(ibm)).toBe(unpackedBytes(ibm, 'linux-x64'));
  });

  it('pins every archive to a registry or vendor download with a full hash', () => {
    for (const driver of DRIVER_CATALOG)
      for (const artifact of driver.artifacts) {
        expect(artifact.url).toMatch(
          /^https:\/\/(registry\.npmjs\.org\/|public\.dhe\.ibm\.com\/ibmdl\/export\/pub\/software\/data\/db2\/drivers\/odbc_cli\/)/,
        );
        expect(artifact.integrity).toMatch(/^(sha512-[A-Za-z0-9+/]{86}==|sha256-[A-Za-z0-9+/]{43}=)$/);
      }
  });
});

describe('driver environment', () => {
  const server = {
    PATH: '/usr/bin',
    IBM_DB_HOME: '/opt/another-client',
    DB2CLIINIPATH: '/etc/db2',
    LD_LIBRARY_PATH: '/opt/elsewhere',
    DYLD_LIBRARY_PATH: '/opt/elsewhere',
  };
  const folder = join('/drivers', 'ibm_db', 'revision');
  const client = join(folder, 'package/installer/clidriver');
  const libraries = [join(client, 'lib'), join(client, 'lib', 'icc')].join(delimiter);

  it('points IBM’s driver at the client installed beside it, and never another', () => {
    expect(driverEnvironment('ibm_db', '/tmp/driver', server, folder, 'linux')).toEqual({
      PATH: '/usr/bin',
      DB2CLIINIPATH: '/etc/db2',
      TMPDIR: '/tmp/driver',
      TMP: '/tmp/driver',
      TEMP: '/tmp/driver',
      HOME: '/tmp/driver',
      IBM_DB_HOME: client,
      LD_LIBRARY_PATH: libraries,
    });
    // IBM's macOS add-on names its client library by where it was built, so the loader needs this.
    expect(driverEnvironment('ibm_db', '/tmp/driver', server, folder, 'darwin')).toMatchObject({
      IBM_DB_HOME: client,
      DYLD_LIBRARY_PATH: libraries,
    });
  });

  it('gives Teradata’s driver no client settings at all', () => {
    const env = driverEnvironment('teradatasql', '/tmp/driver', server, join('/drivers', 'teradatasql', 'r'));
    expect(Object.keys(env).sort()).toEqual(['HOME', 'PATH', 'TEMP', 'TMP', 'TMPDIR']);
  });
});
