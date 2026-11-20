import { createHash } from 'node:crypto';
import { artifacts } from './artifacts.js';
import { ibmLicense } from './ibm-license.js';
import { teradataLicense } from './teradata-license.js';

export type DriverId = 'teradatasql' | 'ibm_db';
export interface DriverArtifact {
  id: string;
  version: string;
  url: string;
  /** The archive's hash as an integrity value, `sha512-` or `sha256-` and then the digest in base64 */
  integrity: string;
  /** The bytes its files take once unpacked, which an install checks there's room for first */
  unpackedSize: number;
  target: string;
  root: string;
  /** The platforms this archive is built for, when it isn't every platform the driver supports */
  platforms?: readonly string[];
  /**
   * `copy` turns each link inside the archive that names a file in its own folder into a copy of
   * that file.  Without it, and for any other link, the archive is refused.
   */
  links?: 'copy';
}
/** A native add-on that an unpacked archive carries inside a zip, one build for each platform */
export interface DriverAddon {
  id: string;
  /** The zip's path within the unpacked driver */
  archive: string;
  /** The add-on's path inside that zip */
  entry: string;
  /** The add-on's SHA-256, in hex, taken when it was pinned */
  sha256: string;
  /** Its size once taken out, which counts toward the room an install needs */
  size: number;
  /** Where it goes within the unpacked driver, which is where the package loads it from */
  target: string;
  platforms: readonly string[];
}
export interface DriverDefinition {
  id: DriverId;
  version: string;
  entry: string;
  platforms: readonly string[];
  licenseName: string;
  licenseUrl: string;
  licenseText: string;
  artifacts: readonly DriverArtifact[];
  addons?: readonly DriverAddon[];
  /** The vendor client's folder within the unpacked driver, for a driver that loads one */
  client?: string;
  ready: boolean;
}

/** Only reviewed artifacts can enter executable storage.  An incomplete entry stays unavailable. */
export const DRIVER_CATALOG: readonly DriverDefinition[] = [
  {
    id: 'teradatasql',
    version: '20.0.69',
    entry: 'package/lib/index.js',
    platforms: ['linux-x64', 'linux-arm64', 'darwin-x64', 'darwin-arm64', 'win32-x64'],
    licenseName: 'Teradata License Agreement',
    licenseUrl: 'https://github.com/Teradata/nodejs-driver/blob/develop/LICENSE',
    licenseText: teradataLicense,
    artifacts: artifacts.filter((a) => a.id === 'teradatasql' || a.id === 'koffi'),
    ready: true,
  },
  {
    id: 'ibm_db',
    version: '4.0.1',
    entry: 'package/lib/odbc.js',
    // IBM ships no client for Linux on arm64.  These are the platforms whose client and add-on are
    // pinned here.
    platforms: ['linux-x64', 'darwin-arm64'],
    licenseName: 'IBM Data Server Driver for ODBC and CLI v12.1.4 License Information',
    licenseUrl: 'https://www.ibm.com/terms/?id=L-WNKS-F8PR3U',
    licenseText: ibmLicense,
    artifacts: artifacts.filter((a) => !['teradatasql', 'koffi'].includes(a.id)),
    // The package's own installer takes its platform's build out of this zip, which the package's
    // integrity hash already covers.  The add-on's own hash is checked as well.
    addons: [
      {
        id: 'odbc_bindings-linux-x64',
        archive: 'package/build.zip',
        entry: 'build/Release/odbc_bindings_linux.node',
        sha256: '6243be969c6005a9d42b3dcf9fd936a3bc0a618bde90a10553a325f028ebf603',
        size: 3_207_656,
        target: 'package/build/Release/odbc_bindings.node',
        platforms: ['linux-x64'],
      },
      {
        id: 'odbc_bindings-darwin-arm64',
        archive: 'package/build.zip',
        entry: 'build/Release/odbc_bindings_macarm.node',
        sha256: '795675b3cc20c6ca84f298f1fcaf225615aca3001b369d9b1696741fc4a619e4',
        size: 332_336,
        target: 'package/build/Release/odbc_bindings.node',
        platforms: ['darwin-arm64'],
      },
    ],
    client: 'package/installer/clidriver',
    ready: true,
  },
];

export function driverDefinition(id: string): DriverDefinition | undefined {
  return DRIVER_CATALOG.find((driver) => driver.id === id);
}

export function licenseHash(driver: DriverDefinition): string {
  return createHash('sha256').update(driver.licenseText, 'utf8').digest('hex');
}

/** The archives a driver installs from on `platform`, or every archive when it's left out */
export function driverArtifacts(driver: DriverDefinition, platform?: string): readonly DriverArtifact[] {
  return driver.artifacts.filter(
    (artifact) => !artifact.platforms || platform === undefined || artifact.platforms.includes(platform),
  );
}

/** The native add-ons a driver takes out on `platform` */
export function driverAddons(driver: DriverDefinition, platform: string): readonly DriverAddon[] {
  return (driver.addons ?? []).filter((addon) => addon.platforms.includes(platform));
}

/**
 * The room a driver's files take once unpacked on `platform`, its archives and add-ons together.
 * Left out, it's the most any one platform the driver supports needs.
 */
export function unpackedBytes(driver: DriverDefinition, platform?: string): number {
  if (platform === undefined)
    return Math.max(0, ...driver.platforms.map((each) => unpackedBytes(driver, each)));
  return (
    driverArtifacts(driver, platform).reduce((total, artifact) => total + artifact.unpackedSize, 0) +
    driverAddons(driver, platform).reduce((total, addon) => total + addon.size, 0)
  );
}

export function catalogHash(driver: DriverDefinition): string {
  return createHash('sha256').update(JSON.stringify(driver)).digest('hex');
}
