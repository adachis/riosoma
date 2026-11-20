import type {
  DateRange,
  DateTarget,
  FieldOptionsOf,
  FieldSpec,
  ImportPlatform,
  Operator,
  RollupFunction,
  ViewType,
} from '@riosoma/contracts';
import type { Attachment } from '../core/files.js';
import type { Note } from '../core/report.js';

/**
 * A base as each tool's reader hands it over: its tables, each field already planned as the
 * closest Riosoma field, and its views with the settings the tool shares.  The job that brings it
 * across works only from this, so every tool shares one way of making the database, bringing
 * records and files across, linking them, turning computed fields on, and writing the report.  IDs
 * here are the tool's own.
 */

export interface SourceField {
  id: string;
  name: string;
  description?: string | null;
}

type DateFormatName = FieldOptionsOf<'date'>['dateFormat'];

export interface FormulaOptions {
  precision: number | null;
  dateFormat: DateFormatName;
  timeFormat: 'local' | '12h' | '24h';
  timeZone: string;
}

/**
 * The link a lookup, rollup, or count reads through: a link field on its own table, by the tool's
 * ID, or the other side of a link field on another table, which is how Grist's formulas that look
 * records up read.  `shown` is the formula it came from, when it came from one, and its results
 * are checked against the tool's.
 */
export type Relation =
  | { link: string; via?: undefined; shown?: string }
  | { link?: undefined; via: { table: string; field: string }; shown?: string };

/** What a computed field turns into once records and links are in. */
export type Finish =
  | {
      kind: 'formula';
      /** The formula as the tool shows it, for the report */
      shown: string;
      /**
       * The formula in Riosoma's language, with fields named in braces by the tool's field ID or
       * name, or null when it couldn't be written that way
       */
      expression: string | null;
      /** Why it couldn't, when it couldn't */
      problem?: 'invalid' | 'syntax' | 'functions' | 'fields';
      /** Functions it calls that have no match here */
      functions?: string[];
      options: FormulaOptions;
    }
  | ({ kind: 'lookup'; target: string } & Relation)
  | ({ kind: 'rollup'; target: string; fn: RollupFunction } & Relation)
  | ({ kind: 'count' } & Relation)
  | { kind: 'autoNumber' }
  | { kind: 'people'; allowMultiple: boolean };

interface PlanBase {
  source: SourceField;
  /** The field's ID here.  The other side of a link gets its ID when the link is made. */
  id: string;
  name: string;
  notes: Note[];
}

export type FieldPlan =
  | (PlanBase & {
      kind: 'value';
      spec: FieldSpec;
      /** Reads one cell.  What doesn't fit is caught when the value is checked. */
      read(value: unknown): unknown;
      finish?: Finish;
      /** Email addresses a people field has seen, in lowercase */
      people?: Set<string>;
    })
  | (PlanBase & {
      kind: 'files';
      /** The files a cell names */
      read(value: unknown): Attachment[];
    })
  | (PlanBase & {
      kind: 'link';
      /** The linked table, by the tool's ID */
      linkedTable: string;
      /** The field on the linked table that shows the other side, by the tool's ID */
      inverse: string | null;
      prefersSingle: boolean;
      /**
       * The linked records a cell names, by the tool's IDs, or null when cells don't carry them and
       * the reader has to be asked for each record's links
       */
      read: ((value: unknown) => string[]) | null;
    })
  | (PlanBase & {
      /** Task targets are known only after records from every selected table have been read. */
      kind: 'deferredLink';
      targets: readonly { id: string; name: string }[];
      prefersSingle: boolean;
    })
  | (PlanBase & { kind: 'omitted' });

export type ValuePlan = Extract<FieldPlan, { kind: 'value' }>;
export type LinkPlan = Extract<FieldPlan, { kind: 'link' }>;

/** A condition's value, in the tool's terms until the job finds what each names here. */
export type SourceValue =
  | { kind: 'none' }
  | { kind: 'text'; text: string }
  | { kind: 'number'; number: number }
  | { kind: 'boolean'; value: boolean }
  /** Options, by name */
  | { kind: 'choices'; names: string[] }
  /** Linked records, by the tool's IDs */
  | { kind: 'records'; ids: string[] }
  | { kind: 'date'; target: DateTarget }
  | { kind: 'range'; range: DateRange };

export interface SourceCondition {
  /** The field, by the tool's ID */
  field: string;
  operator: Operator;
  value: SourceValue;
}

export interface SourceFilter {
  conjunction: 'and' | 'or';
  conditions: Array<SourceCondition | SourceFilter>;
}

export interface SourceView {
  id: string;
  name: string;
  /** The tool's own name for the kind of view, for the report */
  type: string;
  /** The kind of view it becomes here, or null when there's none like it */
  kind: ViewType | null;
  /** The fields it shows, in order, by the tool's IDs, when the tool says */
  shown?: string[];
  /** Conditions that pick its records */
  filter?: SourceFilter | null;
  /** How many of its conditions the reader found no match for here */
  unmatched?: number;
  sorts?: Array<{ field: string; direction: 'asc' | 'desc' }>;
  /** Kanban stacks, map pins' colors, or list and timeline groups */
  group?: string | null;
  /** Card covers */
  cover?: string | null;
  /** Calendar, timeline, and Gantt dates, and map places */
  start?: string | null;
  end?: string | null;
  /** Form questions, by the tool's field IDs */
  questions?: Array<{ field: string; required: boolean; label: string; help: string }>;
  form?: { title: string; description: string; submitLabel: string; thankYou: string };
  /** What the reader already knows didn't come across */
  notes: Note[];
}

export interface SourceTable {
  id: string;
  name: string;
  recordCount?: number;
  description?: string | null;
  /** The field that names each record, by the tool's ID */
  primary: string | null;
  /** Every field, planned, in the tool's order */
  fields: FieldPlan[];
  views: SourceView[];
  notes: Note[];
}

export interface SourceSchema {
  tables: SourceTable[];
  /** What the report says about the whole base, like what stays behind in the tool */
  notes: Note[];
}

export interface SourceRecord {
  id: string;
  /** Values by the tool's field IDs */
  values: Record<string, unknown>;
}

/**
 * One tool's reader, as the job uses it.  Everything it reads goes through the guarded client, and
 * every refusal it throws is an `AppError` with an `import.platform.` message key.
 */
export interface PlatformSource {
  platform: ImportPlatform;
  schema(): Promise<SourceSchema>;
  /** A table's records, a page at a time */
  records(table: SourceTable): AsyncGenerator<SourceRecord[]>;
  /** Replace deferred task relations with only the targets found in the selected records. */
  finalizeLinks?(schema: SourceSchema): void;
  /**
   * The records one link names, for links whose cells don't carry them: each record with the
   * linked records' IDs, a page at a time, for the records `ids` names.
   */
  links?(
    table: SourceTable,
    link: LinkPlan,
    ids: readonly string[],
  ): AsyncGenerator<Array<{ record: string; targets: string[] }>>;
}
