import { setupI18n } from '@lingui/core';
import { I18nProvider } from '@lingui/react';
import { render } from '@testing-library/react';
import { GridConfig, newId, type TableMeta, type ViewMeta } from '@riosoma/contracts';
import type { ReactElement } from 'react';

export function renderShell(element: ReactElement) {
  const i18n = setupI18n({ locale: 'en-US', messages: { 'en-US': {} } });
  const result = render(element, {
    wrapper: ({ children }) => <I18nProvider i18n={i18n}>{children}</I18nProvider>,
  });
  return { ...result, i18n };
}

export function table(name: string): TableMeta {
  return {
    id: newId('table'),
    name,
    databaseId: newId('database'),
    primaryFieldId: newId('field'),
    position: 0,
    description: '',
    createdAt: '',
    updatedAt: '',
  };
}

export function view(name: string): ViewMeta {
  return {
    id: newId('view'),
    name,
    tableId: newId('table'),
    type: 'grid',
    config: GridConfig.parse({}),
    position: 0,
    createdBy: null,
    createdAt: '',
    updatedAt: '',
  };
}
