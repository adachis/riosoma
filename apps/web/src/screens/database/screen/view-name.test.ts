import { setupI18n } from '@lingui/core';
import { LIMITS, Name } from '@riosoma/contracts';
import { describe, expect, it } from 'vitest';
import { availableViewName } from './view-name';

const i18n = setupI18n({ locale: 'en-US', messages: { 'en-US': {} } });

describe('new view names', () => {
  it('keeps an unused name and checks collisions without case sensitivity', () => {
    expect(availableViewName(i18n, 'Gallery', [])).toBe('Gallery');
    expect(availableViewName(i18n, 'Gallery', ['gallery', 'GALLERY (2)', 'Gallery (4)'])).toBe('Gallery (3)');
  });

  it('numbers repeated copies and leaves other tables out of the supplied names', () => {
    expect(availableViewName(i18n, 'Gallery', [], true)).toBe('Gallery copy');
    expect(availableViewName(i18n, 'Gallery', ['Gallery copy', 'gallery COPY (2)'], true)).toBe(
      'Gallery copy (3)',
    );
  });

  it('fits a copied maximum-length name and its suffix without splitting an emoji', () => {
    const name = `${'界'.repeat(LIMITS.nameLength - 2)}🚢`;
    const first = availableViewName(i18n, name, [], true);
    const second = availableViewName(i18n, name, [first], true);
    expect(Name.safeParse(first).success).toBe(true);
    expect(Name.safeParse(second).success).toBe(true);
    expect(first).toMatch(/ copy$/);
    expect(second).toMatch(/ copy \(2\)$/);
    expect(second).not.toBe(first);
    for (const value of [first, second]) expect(value).not.toMatch(/\p{Surrogate}/u);
  });
});
