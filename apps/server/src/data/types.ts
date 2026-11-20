import type { FieldMeta, TableMeta, NamedFunctionDefinition } from '@riosoma/contracts';
import type { Sql } from '@riosoma/db';
import type { Ast, FormulaError, FormulaType } from '@riosoma/formula';
import type { Managed } from './managed.js';

/** A field as the server stores it: its public shape plus the physical column holding its values. */
export type StoredField = FieldMeta & {
  /** The column in the record table.  Unused for computed types, which read system columns. */
  columnName: string;
  /** Reader-specific mapped value, shared by selections, filters, sorts, and relations. */
  joinedPartial?: boolean;
  joinedRead?: (alias?: string) => Sql;
  /** Active junction, retained in conversion history so undo selects the same edges. */
  linkId?: string;
  lineColumns?: StoredField[];
  namedFunctions?: readonly NamedFunctionDefinition[];
  sparklineSources?: Array<{ key: string; field: StoredField }>;
  /** Scoped source labels for the selected IDs, independent of the options browser's page. */
  selectRead?: {
    name(id: Sql): Sql;
    rank(id: Sql): Sql;
    choices(ids: Sql): Sql;
    key: string;
  };
  tableName?: string;
  dataSchema?: string;
  readContext?: Pick<ReadContext, 'now' | 'timeZone'>;
  /** Read the computed result beneath a pin when refreshing override metadata */
  ignoreOverride?: boolean;
  /** Set when only Riosoma writes the field's values, as for payment results.  Never sent. */
  managed?: Managed;
  formula?: {
    ast?: Ast;
    error?: FormulaError;
    type: FormulaType;
    fields: StoredField[];
    people: ReadonlyMap<string, string>;
    scope?: (tableId: string, alias: string) => Sql;
  };
  /**
   * The fields an AI field's prompt reads, resolved the way a formula's are, so a loop check can
   * follow a prompt in another table.  Never stored or sent.
   */
  promptFields?: StoredField[];
  /** App schema for resolving collaborator display names. */
  appSchema?: string;
  /** Current fields whose names may appear in record history. */
  historyFields?: StoredField[];
  /** Resolved dependencies for SQL reads; never stored in public metadata. */
  relation?: {
    dataSchema: string;
    linkId: string;
    side: 'left' | 'right';
    linkedTableId: string;
    inverseFieldId: string | null;
    inverseSingle?: boolean;
    inverseHasLimit?: boolean;
    /** Draft links replace stored edges only when reading the current record under this alias. */
    draft?: { alias: string; ids: readonly string[] };
    primary?: StoredField;
    target?: StoredField;
    conditionFields?: StoredField[];
    /** For links that follow matching values: this table's field and the linked table's field */
    match?: { field: StoredField; linked: StoredField };
    /**
     * Which linked records the reader may see, as a condition on the linked table under the alias
     * given.  Set by `AccessScope.visibleFields` when a record rule limits the linked table, so
     * links, lookups, rollups, and counts read only those records.  Absent means every record.
     */
    scope?: (alias: string) => Sql;
  };
};

/** A table as the server stores it. */
export interface StoredTable extends TableMeta {
  orgId: string;
  /** Bumped by every record change */
  dataVersion: number;
}

/** What reads need to know about the person reading and the moment. */
export interface ReadContext {
  /** IANA time zone for date conditions on fields that follow each viewer */
  timeZone: string;
  /** "Today" for relative date conditions */
  now: Date;
  /** Whether the data schema has the `rio_natural` collation */
  natural: boolean;
  /** Temporary negative row numbers count backward in a rolled-back plan simulation. */
  simulatedRids?: boolean;
}
