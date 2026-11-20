import { ReportBuilder as CoreReportBuilder } from '../core/report.js';

/**
 * The report an Airtable import leaves with its database: a line for each table, field, and view
 * that came across exactly, and one for each way something changed or was left out.
 */
export class ReportBuilder extends CoreReportBuilder {
  constructor() {
    super('import.airtable.report.exact');
  }
}
