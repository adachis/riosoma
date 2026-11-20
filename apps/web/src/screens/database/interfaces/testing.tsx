import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
  useParams,
} from '@tanstack/react-router';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { SessionInfo } from '@riosoma/contracts';
import { useSchema } from '../../../data/hooks';
import type { DatabaseSession } from '../../../data/types';
import { renderSharing } from '../share/testing';
import { InterfaceScreen } from './InterfaceScreen';
import { interfaceFixture, PAGE_ID, type InterfaceFixture } from './test-support';

function Screen({ session }: { session: DatabaseSession }) {
  const params = useParams({ strict: false });
  const schema = useSchema(session);
  return schema ? (
    <InterfaceScreen
      session={session}
      schema={schema}
      interfaceId={params.interfaceId ?? ''}
      pageId={params.pageId}
      fallbackHref={`/${session.databaseId}`}
      refreshDelay={20}
    />
  ) : null;
}

/**
 * The interface on routes shaped like the app's, starting at its first page unless told otherwise.
 * The session goes in `sessions`, for the test to close.
 */
export async function openInterface(
  sessions: DatabaseSession[],
  options: Parameters<typeof interfaceFixture>[0] = {},
  path?: (setup: InterfaceFixture) => string,
  identity?: SessionInfo,
) {
  const setup = await interfaceFixture(options);
  sessions.push(setup.session);
  const root = createRootRoute({ component: Outlet });
  const database = createRoute({
    getParentRoute: () => root,
    path: '$databaseId',
    component: () => <Screen session={setup.session} />,
  });
  const face = createRoute({ getParentRoute: () => database, path: 'interfaces/$interfaceId' });
  const page = createRoute({
    getParentRoute: () => face,
    path: '$pageId',
    validateSearch: (
      search: Record<string, unknown>,
    ): { block?: string; record?: string; editor?: string; detail?: string } => ({
      ...(search.detail === 'record' ? { detail: 'record' } : {}),
      ...(typeof search.editor === 'string' ? { editor: search.editor } : {}),
      ...(typeof search.block === 'string' ? { block: search.block } : {}),
      ...(typeof search.record === 'string' ? { record: search.record } : {}),
    }),
  });
  const router = createRouter({
    routeTree: root.addChildren([database.addChildren([face.addChildren([page])])]),
    history: createMemoryHistory({
      initialEntries: [
        path?.(setup) ?? `/${setup.fixture.databaseId}/interfaces/${setup.value.id}/${PAGE_ID}`,
      ],
    }),
  });
  renderSharing(<RouterProvider router={router} />, identity);
  await screen.findByRole('heading', { level: 2, name: 'Front desk' });
  return { ...setup, router };
}

export const block = (name: string) => screen.getByRole('article', { name });

/** The records a list shows, by name */
export const names = (list: HTMLElement) =>
  within(list)
    .getAllByRole('option')
    .map((option) => option.querySelector('.rio-listbox-item__label')?.textContent ?? '');

export const select = (label: string) =>
  screen.getByRole('button', { name: (name) => name === label || name.endsWith(` ${label}`) });

export async function pick(label: string, option: string) {
  await userEvent.click(select(label));
  await userEvent.click(
    screen.getByRole('option', {
      name: (accessibleName) => accessibleName === option || accessibleName.startsWith(`${option} `),
    }),
  );
}

/** The first page's blocks as the last save sent them */
export const pageBlocks = (setup: InterfaceFixture) => setup.updates().at(-1)?.pages?.[0]?.blocks ?? [];
