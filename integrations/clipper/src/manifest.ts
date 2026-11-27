// The extension's manifests and host permission patterns.  This file imports nothing, so the build
// script loads it directly and the popup and background process share the same patterns.

export type Target = 'chrome' | 'firefox';

/**
 * Plain HTTP reaches only a server on this computer, by its IPv4 loopback address.  A content
 * security policy can't name an IPv6 address, so `[::1]` would be refused even after sign-in.
 */
export const clipperLoopback = ['127.0.0.1'];

/** What a person can grant from the sign-in button.  Firefox match patterns can't carry a port. */
export const optionalHosts = ['https://*/*', ...clipperLoopback.map((host) => `http://${host}/*`)];

/** The host permission for one Riosoma address.  Chrome keeps its port, and Firefox can't. */
export function originPattern(origin: string, target: Target): string {
  const url = new URL(origin);
  return target === 'firefox' ? `${url.protocol}//${url.hostname}/*` : `${url.origin}/*`;
}

export function hasPort(pattern: string): boolean {
  return /^[^:/]+:\/\/(?:\[[^\]]*\]|[^/:]*):/.test(pattern);
}

// The background process enforces the chosen address and its API paths, so the policy only has to
// keep every connection on HTTPS or this computer.
const policy = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  `connect-src 'self' https: ${clipperLoopback.map((host) => `http://${host}:*`).join(' ')}`,
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join('; ');

/**
 * Chrome and Firefox accept only one to four dot-separated integers as an extension's version, and
 * Chrome refuses to load anything else, so a release candidate such as 0.95.0-rc.1 installs as
 * 0.95.0.  Each part is held to Chrome's limits: 0 to 65535, with no leading zeros.
 */
export function extensionVersion(release: string): string {
  const numeric = release.replace(/[-+].*$/, '');
  const parts = numeric.split('.');
  if (parts.length > 4 || parts.some((part) => !/^(0|[1-9]\d*)$/.test(part) || Number(part) > 65535))
    throw new Error(`No extension version can be made from ${release}`);
  return numeric;
}

export function manifest(target: Target, release: string) {
  const version = extensionVersion(release);
  const common = {
    manifest_version: 3,
    name: '__MSG_name__',
    description: '__MSG_description__',
    version,
    default_locale: 'en_US',
    permissions: ['activeTab', 'storage', 'identity', 'scripting'],
    optional_host_permissions: optionalHosts,
    action: { default_popup: 'popup.html', default_title: '__MSG_name__' },
    content_security_policy: { extension_pages: policy },
  };
  if (target === 'chrome')
    return {
      ...common,
      // Chrome shows this label in place of the version, so testers can tell a candidate apart.
      // Firefox has no such field and flags it.
      ...(release !== version ? { version_name: release } : {}),
      background: { service_worker: 'worker.js' },
    };
  const firefox = {
    ...common,
    background: { scripts: ['worker.js'] },
    browser_specific_settings: {
      gecko: {
        id: 'riosoma-clipper@riosoma',
        strict_min_version: '140.0',
        data_collection_permissions: { required: ['authenticationInfo', 'websiteContent'] },
      },
    },
  };
  const ported = firefox.optional_host_permissions.filter(hasPort);
  if (ported.length) throw new Error(`Firefox match patterns can't carry a port: ${ported.join(', ')}`);
  return firefox;
}
