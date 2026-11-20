import { analyze, prepareColumns, type Column } from './columns';
import { numberedRows, sourceRows, type ImportSource } from './source';
import { planUpsert, type PlanRequest } from './upsert';

/**
 * The worker's jobs, run on the page instead, for tests: a test environment has no module workers,
 * and running the same functions here keeps the dialogs' tests about the dialogs.
 */
export function inspectFile(source: ImportSource, header: boolean) {
  return analyze(sourceRows(source), header);
}
export function validateFile(
  source: ImportSource,
  columns: Column[],
  header: boolean,
  existing: boolean,
  timeZone: string,
) {
  return prepareColumns(sourceRows(source), columns, header, existing, timeZone);
}
export function planFile(source: ImportSource, header: boolean, request: PlanRequest) {
  return planUpsert(numberedRows(source), header, request);
}
export function streamFile(source: ImportSource) {
  return sourceRows(source);
}
