import type { RioContext } from '@riosoma/contracts';
import type { DatabaseSession } from '../../data/types';

type Selection = Pick<RioContext, 'recordIds' | 'fieldIds'>;
const selections = new WeakMap<DatabaseSession, { viewId: string; read: () => Promise<Selection> }>();

/** The grid keeps its selection in its engine; read it only when a question is sent. */
export function setRioSelection(session: DatabaseSession, viewId: string, read: () => Promise<Selection>) {
  selections.set(session, { viewId, read });
}
export function clearRioSelection(session: DatabaseSession) {
  selections.delete(session);
}
export async function questionContext(
  context: RioContext,
  session: DatabaseSession | null,
): Promise<RioContext> {
  const selection =
    session && session.databaseId === context.databaseId ? selections.get(session) : undefined;
  return selection && selection.viewId === context.viewId
    ? { ...context, ...(await selection.read()) }
    : context;
}
