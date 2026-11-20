const enUS = {
  'hub.name': 'Riosoma hub\n',
  'hub.health': 'ok\n',
  'hub.issue.context': 'Version: {version}\nPlatform: {platform}\nFingerprint: {fingerprint}',
  'hub.issue.count': 'Reports: {count}\nVersions seen: {versions}',
} as const;

export function message(key: keyof typeof enUS, values: Record<string, string | number> = {}): string {
  return enUS[key].replace(/\{(\w+)\}/g, (_, name: string) => String(values[name] ?? ''));
}
