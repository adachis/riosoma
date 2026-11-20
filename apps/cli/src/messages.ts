/** English messages are keyed here because the command line has no locale runtime. */
const messages = {
  'cli.credentials.label': 'Riosoma command line',
  'cli.login.pageTitle': 'Riosoma',
  'cli.login.pageHeading': 'You can close this tab.',
  'cli.login.pageBody': 'The command line has what it needs.  Nothing else is sent from here.',
  'cli.records.missingTable':
    'Say which database and table, as `riosoma records {action} <database> <table>`.',
  'cli.count.record.one': '{count} record',
  'cli.count.record.many': '{count} records',
  'cli.count.request.one': '{count} request',
  'cli.count.request.many': '{count} requests',
  'cli.count.database.one': '{count} database',
  'cli.count.database.many': '{count} databases',

  'cli.credentials.writeFailed': 'The keychain could not keep this credential.',
  'cli.credentials.readFailed': 'The keychain could not read the stored credentials.',
  'cli.credentials.deleteFailed': 'The keychain could not remove the stored credentials.',
  'cli.credentials.tooLarge': 'This credential is too large for the keychain input.',
  'cli.args.thisCommandNeedsTryRiosomaHelp': 'This command needs --{name}.  Try riosoma help.',
  'cli.args.needsAValueAfterIt': '-{letter} needs a value after it.',
  'cli.args.thereSNoOptionTryRiosomaHelp': "There's no option -{letter}.  Try riosoma help.",
  'cli.args.needsAValueAfterIt2': '--{name} needs a value after it.',
  'cli.args.takesNoValue': '--{name} takes no value.',
  'cli.args.thereSNoOptionTryRiosomaHelp2': "There's no option --{name}.  Try riosoma help.",
  'cli.cli.checkTheAddressAndThatThisMachine': 'Check the address, and that this machine can reach it.',
  'cli.cli.undoGroup': 'Undo group: {value1}.',
  'cli.cli.seconds': ' {value1} seconds',
  'cli.cli.theServerAskedToWait': 'The server asked to wait{value1}.',
  'cli.cli.theTokenNeedsAScopeItDoesn':
    'The token needs a scope it doesn’t have.  Make another in the app’s settings.',
  'cli.cli.signInAgainWithRiosomaLoginOr':
    'Sign in again with `riosoma login`, or give a token with --token.',
  'cli.cli.record': ' (record {value1})',
  'cli.cli.field': '  Field: {value1}{value2}',
  'cli.cli.theServerRefusedTheCall': 'The server refused the call ({value1}, {value2}): {value3}',
  'cli.cli.runRiosomaHelpForTheCommandsAnd': 'Run `riosoma help` for the commands and their options.',
  'cli.cli.runRiosomaHelpCommandForACommand': "Run `riosoma help <command>` for a command's own options.",
  'cli.cli.environment': 'Environment:',
  'cli.cli.showTheVersion': 'Show the version',
  'cli.cli.vVersion': '  -v, --version',
  'cli.cli.showThisHelp': 'Show this help',
  'cli.cli.hHelp': '  -h, --help',
  'cli.cli.printJsonInsteadOfATable': 'Print JSON instead of a table',
  'cli.cli.json': '  --json',
  'cli.cli.whichStoredCredentialToUseWhichDefaults':
    'Which stored credential to use, which defaults to "default"',
  'cli.cli.profileName': '  --profile <name>',
  'cli.cli.aPersonalAccessTokenInsteadOfThe': 'A personal access token, instead of the stored credential',
  'cli.cli.tokenToken': '  --token <token>',
  'cli.cli.theServerToTalkTo': 'The server to talk to',
  'cli.cli.urlAddress': '  --url <address>',
  'cli.cli.options': 'Options:',
  'cli.cli.showThisHelpOrOneCommandS': "Show this help, or one command's",
  'cli.cli.help': '  help',
  'cli.cli.commands': 'Commands:',
  'cli.cli.riosomaCommandOptions': '  riosoma <command> [options]',
  'cli.cli.usage': 'Usage:',
  'cli.cli.theRiosomaCommandLine': 'The Riosoma command line.',
  'cli.cli.value': ' <value>',
  'cli.cli.thereSNoCommand': 'There\'s no command "{name}".',
  'cli.cli.riosomaKeychainOffToKeepCredentialsIn': 'RIOSOMA_KEYCHAIN   off, to keep credentials in that file',
  'cli.cli.riosomaCliHomeWhereCredentialsAreKept':
    'RIOSOMA_CLI_HOME   where credentials are kept when a file holds them',
  'cli.cli.riosomaClientIdTheOauthAppA': 'RIOSOMA_CLIENT_ID  the OAuth app a browser sign-in uses',
  'cli.cli.riosomaProfileWhichStoredCredentialToUse': 'RIOSOMA_PROFILE    which stored credential to use',
  'cli.cli.riosomaTokenAPersonalAccessToken': 'RIOSOMA_TOKEN      a personal access token',
  'cli.cli.riosomaUrlTheServerToTalkTo': 'RIOSOMA_URL        the server to talk to',
  'cli.cli.riosomaLogoutProfileName': 'riosoma logout [--profile <name>]',
  'cli.cli.forgetAStoredCredential': 'Forget a stored credential',
  'cli.cli.theCredentialGoesInTheOperatingSystem':
    'The credential goes in the operating system’s keychain where there is one, and otherwise in a file only this person can read.',
  'cli.cli.withNothingToStoreItSaysWhat':
    'With nothing to store, it says what this profile holds, and --check tries it.',
  'cli.cli.riosomaLoginBrowserUrlAddressClientId':
    '  riosoma login --browser --url <address> --client-id <id>',
  'cli.cli.withABrowserWhichNeedsAnOauth':
    'With a browser, which needs an OAuth app an owner registered as public with a redirect address of http://127.0.0.1/callback:',
  'cli.cli.riosomaLoginUrlAddressTokenRioPat': '  riosoma login --url <address> --token rio_pat_…',
  'cli.cli.withAToken': 'With a token:',
  'cli.cli.riosomaLoginUrlAddressTokenTokenBrowser':
    'riosoma login [--url <address>] [--token <token> | --browser --client-id <id>]',
  'cli.cli.storeACredentialOrSayWhatS': "Store a credential, or say what's stored",
  'cli.cli.theDocumentHoldsEachTableWithIts':
    'The document holds each table with its fields and views, which is what the IDs other commands take come from.',
  'cli.cli.riosomaSchemaDatabaseFilePath': 'riosoma schema <database> [--file <path>]',
  'cli.cli.printOrSaveADatabaseSSchema': "Print or save a database's schema as JSON",
  'cli.cli.eachRecordIsWrittenAsItArrives':
    'Each record is written as it arrives, so a table bigger than memory exports all the same.',
  'cli.cli.riosomaExportPeopleContactsFormatJsonWith':
    "  riosoma export People Contacts --format json --with-id | jq '.[].id'",
  'cli.cli.riosomaExportPeopleContactsFileContactsCsv':
    '  riosoma export People Contacts --file contacts.csv --fields Name,Email',
  'cli.cli.withNoFileTheRecordsGoTo':
    'With no --file the records go to standard output, so the tool sits in a pipe:',
  'cli.cli.riosomaExportDatabaseTableFilePathOptions':
    'riosoma export <database> <table> [--file <path>] [options]',
  'cli.cli.writeATableSRecordsToA': "Write a table's records to a CSV or JSON file",
  'cli.cli.theFileIsReadAsItArrives':
    'The file is read as it arrives, so one bigger than memory imports all the same.',
  'cli.cli.aJsonFileHoldsAnArrayOf':
    'A JSON file holds an array of records, or one per line, each as {"fields": {…}} or {"id": …, "fields": {…}}.',
  'cli.cli.riosomaImportPeopleContactsFileContactsCsv':
    '  riosoma import People Contacts --file contacts.csv --upsert-on Email --batch 200',
  'cli.cli.riosomaImportPeopleContactsFileContactsCsv2':
    '  riosoma import People Contacts --file contacts.csv',
  'cli.cli.aCsvFileSFirstRowNames':
    'A CSV file’s first row names the fields, and a column named id changes those records:',
  'cli.cli.riosomaImportDatabaseTableFilePathOptions':
    'riosoma import <database> <table> --file <path> [options]',
  'cli.cli.readRecordsIntoATableFromA': 'Read records into a table from a CSV or JSON file',
  'cli.cli.riosomaRecordsDeletePeopleContactsRecRec': '  riosoma records delete People Contacts rec… rec…',
  'cli.cli.deleteMovesRecordsToTheTrashWhere':
    'delete moves records to the trash, where the app can restore them:',
  'cli.cli.riosomaRecordsUpdatePeopleContactsUpsertOn':
    '  riosoma records update People Contacts --upsert-on Email --data \'[{"fields":{"Email":"<email>"}}]\'',
  'cli.cli.riosomaRecordsUpdatePeopleContactsIdRec':
    '  riosoma records update People Contacts --id rec… --field Status=Done',
  'cli.cli.updateChangesRecordsThatExistEachNamed': 'update changes records that exist, each named by id:',
  'cli.cli.riosomaRecordsCreatePeopleContactsDataFields':
    '  riosoma records create People Contacts --data \'[{"fields":{"Name":"Ada"}}]\'',
  'cli.cli.riosomaRecordsCreatePeopleContactsFieldName':
    '  riosoma records create People Contacts --field Name=Ada --field Amount=10',
  'cli.cli.createWritesNewRecordsFromJsonText':
    'create writes new records, from JSON text, a file of JSON, or one --field at a time:',
  'cli.cli.riosomaRecordsGetPeopleContactsRec': '  riosoma records get People Contacts rec…',
  'cli.cli.getReadsOneRecordById': 'get reads one record by ID:',
  'cli.cli.riosomaRecordsListPeopleContactsFilterConjunction':
    '  riosoma records list People Contacts --filter \'{"conjunction":"and","conditions":[{"id":"1","fieldId":"Status","operator":"is","value":"Open"}]}\' --sort Due:asc --limit 50',
  'cli.cli.listReadsRecordsAndPagesThroughAs':
    'list reads records, and pages through as many as the table holds:',
  'cli.cli.riosomaRecordsListGetCreateUpdateDelete':
    'riosoma records <list|get|create|update|delete> <database> <table> [options]',
  'cli.cli.listGetCreateUpdateOrDeleteRecords': 'List, get, create, update, or delete records',
  'cli.cli.riosomaTablesDatabaseFields': 'riosoma tables <database> [--fields]',
  'cli.cli.listADatabaseSTablesAndWith': "List a database's tables, and with --fields their fields and views",
  'cli.cli.riosomaDatabases': 'riosoma databases',
  'cli.cli.listTheDatabasesThisCredentialReaches': 'List the databases this credential reaches',
  'cli.context.theFilterIsnTJson': "The filter isn't JSON.  {value1}",
  'cli.context.aSortIsFieldAscOrField': 'A sort is `Field:asc` or `Field:desc`, and "{entry}" is neither.',
  'cli.context.theTableHasNoFieldCalledRiosoma':
    'The table {value1} has no field called "{name}".  `riosoma tables {value3}` lists its fields.',
  'cli.context.thereSNoTableCalledInThis':
    'There\'s no table called "{nameOrId}" in this database.  `riosoma tables {databaseId}` lists them.',
  'cli.context.thereSNoDatabaseCalledThisCredential':
    'There\'s no database called "{nameOrId}" this credential can reach.  `riosoma databases` lists them.',
  'cli.context.theStoredCredential': 'the stored "{profile}" credential',
  'cli.context.theStoredCredentialForIsForNot':
    'The stored credential for "{profile}" is for {value2}, not {url}.  Sign in again, or leave --url out.',
  'cli.context.noCredentialIsStoredForAndNone':
    'No credential is stored for "{profile}", and none was given.  Run `riosoma login --url {url} --token rio_pat_…`.',
  'cli.context.theRiosomaTokenVariable': 'the RIOSOMA_TOKEN variable',
  'cli.context.theTokenOption': 'the --token option',
  'cli.context.noServerWasNamedSignInWith':
    'No server was named.  Sign in with `riosoma login --url <address> --token rio_pat_…`, or say which one this command means with --url.',
  'cli.context.printOnlyWhatTheCommandWasAsked': 'Print only what the command was asked for',
  'cli.context.whichStoredCredentialToUseWhenMore':
    'Which stored credential to use, when more than one is kept',
  'cli.context.theServerToTalkToAsAddress': 'The server to talk to, as <address>',
  'cli.credentials.with': '{value1}{who}, with {what}',
  'cli.credentials.oauthTokens': 'OAuth tokens',
  'cli.credentials.aPersonalAccessToken': 'a personal access token',
  'cli.credentials.as': ' as {value1}',
  'cli.credentials.thereWasNowhereToKeepThisCredential': 'There was nowhere to keep this credential.',
  'cli.credentials.theMacosKeychain': 'the macOS keychain',
  'cli.credentials.theFreedesktopKeyring': 'the freedesktop keyring',
  'cli.files.theFileCouldnTBeWritten': "The file {path} couldn't be written.  {value2}",
  'cli.files.standardOutput': 'standard output',
  'cli.files.theFileCouldnTBeRead': "The file {path} couldn't be read.  {value2}",
  'cli.format.s': '{one}s',
  'cli.format.nothingToShow': 'Nothing to show.',
  'cli.io.notInstalled': 'not installed',
  'cli.json.theJsonEndedInTheMiddleOf': 'The JSON ended in the middle of record {value1}.',
  'cli.json.theJsonHasAnInvalidArrayBoundary': 'The JSON has an invalid array boundary after record {count}.',
  'cli.json.recordIsnTJson': "Record {count} isn't JSON.  {value2}",
  'cli.json.lineIsnTJson': "Line {line} isn't JSON.  {value2}",
  'cli.options.takes': '{name} takes {value2}.',
  'cli.options.or': '{value1}, or {value2}',
  'cli.options.takesAWholeNumberFromTo': '{name} takes a whole number from {min} to {max}.',
  'cli.options.delimiterTakesOneCharacterOrTheWord':
    '--delimiter takes one character, or the word tab or semicolon.',
  'cli.options.batchTakesAWholeNumberFromTo': '--batch takes a whole number from 1 to {largest}.',
  'cli.options.limitTakesAWholeNumberOfRecords':
    '--limit takes a whole number of records, or 0 for every one.',
  'cli.login.forgotEveryStoredCredential': 'Forgot every stored credential.',
  'cli.login.forgotTheCredentialStoredFor': 'Forgot the credential stored for "{name}".',
  'cli.login.noCredentialsAreStored': 'No credentials are stored.',
  'cli.login.nothingWasStoredFor': 'Nothing was stored for "{name}".',
  'cli.login.theSignInEndedBeforeTheBrowser': 'The sign-in ended before the browser came back.',
  'cli.login.noApprovalArrivedInTimeRunThe': 'No approval arrived in time.  Run the sign-in again.',
  'cli.login.theAccessTokenWillBeReplacedWith':
    'The access token will be replaced with a fresh one when it runs out.',
  'cli.login.scopes': 'Scopes: {value1}.',
  'cli.login.storedInAs': 'Stored in {value1} as "{profile}".',
  'cli.login.signedIn': 'Signed in.',
  'cli.login.theRedirectCarriedNoCode': 'The redirect carried no code.',
  'cli.login.theServerRefusedTheSignIn': 'The server refused the sign-in: {value1}.',
  'cli.login.theRedirectCarriedAStateThisTool':
    'The redirect carried a state this tool didn’t send, so it was ignored.',
  'cli.login.waitingUpToSecondsForTheApproval': 'Waiting up to {seconds} seconds for the approval.',
  'cli.login.noBrowserOpenedCopyTheAddressAbove': 'No browser opened.  Copy the address above into one.',
  'cli.login.aBrowserShouldHaveOpenedApproveThe':
    'A browser should have opened.  Approve the connection there.',
  'cli.login.openThisAddressToSignIn': 'Open this address to sign in:',
  'cli.login.theAppExplainsThisInItsRegistering':
    'The app explains this in its "Registering an OAuth app" help module.',
  'cli.login.aBrowserSignInNeedsTheId':
    'A browser sign-in needs the ID of an OAuth app.  Ask an owner to register one, public, with a redirect address of http://127.0.0.1/callback, and pass its ID as --client-id.',
  'cli.login.itDoesnTWorkAnyMore': "It doesn't work any more: {value1}",
  'cli.login.itReaches': 'It reaches {value1}.',
  'cli.login.theAccessTokenHasRunOutAnd':
    'The access token has run out, and the next call replaces it with a fresh one.',
  'cli.login.theAccessTokenRunsOutOn': 'The access token runs out on {value1}.',
  'cli.login.storedOn': 'Stored on {value1}.',
  'cli.login.holds': '"{profile}" holds {value2}.',
  'cli.login.nothingIsStoredForRunRiosomaLogin':
    'Nothing is stored for "{profile}".  Run `riosoma login --url https://… --token rio_pat_…`, or `riosoma login --browser --url https://… --client-id …`.',
  'cli.login.reachableWithIt': '{value1} reachable with it.',
  'cli.login.signedInToWithAPersonalAccess': 'Signed in to {url} with a personal access token.',
  'cli.login.sayWhichServerToSignInTo': 'Say which server to sign in to, as --url <address>.',
  'cli.login.forgetEveryStoredCredentialNotJustThis':
    'Forget every stored credential, not just this profile’s',
  'cli.login.withNoTokenGivenTryTheStored':
    'With no token given, try the stored credential and say whether it works',
  'cli.login.printTheAddressButDonTTry': "Print the address but don't try to open a browser",
  'cli.login.howManySecondsToWaitForThe': 'How many seconds to wait for the browser, which defaults to 300',
  'cli.login.theScopesToAskForCommaSeparated': 'The scopes to ask for, comma separated',
  'cli.login.theOauthAppToSignInWith': 'The OAuth app to sign in with, which an owner registers',
  'cli.login.signInWithOauthInABrowser': 'Sign in with OAuth in a browser instead of giving a token',
  'cli.records.recordId': 'Record ID',
  'cli.records.recordHasToSayWhichRecordIt':
    'Record {value1} has to say which record it changes, with an id.',
  'cli.records.recordHasNoFields': 'Record {value1} has no fields.',
  'cli.records.recordIsnTAnObject': "Record {value1} isn't an object.",
  'cli.records.dataIsnTJson': "--data isn't JSON.  {value1}",
  'cli.records.sayWhichRecordToChangeWithId':
    'Say which record to change with --id, or write records with --data.',
  'cli.records.aValueIsWrittenFieldNameValue': 'A value is written --field Name=value, and "{entry}" isn\'t.',
  'cli.records.sayWhatToWriteWithDataFile':
    'Say what to write, with --data, --file, or one or more --field Name=value.',
  'cli.records.giveRecordsWithOneOfNotMore': 'Give records with one of {value1}, not more.',
  'cli.records.groups': 'groups',
  'cli.records.group': 'group',
  'cli.records.undo': 'Undo {value1}: {value2}.',
  'cli.records.movedToTheTrashWhereTheyCan': 'Moved {value1} to the trash, where they can be restored.',
  'cli.records.sayWhichRecordsToDeleteAsRiosoma':
    'Say which records to delete, as `riosoma records delete <database> <table> <record>…`.',
  'cli.records.newChanged': '{value1} new, {value2} changed.',
  'cli.records.in': '{verb} {value2} in {value3}.',
  'cli.records.updated': 'Updated',
  'cli.records.created': 'Created',
  'cli.records.wrote': 'Wrote',
  'cli.records.sayWhichRecordToReadAsRiosoma':
    'Say which record to read, as `riosoma records get <database> <table> <record>`.',
  'cli.records.from': '{value1} from {value2}.',
  'cli.records.noRecords': 'No records.',
  'cli.records.sayWhatToDoWithRecordsAs':
    'Say what to do with records, as `riosoma records list <database> <table>`.',
  'cli.records.thereSNoRiosomaRecordsItTakes':
    "There's no `riosoma records {action}`.  It takes list, get, create, update, or delete.",
  'cli.records.fieldsCommaSeparatedThatAWriteMatches':
    'Fields, comma separated, that a write matches records by',
  'cli.records.sendValuesExactlyAsTheyWereGiven': 'Send values exactly as they were given',
  'cli.records.readValuesAsTextWhereAField': 'Read values as text where a field can take either',
  'cli.records.theRecordAFieldWriteChanges': 'The record a --field write changes',
  'cli.records.oneValueToWriteAsNameValue': 'One value to write, as Name=value, repeated',
  'cli.records.aFileOfJsonRecordsToWrite': 'A file of JSON records to write, or - for standard input',
  'cli.records.theRecordsToWriteAsJson': 'The records to write, as JSON',
  'cli.records.aLocaleForValuesFormattedAsText': 'A locale, for values formatted as text',
  'cli.records.anIanaTimeZoneForValuesThat': 'An IANA time zone, for values that follow the reader',
  'cli.records.nameToKeyFieldsByNameOr': 'name to key fields by name, or id by ID',
  'cli.records.jsonForValuesAsDataOrString':
    'json for values as data, or string for values as the app shows them',
  'cli.records.howManyRecordsARequestReadsUp': 'How many records a request reads, up to 100',
  'cli.records.theMostRecordsToReadWhereMeans': 'The most records to read, where 0 means every one',
  'cli.records.theFieldsToReadCommaSeparated': 'The fields to read, comma separated',
  'cli.records.sortsAsFieldDescFieldAsc': 'Sorts as Field:desc,Field2:asc',
  'cli.records.aFilterAsJsonNamingFieldsBy': 'A filter as JSON, naming fields by name or ID',
  'cli.records.aViewToReadThroughByName': 'A view to read through, by name or ID',
  'cli.schema.savedTheSchemaOfTo': 'Saved the schema of {value1} to {value2}.',
  'cli.schema.sayWhichDatabaseToReadAsRiosoma': 'Say which database to read, as `riosoma schema <database>`.',
  'cli.schema.views': 'Views',
  'cli.schema.fields': 'Fields',
  'cli.schema.id': 'ID',
  'cli.schema.table': 'Table',
  'cli.schema.type': 'Type',
  'cli.schema.tableFieldOrView': 'Table, field, or view',
  'cli.schema.view': '{value1} view',
  'cli.schema.fields2': '{value1} fields',
  'cli.schema.sayWhichDatabaseToListAsRiosoma': 'Say which database to list, as `riosoma tables <database>`.',
  'cli.schema.starred': 'Starred',
  'cli.schema.role': 'Role',
  'cli.schema.database': 'Database',
  'cli.schema.yes': 'yes',
  'cli.schema.whereToSaveTheSchemaOrFor': 'Where to save the schema, or - for standard output',
  'cli.schema.listEachTableSFieldsUnderIt': 'List each table’s fields under it, with their types',
  'cli.transfer.theFileHeldNoRowsAtAll': 'The file held no rows at all.',
  'cli.transfer.lineNamesARecordButHasNo': 'Line {line} names a record but has no values for it.',
  'cli.transfer.theFileHasNoHeadingRowNaming': 'The file has no heading row naming its fields.',
  'cli.transfer.recordInTheFileHasNoFields': 'Record {count} in the file has no fields.',
  'cli.transfer.recordInTheFileIsnTAn': "Record {count} in the file isn't an object.",
  'cli.transfer.sayWhichDatabaseAndTableAsRiosoma':
    'Say which database and table, as `riosoma export <database> <table>`.',
  'cli.transfer.exportedFromTo': 'Exported {value1} from {value2} to {value3}.',
  'cli.transfer.newChanged': '  {value1} new, {value2} changed.',
  'cli.transfer.importedIntoIn': 'Imported {value1} into {value2} in {value3}.',
  'cli.transfer.theImportStoppedAfter': 'The import stopped after {value1}.  {value2}',
  'cli.transfer.imported': 'Imported {value1}…',
  'cli.transfer.thisFileNamesRecordsToChangeAnd':
    'This file names records to change and records to make.  Give it an id column for every row, none at all, or say what to merge on with --upsert-on.',
  'cli.transfer.sayWhichFileToReadWithFile': 'Say which file to read with --file, or - for standard input.',
  'cli.transfer.writeALeadingIdColumnSoAn': 'Write a leading id column, so an import changes these records',
  'cli.transfer.theMostRecordsToWriteWhereMeans': 'The most records to write, where 0 means every one',
  'cli.transfer.theFieldsToWriteCommaSeparated': 'The fields to write, comma separated',
  'cli.transfer.whatSeparatesCsvFieldsWhichDefaultsTo':
    'What separates CSV fields, which defaults to a comma',
  'cli.transfer.csvOrJsonWhichTheFileS': 'csv or json, which the file’s name decides when this is left out',
  'cli.transfer.whereToWriteOrForStandardOutput': 'Where to write, or - for standard output',
  'cli.transfer.fieldsCommaSeparatedThatRecordsAreMatched':
    'Fields, comma separated, that records are matched by',
  'cli.transfer.sendValuesExactlyAsTheFileHolds': 'Send values exactly as the file holds them',
  'cli.transfer.readValuesAsTextWhereAField':
    'Read values as text where a field can take either, which a CSV import needs',
  'cli.transfer.howManyRecordsARequestCarriesUp': 'How many records a request carries, up to {LARGEST_BATCH}',
  'cli.transfer.theFileToReadOrForStandard': 'The file to read, or - for standard input',
} as const;

export type MessageId = keyof typeof messages;

export function message(id: MessageId, values: Record<string, string | number> = {}): string {
  return messages[id].replace(/\{(\w+)\}/g, (placeholder, name: string) =>
    Object.hasOwn(values, name) ? String(values[name]) : placeholder,
  );
}
