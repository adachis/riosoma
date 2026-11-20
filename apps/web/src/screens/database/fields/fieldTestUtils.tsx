import { setupI18n } from '@lingui/core';
import { I18nProvider } from '@lingui/react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactElement } from 'react';
import { FieldSpec, newId, type FieldMeta } from '@riosoma/contracts';

export function renderField(element: ReactElement) {
  const i18n = setupI18n({ locale: 'en-US', messages: { 'en-US': {} } });
  return render(<I18nProvider i18n={i18n}>{element}</I18nProvider>);
}

export async function selectOption(label: string, option: string | RegExp) {
  await userEvent.click(screen.getByRole('button', { name: new RegExp(label) }));
  await userEvent.click(
    screen.getByRole('option', {
      name: (accessibleName, element) =>
        typeof option === 'string'
          ? accessibleName === option ||
            element?.querySelector('.rio-listbox-item__label')?.textContent === option
          : option.test(accessibleName),
    }),
  );
}

export function field(spec: FieldSpec = FieldSpec.parse({ type: 'text' })): FieldMeta {
  return {
    id: newId('field'),
    tableId: newId('table'),
    name: 'Title',
    description: '',
    position: 0,
    createdAt: '2026-09-27T12:00:00Z',
    updatedAt: '2026-09-27T12:00:00Z',
    ...spec,
  };
}
