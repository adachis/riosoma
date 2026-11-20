/**
 * Google Sheets sources: the sheets of the spreadsheets a service account can open.  The server
 * registers the connector with its own guarded network, the one file and API sources use.
 */
export {
  createGoogleSheetsConnector,
  GOOGLE_SHEETS_URL,
  GOOGLE_TOKEN_URL,
  ROW_NUMBER,
  SHEETS_KEYS,
  sheetCell,
  sheetColumnNames,
  type SheetsConnector,
  type SheetsConnectorOptions,
} from './connector.js';
export {
  googleProblem,
  readServiceAccountKey,
  serviceAccountAssertion,
  SHEETS_READ_SCOPE,
  type ServiceAccountKey,
} from './google.js';
