const messages = {
  'demo.account.invalid':
    'must name an active ordinary member with no organization or unit administration roles.  Demo mode also requires a configured database.',
  'config.serviceLinkIgnored':
    'Ignored this Kubernetes service-link variable because it describes a Service, rather than a server setting.',
  'server.startup.databaseWait': 'The database cannot be reached.  Waiting before retrying.',
  'server.startup.databaseNewer':
    'This database was upgraded by a newer Riosoma.  Run that version or restore the backup taken before upgrading.',
  'server.startup.migrationChanged':
    'A migration changed after it was applied.  Restore the shipped migration and add a new migration instead.',
  'server.startup.migrationStatementFailed':
    'A database migration statement failed.  Check the migration ID and SQLSTATE in the server log.',
} as const;

export function startupMessage(key: keyof typeof messages): string {
  return messages[key];
}
