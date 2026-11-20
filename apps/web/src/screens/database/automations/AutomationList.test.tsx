import { dragItem } from '../../../test/sortable';
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
  useParams,
} from '@tanstack/react-router';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { toastQueue } from '@riosoma/ui';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CommandBatch, type Command } from '@riosoma/contracts';
import { useSchema } from '../../../data/hooks';
import { renderShell } from '../shell/test-support';
import { AutomationList, AutomationSidebar } from './AutomationList';
import {
  automationFixture,
  automationMeta,
  renderWithProviders,
  type AutomationFixture,
} from './test-support';

const fixtures: AutomationFixture[] = [];
afterEach(() => {
  cleanup();
  fixtures.splice(0).forEach((fixture) => fixture.session.close());
  for (const toast of toastQueue.visibleToasts) toastQueue.close(toast.key);
  vi.unstubAllGlobals();
});

function list(canEdit = true) {
  const automations = [
    automationMeta('db', 'Notify the team', { trigger: { kind: 'webhook' } }, { enabled: true }),
    automationMeta('db', 'Weekly digest', { trigger: { kind: 'webhook' } }, { position: 1 }),
  ];
  const props = {
    automations,
    activeAutomationId: automations[0]!.id,
    hrefFor: (id: string) => `/db/automations/${id}`,
    onNavigate: vi.fn(),
    canEdit,
    onCreate: vi.fn(),
    onRename: vi.fn(),
    onDelete: vi.fn(),
    onMove: vi.fn(),
  };
  renderShell(<AutomationList {...props} />);
  return props;
}

describe('the automations section', () => {
  it('lists each automation as a link with an on or off dot', () => {
    const props = list();
    const section = screen.getByRole('region', { name: 'Automations' });
    const on = within(section).getByRole('link', { name: 'Notify the team', description: 'On' });
    const off = within(section).getByRole('link', { name: 'Weekly digest', description: 'Off' });
    expect(on.getAttribute('href')).toBe(`/db/automations/${props.automations[0]!.id}`);
    expect(on.getAttribute('aria-current')).toBe('page');
    expect(off.hasAttribute('aria-current')).toBe(false);
    const [first, second] = within(section).getAllByRole('listitem');
    expect(first!.hasAttribute('data-enabled')).toBe(true);
    expect(second!.hasAttribute('data-enabled')).toBe(false);
    fireEvent.click(off);
    expect(props.onNavigate).toHaveBeenCalledWith(props.automations[1]!.id);
  });

  it('offers rename, delete, and a new automation by role, and asks before deleting', async () => {
    const props = list();
    await userEvent.click(screen.getByRole('button', { name: 'Add an automation' }));
    expect(props.onCreate).toHaveBeenCalledOnce();
    await userEvent.click(screen.getByRole('button', { name: 'More for Weekly digest' }));
    await userEvent.click(screen.getByRole('menuitem', { name: 'Rename' }));
    const input = await screen.findByRole('textbox', { name: 'Rename' });
    await userEvent.clear(input);
    await userEvent.type(input, 'Monday digest{Enter}');
    expect(props.onRename).toHaveBeenCalledWith(props.automations[1]!.id, 'Monday digest');
    await userEvent.click(screen.getByRole('button', { name: 'More for Weekly digest' }));
    await userEvent.click(screen.getByRole('menuitem', { name: 'Delete automation' }));
    const dialog = screen.getByRole('dialog', { name: 'Delete Weekly digest?' });
    expect(dialog.textContent).toContain(
      'It stops running and is deleted for everyone.  You can restore it from the trash for 30 days.',
    );
    expect(props.onDelete).not.toHaveBeenCalled();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Delete automation' }));
    expect(props.onDelete).toHaveBeenCalledWith(props.automations[1]!.id);
  });

  it('reorders with Alt and the arrow keys, and by dragging', async () => {
    const props = list();
    screen.getByRole('link', { name: 'Notify the team' }).focus();
    await userEvent.keyboard('{Alt>}{ArrowUp}{ArrowDown}{/Alt}');
    expect(props.onMove).toHaveBeenCalledExactlyOnceWith(props.automations[0]!.id, 1);
    const items = screen.getAllByRole('listitem');
    await dragItem(screen.getByRole('button', { name: 'Move Weekly digest' }), items[0]!, 0.05);
    expect(props.onMove).toHaveBeenLastCalledWith(props.automations[1]!.id, 0);
  });

  it('shows people who can’t change the schema the list without the controls', async () => {
    const props = list(false);
    expect(screen.getByRole('link', { name: 'Notify the team', description: 'On' })).toBeDefined();
    expect(screen.queryAllByRole('button')).toHaveLength(0);
    screen.getByRole('link', { name: 'Notify the team' }).focus();
    await userEvent.keyboard('{Alt>}{ArrowDown}{/Alt}');
    expect(props.onMove).not.toHaveBeenCalled();
    expect(screen.getAllByRole('listitem').every((item) => item.getAttribute('draggable') !== 'true')).toBe(
      true,
    );
  });

  it('leaves the section out when there is nothing to list or add', () => {
    renderShell(
      <AutomationList
        automations={[]}
        activeAutomationId={null}
        hrefFor={(id) => id}
        onNavigate={vi.fn()}
        canEdit={false}
        onCreate={vi.fn()}
        onRename={vi.fn()}
        onDelete={vi.fn()}
        onMove={vi.fn()}
      />,
    );
    expect(screen.queryByRole('region', { name: 'Automations' })).toBeNull();
  });
});

async function mountSidebar(initial: (fixture: AutomationFixture) => string) {
  const fixture = await automationFixture({
    automations: ({ databaseId }) => [
      automationMeta(databaseId, 'Notify the team', { trigger: { kind: 'webhook' } }),
      automationMeta(databaseId, 'Weekly digest', { trigger: { kind: 'webhook' } }),
    ],
  });
  fixtures.push(fixture);
  function Page() {
    const params = useParams({ strict: false });
    const schema = useSchema(fixture.session);
    return schema ? (
      <AutomationSidebar
        session={fixture.session}
        schema={schema}
        activeAutomationId={params.automationId ?? null}
        tableId={fixture.tasks.id}
      />
    ) : null;
  }
  const root = createRootRoute({ component: Outlet });
  const router = createRouter({
    routeTree: root.addChildren([
      createRoute({
        getParentRoute: () => root,
        path: '$databaseId/automations/$automationId',
        component: Page,
      }),
      createRoute({ getParentRoute: () => root, path: '$databaseId/$tableId', component: Page }),
    ]),
    history: createMemoryHistory({ initialEntries: [initial(fixture)] }),
  });
  renderWithProviders(<RouterProvider router={router} />);
  await screen.findByRole('region', { name: 'Automations' });
  const names = () =>
    within(screen.getByRole('region', { name: 'Automations' }))
      .getAllByRole('link')
      .map((link) => link.textContent);
  const commands = (): Command[] =>
    fixture.server.requests
      .filter((request) => request.path.endsWith('/commands'))
      .flatMap((request) => CommandBatch.parse(request.options.body).commands);
  return { fixture, router, names, commands };
}

describe('the automations section with a session', () => {
  it('creates an automation that starts from the current table and opens it', async () => {
    const { fixture, router, names, commands } = await mountSidebar(
      (fixture) => `/${fixture.databaseId}/${fixture.tasks.id}`,
    );
    await userEvent.click(screen.getByRole('button', { name: 'Add an automation' }));
    expect(names()).toEqual(['Notify the team', 'Weekly digest', 'Untitled automation']);
    const created = fixture.session.getSchema().automations[2]!;
    await waitFor(() =>
      expect(router.state.location.pathname).toBe(`/${fixture.databaseId}/automations/${created.id}`),
    );
    await waitFor(() => expect(commands().map((command) => command.kind)).toContain('automation.create'));
    expect(commands().find((command) => command.kind === 'automation.create')).toMatchObject({
      automation: {
        name: 'Untitled automation',
        config: {
          trigger: { kind: 'recordCreated', tableId: fixture.tasks.id },
          conditions: null,
          steps: [],
        },
      },
    });
    expect(screen.getByRole('link', { name: 'Untitled automation' }).getAttribute('aria-current')).toBe(
      'page',
    );
  });

  it('renames and reorders through commands', async () => {
    const { fixture, names } = await mountSidebar((fixture) => `/${fixture.databaseId}/${fixture.tasks.id}`);
    await userEvent.click(screen.getByRole('button', { name: 'More for Weekly digest' }));
    await userEvent.click(screen.getByRole('menuitem', { name: 'Rename' }));
    const input = await screen.findByRole('textbox', { name: 'Rename' });
    await userEvent.clear(input);
    await userEvent.type(input, 'Monday digest{Enter}');
    expect(names()).toEqual(['Notify the team', 'Monday digest']);
    screen.getByRole('link', { name: 'Notify the team' }).focus();
    await userEvent.keyboard('{Alt>}{ArrowDown}{/Alt}');
    expect(names()).toEqual(['Monday digest', 'Notify the team']);
    await waitFor(() =>
      expect(
        [...(fixture.server.database(fixture.databaseId).schema.automations ?? [])]
          .sort((a, b) => a.position - b.position)
          .map((automation) => automation.name),
      ).toEqual(['Monday digest', 'Notify the team']),
    );
  });

  it('deletes after asking, leaves the deleted automation’s screen, and undoes', async () => {
    const { fixture, router, names } = await mountSidebar(
      (fixture) =>
        `/${fixture.databaseId}/automations/${fixture.server.database(fixture.databaseId).schema.automations![0]!.id}`,
    );
    await userEvent.click(screen.getByRole('button', { name: 'More for Notify the team' }));
    await userEvent.click(screen.getByRole('menuitem', { name: 'Delete automation' }));
    await userEvent.click(
      within(screen.getByRole('dialog', { name: 'Delete Notify the team?' })).getByRole('button', {
        name: 'Delete automation',
      }),
    );
    await waitFor(() => expect(names()).toEqual(['Weekly digest']));
    expect(router.state.location.pathname).toBe(`/${fixture.databaseId}/${fixture.tasks.id}`);
    expect(await screen.findByText('Deleted Notify the team')).toBeDefined();
    await waitFor(() => expect(fixture.session.canUndo()).toBe(true));
    await userEvent.click(screen.getByRole('button', { name: 'Undo' }));
    await waitFor(() => expect(names()).toEqual(['Notify the team', 'Weekly digest']));
    await waitFor(() =>
      expect(
        fixture.server.database(fixture.databaseId).schema.automations?.map((item) => item.name),
      ).toContain('Notify the team'),
    );
  });
});
