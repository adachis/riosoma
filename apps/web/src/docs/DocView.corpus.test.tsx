import { setupI18n } from '@lingui/core';
import { I18nProvider } from '@lingui/react';
import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { safeLinkHref } from '@riosoma/contracts';
import { unsafeHrefs, xss } from '../../../server/src/test/corpora/xss';
import { RichTextView } from '../fields/richText/RichTextView';
import { DocView } from './DocView';

afterEach(cleanup);
describe('shared XSS corpus in help and rich text', () => {
  it.each(xss)('renders payload as inert content: %s', (body) => {
    const i18n = setupI18n({ locale: 'en-US', messages: { 'en-US': {} } });
    for (const child of [<DocView body={body} onOpen={() => {}} />, <RichTextView value={body} />]) {
      const view = render(<I18nProvider i18n={i18n}>{child}</I18nProvider>);
      expect(
        view.container.querySelector('script, img, svg, iframe, math, input:not([type=checkbox])'),
      ).toBeNull();
      for (const element of view.container.querySelectorAll('*')) {
        expect(element.getAttributeNames().some((name) => /^on/i.test(name))).toBe(false);
      }
      for (const link of view.container.querySelectorAll('a'))
        expect(safeLinkHref(link.getAttribute('href') ?? '')).not.toBeNull();
      view.unmount();
    }
  });
  it.each(unsafeHrefs)('refuses active link schemes: %s', (href) => {
    expect(safeLinkHref(href)).toBeNull();
  });
});
