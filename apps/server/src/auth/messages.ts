export const accountMessages: Record<string, string> = {
  'auth.reset.serverShell': 'Run this command from an interactive shell on the Riosoma server.',
  'auth.reset.commandUsage': 'Usage: node apps/server/dist/tools/password-reset.js owner-email-address',
  'auth.reset.soleOwner': 'This address must belong to the only active owner in its organization.',
  'auth.reset.addressRequired': 'Set the server’s public address before creating a reset link.',
  'auth.reset.sso': 'Use your organization’s sign-in.  Contact an administrator if you need help.',
  'auth.reset.invalid': 'The reset link could not be created or used.',
  'setup.database.required': 'Configure the server’s database before running this command.',
};
