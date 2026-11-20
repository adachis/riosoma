/**
 * Microsoft 365 sources: SharePoint lists, Excel workbooks in SharePoint or OneDrive, and Dataverse
 * tables, each read as an Entra app.  The server registers them with its own guarded network, and
 * gives the workbook source its workbook reader.
 */
export {
  ENTRA_LOGIN_URL,
  entraCodes,
  GRAPH_API_URL,
  MICROSOFT_KEYS,
  microsoftProblem,
  nearestDay,
  type MicrosoftOptions,
} from './client.js';
export {
  createSharePointListConnector,
  ITEM_ID,
  SHAREPOINT_KEYS,
  type SharePointOptions,
} from './sharepoint.js';
export { createExcelOnlineConnector, EXCEL_KEYS, type ExcelOnlineOptions } from './excel.js';
export { createDataverseConnector, DATAVERSE_KEYS, ROW_ID, type DataverseOptions } from './dataverse.js';
