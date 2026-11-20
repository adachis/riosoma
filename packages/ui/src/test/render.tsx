import { i18n } from '@lingui/core';
import { I18nProvider } from '@lingui/react';
import { render as renderInDom, type RenderOptions } from '@testing-library/react';
import type { ReactElement } from 'react';

/**
 * Components translate the text they show by themselves, which needs an i18n in context.  Tests
 * render through the catalog activated in the setup file, so source messages come back in
 * American English.
 */
export function render(ui: ReactElement, options?: RenderOptions) {
  return renderInDom(<I18nProvider i18n={i18n}>{ui}</I18nProvider>, options);
}
