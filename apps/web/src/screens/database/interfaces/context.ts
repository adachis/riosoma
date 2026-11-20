import type { FilterBlockValue, InterfacePage } from '@riosoma/contracts';
import type { DatabaseSession, SchemaState } from '../../../data/types';
import type { FormatContext } from '../../../grid/format';
import type { TileState } from '../dashboards/data';

/** What every block on an interface page shares: where its data comes from and the page's state. */
export interface BlockContext {
  session: DatabaseSession;
  schema: SchemaState;
  format: FormatContext;
  interfaceId: string;
  page: InterfacePage;
  /** Whether the person may change records, so record blocks edit and form buttons open */
  canEditRecords: boolean;
  /** What the person chose in the page's filter blocks, by filter block */
  filters: Readonly<Record<string, FilterBlockValue>>;
  onFilter(blockId: string, value: FilterBlockValue | undefined): void;
  /** The record picked in each records block, by records block */
  selected: Readonly<Record<string, string>>;
  onSelect(blockId: string, recordId: string, options?: { open?: boolean }): void;
  /** A record a records block picked is gone or hidden */
  onMissing(blockId: string): void;
  /** Number and chart blocks' data, by block */
  summaries: ReadonlyMap<string, TileState>;
  onRetry(blockId: string): void;
  /** How long record changes settle before blocks reload */
  refreshDelay?: number;
}
