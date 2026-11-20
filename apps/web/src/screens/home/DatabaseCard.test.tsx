import { faDatabase, faStar } from '@fortawesome/free-solid-svg-icons';
import { act, cleanup, fireEvent, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';
import { DatabaseCard } from './DatabaseCard';
import { databaseSummary, renderHome } from './test-support';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
it('uses native links, modifier clicks, keyboard navigation, and relative times in the active locale', async () => {
  vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-09-27T12:00:00Z'));
  const onOpen = vi.fn();
  const database = databaseSummary();
  const { i18n, container } = renderHome(
    <DatabaseCard database={database} href={`/${database.id}`} onOpen={onOpen} />,
  );
  const link = screen.getByRole('link', { name: 'Projects Updated 3 hours ago' });
  expect(link.getAttribute('href')).toBe(`/${database.id}`);
  for (const modifier of ['ctrlKey', 'metaKey', 'shiftKey', 'altKey'])
    expect(fireEvent.click(link, { [modifier]: true })).toBe(true);
  expect(onOpen).not.toHaveBeenCalled();
  expect(fireEvent.click(link)).toBe(false);
  expect(onOpen).toHaveBeenCalledOnce();
  await userEvent.tab();
  expect(document.activeElement).toBe(link);
  await userEvent.keyboard('{Enter}');
  expect(onOpen).toHaveBeenCalledTimes(2);
  expect(container.querySelector('svg path')?.getAttribute('d')).toBe(faDatabase.icon[4]);
  expect(container.querySelector('.rio-database-icon')?.getAttribute('style')).toContain(
    '--rio-aa-choice-blue',
  );
  act(() => {
    i18n.load('fr', { 'home.updated': ['Mis à jour ', ['time']] });
    i18n.activate('fr');
  });
  expect(screen.getByRole('link').textContent).toContain('Mis à jour il y a 3 heures');
});
it('uses the database icon when provided', () => {
  const { container } = renderHome(
    <DatabaseCard database={databaseSummary({ icon: 'star' })} href="/projects" onOpen={vi.fn()} />,
  );
  expect(container.querySelector('svg path')?.getAttribute('d')).toBe(faStar.icon[4]);
});
it('offers duplicating to people who can change the schema, and deleting to owners only', async () => {
  const onDuplicate = vi.fn();
  const { rerender } = renderHome(
    <DatabaseCard
      database={databaseSummary({ role: 'creator' })}
      href="/projects"
      onOpen={vi.fn()}
      onDelete={vi.fn()}
      onDuplicate={onDuplicate}
    />,
  );
  await userEvent.click(screen.getByRole('button', { name: 'More for Projects' }));
  expect(screen.queryByRole('menuitem', { name: 'Delete database' })).toBeNull();
  await userEvent.click(await screen.findByRole('menuitem', { name: 'Duplicate database' }));
  expect(onDuplicate).toHaveBeenCalledOnce();
  rerender(
    <DatabaseCard
      database={databaseSummary({ role: 'editor' })}
      href="/projects"
      onOpen={vi.fn()}
      onDelete={vi.fn()}
      onDuplicate={onDuplicate}
    />,
  );
  expect(screen.queryByRole('button', { name: 'More for Projects' })).toBeNull();
});
