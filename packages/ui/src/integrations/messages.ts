import { setupI18n, type Messages } from '@lingui/core';

/**
 * Display strings shared by the browser clipper and the Zapier app.  Each one is a Lingui message
 * descriptor, so extraction adds it to the app's catalogs beside every other string.
 */
export const integrationMessages = {
  'integration.name': /*i18n*/ { id: 'integration.name', message: 'Riosoma' },
  'integration.server': /*i18n*/ { id: 'integration.server', message: 'Server address' },
  'integration.client': /*i18n*/ { id: 'integration.client', message: 'OAuth client ID' },
  'integration.database': /*i18n*/ { id: 'integration.database', message: 'Database' },
  'integration.table': /*i18n*/ { id: 'integration.table', message: 'Table' },
  'integration.view': /*i18n*/ { id: 'integration.view', message: 'View' },
  'integration.record': /*i18n*/ { id: 'integration.record', message: 'Record ID' },
  'integration.event': /*i18n*/ { id: 'integration.event', message: 'Event ID' },
  'integration.field': /*i18n*/ { id: 'integration.field', message: 'Search field' },
  'integration.value': /*i18n*/ { id: 'integration.value', message: 'Search value' },
  'integration.choose': /*i18n*/ { id: 'integration.choose', message: 'Choose an option' },
  'integration.invalid': /*i18n*/ {
    id: 'integration.invalid',
    message: 'Check the selected table, fields, and values.',
  },
  'integration.failed': /*i18n*/ { id: 'integration.failed', message: 'The request failed.  Try again.' },
  'integration.signInAgain': /*i18n*/ {
    id: 'integration.signInAgain',
    message: 'Sign in again to continue.',
  },
  'integration.secureOrigin': /*i18n*/ {
    id: 'integration.secureOrigin',
    message: 'Enter an address that starts with https:// and has no path, query, or password.',
  },
  'integration.json': /*i18n*/ { id: 'integration.json', message: 'Enter a JSON value for this field.' },
  'integration.newRecord': /*i18n*/ { id: 'integration.newRecord', message: 'New Record' },
  'integration.newRecordDescription': /*i18n*/ {
    id: 'integration.newRecordDescription',
    message: 'Triggers when a record is created in the table.',
  },
  'integration.updatedRecord': /*i18n*/ { id: 'integration.updatedRecord', message: 'Updated Record' },
  'integration.updatedRecordDescription': /*i18n*/ {
    id: 'integration.updatedRecordDescription',
    message: 'Triggers when a record is updated in the table.',
  },
  'integration.viewRecord': /*i18n*/ { id: 'integration.viewRecord', message: 'New Record in a View' },
  'integration.viewRecordDescription': /*i18n*/ {
    id: 'integration.viewRecordDescription',
    message: 'Triggers when a newly created record matches the view.',
  },
  'integration.create': /*i18n*/ { id: 'integration.create', message: 'Create Record' },
  'integration.createDescription': /*i18n*/ {
    id: 'integration.createDescription',
    message: 'Creates a record using the selected fields.',
  },
  'integration.update': /*i18n*/ { id: 'integration.update', message: 'Update Record' },
  'integration.updateDescription': /*i18n*/ {
    id: 'integration.updateDescription',
    message: 'Updates only the fields supplied for a record.',
  },
  'integration.find': /*i18n*/ { id: 'integration.find', message: 'Find Records' },
  'integration.findDescription': /*i18n*/ {
    id: 'integration.findDescription',
    message: 'Finds records with an exact field value.',
  },
  'integration.findCreate': /*i18n*/ { id: 'integration.findCreate', message: 'Find or Create Record' },
  'integration.findCreateDescription': /*i18n*/ {
    id: 'integration.findCreateDescription',
    message: 'Finds a matching record, or creates one when none is found.',
  },
  'integration.signature': /*i18n*/ {
    id: 'integration.signature',
    message: 'The webhook signature is missing, expired, or invalid.',
  },
  'clipper.name': /*i18n*/ { id: 'clipper.name', message: 'Riosoma clipper' },
  'clipper.description': /*i18n*/ {
    id: 'clipper.description',
    message: 'Save a page, selected text, and an optional screenshot to Riosoma.',
  },
  'clipper.address': /*i18n*/ { id: 'clipper.address', message: 'Riosoma address' },
  'clipper.signIn': /*i18n*/ { id: 'clipper.signIn', message: 'Sign in' },
  'clipper.signOut': /*i18n*/ { id: 'clipper.signOut', message: 'Sign out' },
  'clipper.redirect': /*i18n*/ {
    id: 'clipper.redirect',
    message: 'Register this redirect address in your OAuth app',
  },
  'clipper.title': /*i18n*/ { id: 'clipper.title', message: 'Page title' },
  'clipper.url': /*i18n*/ { id: 'clipper.url', message: 'Page URL' },
  'clipper.selection': /*i18n*/ { id: 'clipper.selection', message: 'Selected text' },
  'clipper.titleField': /*i18n*/ { id: 'clipper.titleField', message: 'Title field' },
  'clipper.urlField': /*i18n*/ { id: 'clipper.urlField', message: 'URL field' },
  'clipper.selectionField': /*i18n*/ { id: 'clipper.selectionField', message: 'Selected text field' },
  'clipper.screenshotField': /*i18n*/ { id: 'clipper.screenshotField', message: 'Screenshot field' },
  'clipper.screenshot': /*i18n*/ {
    id: 'clipper.screenshot',
    message: 'Include a screenshot of the visible page',
  },
  'clipper.save': /*i18n*/ { id: 'clipper.save', message: 'Save page' },
  'clipper.saving': /*i18n*/ { id: 'clipper.saving', message: 'Saving the page…' },
  'clipper.saved': /*i18n*/ { id: 'clipper.saved', message: 'Page saved.' },
  'clipper.open': /*i18n*/ { id: 'clipper.open', message: 'Open record' },
  'clipper.help': /*i18n*/ { id: 'clipper.help', message: 'Help' },
  'clipper.helpText': /*i18n*/ {
    id: 'clipper.helpText',
    message:
      'Enter your Riosoma address and sign in.  Then choose a database and table, and map each page value to a field.  A screenshot captures only the visible page and is saved after you select Save page.',
  },
  'clipper.back': /*i18n*/ { id: 'clipper.back', message: 'Back to the page' },
  'clipper.captureFailed': /*i18n*/ {
    id: 'clipper.captureFailed',
    message: 'This page cannot be captured.  Open a regular web page and try again.',
  },
  'clipper.authFailed': /*i18n*/ {
    id: 'clipper.authFailed',
    message: 'Sign-in could not be verified.  Try signing in again.',
  },
  'clipper.permissionDenied': /*i18n*/ {
    id: 'clipper.permissionDenied',
    message: 'Allow the clipper to reach your Riosoma address, then sign in again.',
  },
  'clipper.noTables': /*i18n*/ {
    id: 'clipper.noTables',
    message: 'No tables are available in this database.',
  },
} as const;

export type IntegrationMessage = keyof typeof integrationMessages;
export type Catalog = Messages;

const i18n = setupI18n();
let localized = false;

/** Switches to a compiled catalog.  Until then, every string is its American English source. */
export function activate(locale: string, messages: Messages): void {
  i18n.loadAndActivate({ locale, messages });
  localized = true;
}

export function message(id: IntegrationMessage): string {
  const descriptor = integrationMessages[id];
  return localized ? i18n._(descriptor) : descriptor.message;
}

export function isIntegrationMessage(value: unknown): value is IntegrationMessage {
  return typeof value === 'string' && Object.hasOwn(integrationMessages, value);
}

/** An error that keeps its message ID, so another context can show it in its own language. */
export class IntegrationError extends Error {
  readonly key: IntegrationMessage;
  constructor(key: IntegrationMessage) {
    super(message(key));
    this.key = key;
  }
}

export function errorKey(error: unknown): IntegrationMessage {
  return error instanceof IntegrationError ? error.key : 'integration.failed';
}
