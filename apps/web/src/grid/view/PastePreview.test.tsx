import { i18n } from '@lingui/core';
import { I18nProvider } from '@lingui/react';
import { FieldMeta, newId } from '@riosoma/contracts';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';
import { planPaste } from '../clipboard/plan';
import { PastePreview } from './PastePreview';

afterEach(cleanup);

it('lets the scrolling content of a long paste preview receive focus', async () => {
  i18n.load('en-US', {});
  i18n.activate('en-US');
  const tableId = newId('table');
  const fields = Array.from({ length: 100 }, (_, index) =>
    FieldMeta.parse({
      id: newId('field'),
      tableId,
      name: `Status ${index + 1}`,
      type: 'singleSelect',
      options: { choices: [] },
      description: '',
      position: index,
      createdAt: '',
      updatedAt: '',
    }),
  );
  const plan = planPaste({
    cells: [fields.map(() => 'Ready')],
    start: { row: 0, col: 0 },
    selection: { rows: 1, cols: 1 },
    fields,
    rowCount: 1,
    rowIdAt: () => newId('record'),
    context: { locale: 'en-US', timeZone: 'UTC', collaborators: new Map() },
  });
  render(
    <I18nProvider i18n={i18n}>
      <PastePreview
        plan={plan}
        fields={new Map(fields.map((field) => [field.id, field]))}
        onPaste={vi.fn()}
        onCancel={vi.fn()}
      />
    </I18nProvider>,
  );
  const preview = screen.getByRole('dialog', { name: 'Paste 100 cells?' });
  await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
  const content = preview.querySelector<HTMLElement>('.rio-dialog__body')!;
  content.focus();
  expect(document.activeElement).toBe(content);
});
