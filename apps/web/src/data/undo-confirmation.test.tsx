import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { I18nProvider } from '@lingui/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { i18n } from '../i18n';
import { MajorUndoConfirmation, confirmMajorUndo } from './undo-confirmation';
import type { UndoPreview } from '@riosoma/contracts';
import type { Http } from './deps';

beforeEach(() => {
  i18n.load('en-US', {});
  i18n.activate('en-US');
});
afterEach(cleanup);
const database: UndoPreview['creations'][number] = {
  kind: 'database',
  id: 'database',
  name: 'Projects',
  tables: 3,
  records: 412,
  changedSince: [{ actorId: 'sam', name: 'Sam', records: 12, tables: 1, shares: 2 }],
};

describe('major creation undo confirmation', () => {
  it('names the database, reports current counts and other people’s work, and starts on Keep it', async () => {
    const answer = vi.fn();
    render(
      <I18nProvider i18n={i18n}>
        <MajorUndoConfirmation creation={database} onAnswer={answer} />
      </I18nProvider>,
    );
    expect(screen.getByRole('dialog', { name: 'Undo creating the database Projects?' })).toBeDefined();
    expect(screen.getByText('It and its 3 tables and 412 records go to the trash.')).toBeDefined();
    expect(screen.getByText(/Sam added 12 records since\./)).toBeDefined();
    expect(screen.getByText(/Sam added 1 table since\./)).toBeDefined();
    expect(screen.getByText(/Sam added 2 shares since\./)).toBeDefined();
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Keep it' })));
    await userEvent.keyboard('{Escape}');
    expect(answer).toHaveBeenCalledWith(false);
  });

  it('names a table and keeps it unless the person chooses Move to trash', async () => {
    const answer = vi.fn();
    render(
      <I18nProvider i18n={i18n}>
        <MajorUndoConfirmation
          creation={{
            ...database,
            kind: 'table',
            tables: 0,
            changedSince: [{ actorId: 'sam', name: 'Sam', records: 0, tables: 0, shares: 0 }],
          }}
          onAnswer={answer}
        />
      </I18nProvider>,
    );
    expect(screen.getByRole('dialog', { name: 'Undo creating the table Projects?' })).toBeDefined();
    expect(screen.getByText('It and its 412 records go to the trash.')).toBeDefined();
    expect(screen.getByText('Sam changed it since it was created.')).toBeDefined();
    await userEvent.click(screen.getByRole('button', { name: 'Move to trash' }));
    expect(answer).toHaveBeenCalledWith(true);
  });

  it('reads server counts each time and stops without authorizing undo when kept', async () => {
    const http = vi.fn(async () => ({ creations: [database] })) as unknown as Http;
    const first = confirmMajorUndo('database', 'group', http);
    await userEvent.click(await screen.findByRole('button', { name: 'Keep it' }));
    expect(await first).toBe(false);
    const second = confirmMajorUndo('database', 'group', http);
    await userEvent.click(await screen.findByRole('button', { name: 'Move to trash' }));
    expect(await second).toBe(true);
    expect(http).toHaveBeenCalledTimes(2);
  });
});
