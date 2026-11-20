export interface SourceDriver {
  id: 'teradatasql' | 'ibm_db';
  version: string;
  platforms: readonly string[];
  licenseName: string;
  licenseUrl: string;
  licenseText: string;
  licenseHash: string;
  catalogHash: string;
  supported: boolean;
  ready: boolean;
  artifacts: Array<{ id: string; version: string; url: string; integrity: string }>;
  installed: { version: string; catalogHash: string; licenseHash: string; installedAt: string } | null;
}

export interface SourceDrivers {
  enabled: boolean;
  platform: string;
  drivers: SourceDriver[];
}
