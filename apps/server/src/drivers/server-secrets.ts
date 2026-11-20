import { readStored, secretSettingValues, type RuntimeConfig } from '../config.js';

/** Configuration field names that hold a secret, or an address or document that can carry one */
const SECRET_FIELD = /secret|password|passphrase|token|key|pem|credential|profile|connection|json|url$/i;

function collect(value: unknown, secret: boolean, into: Set<string>, depth = 0): void {
  if (depth > 8 || value === null || value === undefined) return;
  if (typeof value === 'string') {
    if (secret && value) into.add(value);
  } else if (Buffer.isBuffer(value)) {
    if (secret && value.length)
      for (const form of ['base64', 'base64url', 'hex'] as const) into.add(value.toString(form));
  } else if (Array.isArray(value)) {
    for (const item of value) collect(item, secret, into, depth + 1);
  } else if (typeof value === 'object') {
    for (const [name, item] of Object.entries(value))
      collect(item, secret || SECRET_FIELD.test(name), into, depth + 1);
  }
}

/**
 * Every secret the server holds, for taking out of what an installed driver says.  A driver's code
 * runs with the server's file access, so it could read any of these: the secret key in each form
 * it's written in, the database profile's credentials, the settings that hold secrets or addresses
 * with them, and what `riosoma.config.json` keeps.  It errs toward too much, since removing a
 * harmless address from a driver's message costs nothing.
 */
export function serverSecrets(
  config: RuntimeConfig,
  settings: readonly string[] = secretSettingValues(),
): string[] {
  const found = new Set<string>();
  collect(config, false, found);
  collect(settings, true, found);
  try {
    collect(readStored(config.configDir), true, found);
  } catch {
    // An unreadable stored configuration stops the server at start, so there's nothing more here.
  }
  return [...found];
}
