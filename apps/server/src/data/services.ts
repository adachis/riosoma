import type { Change } from '@riosoma/contracts';

/**
 * What the data module offers the rest of the server at run time.  The read routes create it;
 * realtime uses it to tell each watching tab how a change affects the view it's paging.
 */
export interface ViewWatch {
  viewId: string;
  snapshot: string;
}

export interface ViewDelta {
  viewId: string;
  snapshot: string;
  /** Records that now belong in the view but aren't in the snapshot */
  entered: string[];
  /** Records in the snapshot that no longer belong in the view */
  left: string[];
  /** Records in the snapshot whose sort values changed */
  moved: string[];
}

export interface DataServices {
  viewDeltas(change: Change, watches: readonly ViewWatch[]): Promise<ViewDelta[]>;
}
