import { message } from './messages.js';
import { readFileSync } from 'node:fs';
import { RioApiError, RioClientError } from '@riosoma/sdk';
import { parseArgs, type Args, type FlagSpecs } from './args.js';
import { Failure, UsageError, terminalIo, type Io } from './io.js';
import { GLOBAL_FLAGS } from './context.js';
import { LOGIN_FLAGS, LOGOUT_FLAGS, login, logout } from './commands/login.js';
import { DATABASES_FLAGS, SCHEMA_FLAGS, TABLES_FLAGS, databases, schema, tables } from './commands/schema.js';
import { RECORDS_FLAGS, records } from './commands/records.js';
import { EXPORT_FLAGS, IMPORT_FLAGS, exportRecords, importRecords } from './commands/transfer.js';

/**
 * The tool's own shape: which commands there are, what each takes, and how a failure reads.
 *
 * A command line is an interface like any other, so it answers a mistake by saying what to type
 * instead, and it never prints a stack for something a person can fix.  Exit codes follow what
 * scripts expect: 0 when the command did its work, 1 when it couldn't, and 2 when it was asked for
 * something that isn't a command.
 */

interface Command {
  summary: string;
  usage: string;
  flags: FlagSpecs;
  run(args: Args, io: Io): Promise<void>;
  /** Lines under the usage, for the things a command's options can't say */
  notes?: string[];
}

const HELP_FLAGS = {
  help: { short: 'h', help: message('cli.cli.showThisHelp') },
  version: { short: 'v', help: message('cli.cli.showTheVersion') },
} as const satisfies FlagSpecs;

export const COMMANDS: Record<string, Command> = {
  databases: {
    summary: message('cli.cli.listTheDatabasesThisCredentialReaches'),
    usage: message('cli.cli.riosomaDatabases'),
    flags: { ...DATABASES_FLAGS, ...HELP_FLAGS },
    run: databases,
  },
  tables: {
    summary: message('cli.cli.listADatabaseSTablesAndWith'),
    usage: message('cli.cli.riosomaTablesDatabaseFields'),
    flags: { ...TABLES_FLAGS, ...HELP_FLAGS },
    run: tables,
  },
  records: {
    summary: message('cli.cli.listGetCreateUpdateOrDeleteRecords'),
    usage: message('cli.cli.riosomaRecordsListGetCreateUpdateDelete'),
    flags: { ...RECORDS_FLAGS, ...HELP_FLAGS },
    run: records,
    notes: [
      message('cli.cli.listReadsRecordsAndPagesThroughAs'),
      message('cli.cli.riosomaRecordsListPeopleContactsFilterConjunction'),
      message('cli.cli.getReadsOneRecordById'),
      message('cli.cli.riosomaRecordsGetPeopleContactsRec'),
      message('cli.cli.createWritesNewRecordsFromJsonText'),
      message('cli.cli.riosomaRecordsCreatePeopleContactsFieldName'),
      message('cli.cli.riosomaRecordsCreatePeopleContactsDataFields'),
      message('cli.cli.updateChangesRecordsThatExistEachNamed'),
      message('cli.cli.riosomaRecordsUpdatePeopleContactsIdRec'),
      message('cli.cli.riosomaRecordsUpdatePeopleContactsUpsertOn'),
      message('cli.cli.deleteMovesRecordsToTheTrashWhere'),
      message('cli.cli.riosomaRecordsDeletePeopleContactsRecRec'),
    ],
  },
  import: {
    summary: message('cli.cli.readRecordsIntoATableFromA'),
    usage: message('cli.cli.riosomaImportDatabaseTableFilePathOptions'),
    flags: { ...IMPORT_FLAGS, ...HELP_FLAGS },
    run: importRecords,
    notes: [
      message('cli.cli.aCsvFileSFirstRowNames'),
      message('cli.cli.riosomaImportPeopleContactsFileContactsCsv2'),
      message('cli.cli.riosomaImportPeopleContactsFileContactsCsv'),
      message('cli.cli.aJsonFileHoldsAnArrayOf'),
      message('cli.cli.theFileIsReadAsItArrives'),
    ],
  },
  export: {
    summary: message('cli.cli.writeATableSRecordsToA'),
    usage: message('cli.cli.riosomaExportDatabaseTableFilePathOptions'),
    flags: { ...EXPORT_FLAGS, ...HELP_FLAGS },
    run: exportRecords,
    notes: [
      message('cli.cli.withNoFileTheRecordsGoTo'),
      message('cli.cli.riosomaExportPeopleContactsFileContactsCsv'),
      message('cli.cli.riosomaExportPeopleContactsFormatJsonWith'),
      message('cli.cli.eachRecordIsWrittenAsItArrives'),
    ],
  },
  schema: {
    summary: message('cli.cli.printOrSaveADatabaseSSchema'),
    usage: message('cli.cli.riosomaSchemaDatabaseFilePath'),
    flags: { ...SCHEMA_FLAGS, ...HELP_FLAGS },
    run: schema,
    notes: [message('cli.cli.theDocumentHoldsEachTableWithIts')],
  },
  login: {
    summary: message('cli.cli.storeACredentialOrSayWhatS'),
    usage: message('cli.cli.riosomaLoginUrlAddressTokenTokenBrowser'),
    flags: { ...LOGIN_FLAGS, ...HELP_FLAGS },
    run: login,
    notes: [
      message('cli.cli.withAToken'),
      message('cli.cli.riosomaLoginUrlAddressTokenRioPat'),
      message('cli.cli.withABrowserWhichNeedsAnOauth'),
      message('cli.cli.riosomaLoginBrowserUrlAddressClientId'),
      message('cli.cli.withNothingToStoreItSaysWhat'),
      message('cli.cli.theCredentialGoesInTheOperatingSystem'),
    ],
  },
  logout: {
    summary: message('cli.cli.forgetAStoredCredential'),
    usage: message('cli.cli.riosomaLogoutProfileName'),
    flags: { ...LOGOUT_FLAGS, ...HELP_FLAGS },
    run: logout,
  },
};

const ENVIRONMENT = [
  message('cli.cli.riosomaUrlTheServerToTalkTo'),
  message('cli.cli.riosomaTokenAPersonalAccessToken'),
  message('cli.cli.riosomaProfileWhichStoredCredentialToUse'),
  message('cli.cli.riosomaClientIdTheOauthAppA'),
  message('cli.cli.riosomaCliHomeWhereCredentialsAreKept'),
  message('cli.cli.riosomaKeychainOffToKeepCredentialsIn'),
];

/** Runs the tool and says how it ended, which is the whole of what `main` does. */
export async function runCli(argv: readonly string[], io: Io = terminalIo()): Promise<number> {
  const [name, ...rest] = argv;
  try {
    if (!name || name === 'help') {
      if (rest.length && !rest[0]!.startsWith('-')) return help(rest[0]!, io);
      io.print(overview());
      return 0;
    }
    if (name === '--version' || name === '-v') {
      io.print(version());
      return 0;
    }
    if (name === '--help' || name === '-h') {
      io.print(overview());
      return 0;
    }
    const command = COMMANDS[name];
    if (!command) {
      io.warn(message('cli.cli.thereSNoCommand', { name: name }));
      io.warn('');
      io.warn(overview());
      return 2;
    }
    const args = parseArgs(rest, command.flags);
    // A run's own Io, with what the command line asked of the output taken into it.
    const run: Io = {
      ...io,
      json: args.boolean('json') || io.json,
      quiet: args.boolean('quiet') || io.quiet,
    };
    if (args.boolean('help')) return help(name, io);
    await command.run(args, run);
    return 0;
  } catch (error) {
    return report(error, io);
  }
}

function help(name: string, io: Io): number {
  const command = COMMANDS[name];
  if (!command) {
    io.warn(message('cli.cli.thereSNoCommand', { name: name }));
    io.print(overview());
    return 2;
  }
  io.print(command.summary);
  io.print('');
  io.print(message('cli.cli.usage'));
  io.print(`  ${command.usage}`);
  if (command.notes?.length) {
    io.print('');
    for (const line of command.notes) io.print(line.startsWith('  ') ? line : `  ${line}`);
  }
  io.print('');
  io.print(message('cli.cli.options'));
  io.print(flagHelp(command.flags));
  return 0;
}

function flagHelp(flags: FlagSpecs): string {
  const own = Object.entries(flags).filter(([name]) => !(name in GLOBAL_FLAGS) && !(name in HELP_FLAGS));
  const shared = Object.entries(flags).filter(([name]) => name in GLOBAL_FLAGS || name in HELP_FLAGS);
  const lines = [...own, ...shared].map(([name, spec]) => {
    const short = spec.short ? `-${spec.short}, ` : '    ';
    const value = spec.value ? message('cli.cli.value') : '';
    return `  ${short}--${name}${value}`.padEnd(30) + (spec.help ?? '');
  });
  return lines.join('\n');
}

function overview(): string {
  const commands = Object.entries(COMMANDS).map(
    ([name, command]) => `  ${name}`.padEnd(12) + command.summary,
  );
  return [
    message('cli.cli.theRiosomaCommandLine'),
    '',
    message('cli.cli.usage'),
    message('cli.cli.riosomaCommandOptions'),
    '',
    message('cli.cli.commands'),
    ...commands,
    message('cli.cli.help').padEnd(13) + message('cli.cli.showThisHelpOrOneCommandS'),
    '',
    message('cli.cli.options'),
    message('cli.cli.urlAddress').padEnd(30) + message('cli.cli.theServerToTalkTo'),
    message('cli.cli.tokenToken').padEnd(30) + message('cli.cli.aPersonalAccessTokenInsteadOfThe'),
    message('cli.cli.profileName').padEnd(30) + message('cli.cli.whichStoredCredentialToUseWhichDefaults'),
    message('cli.cli.json').padEnd(30) + message('cli.cli.printJsonInsteadOfATable'),
    message('cli.cli.hHelp').padEnd(30) + message('cli.cli.showThisHelp'),
    message('cli.cli.vVersion').padEnd(30) + message('cli.cli.showTheVersion'),
    '',
    message('cli.cli.environment'),
    ...ENVIRONMENT.map((line) => `  ${line}`),
    '',
    message('cli.cli.runRiosomaHelpCommandForACommand'),
  ].join('\n');
}

/** The version the tool was built as, read from the manifest beside it. */
export function version(): string {
  try {
    const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
      version?: string;
    };
    return manifest.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

/** What a failure says, and how the tool ends because of it. */
function report(error: unknown, io: Io): number {
  if (error instanceof UsageError) {
    io.warn(error.message);
    io.warn(message('cli.cli.runRiosomaHelpForTheCommandsAnd'));
    return 2;
  }
  if (error instanceof Failure) {
    io.warn(error.message);
    if (error.details.hint) io.warn(error.details.hint);
    return 1;
  }
  if (error instanceof RioApiError) {
    io.warn(
      message('cli.cli.theServerRefusedTheCall', {
        value1: error.status,
        value2: error.code,
        value3: error.message,
      }),
    );
    // A write says which cell was refused, which is the first thing a person needs.
    const field = typeof error.params?.field === 'string' ? error.params : null;
    if (field)
      io.warn(
        message('cli.cli.field', {
          value1: String(field.field),
          value2:
            typeof field.recordIndex === 'number'
              ? message('cli.cli.record', { value1: Number(field.recordIndex) + 1 })
              : '',
        }),
      );
    for (const [name, message] of Object.entries(error.fields ?? {})) io.warn(`  ${name}: ${message}`);
    for (const issue of error.issues ?? [])
      io.warn(`  ${issue.recordId} ${issue.fieldId}: ${issue.message ?? issue.messageKey}`);
    if (error.status === 401) io.warn(message('cli.cli.signInAgainWithRiosomaLoginOr'));
    if (error.status === 403 && error.messageKey === 'errors.tokenScope')
      io.warn(message('cli.cli.theTokenNeedsAScopeItDoesn'));
    if (error.status === 429)
      io.warn(
        message('cli.cli.theServerAskedToWait', {
          value1:
            error.retryAfterSeconds === null
              ? ''
              : message('cli.cli.seconds', { value1: error.retryAfterSeconds }),
        }),
      );
    if (error.undoGroupId) io.warn(message('cli.cli.undoGroup', { value1: error.undoGroupId }));
    return 1;
  }
  if (error instanceof RioClientError) {
    io.warn(error.message);
    if (error.code === 'unreachable') io.warn(message('cli.cli.checkTheAddressAndThatThisMachine'));
    return 1;
  }
  if (error instanceof Error) {
    io.warn(error.message);
    // A fault nobody could have expected shows its stack only when it's being looked into.
    if (io.env.RIOSOMA_DEBUG) io.warn(error.stack ?? '');
    return 1;
  }
  io.warn(String(error));
  return 1;
}
