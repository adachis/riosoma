import { render } from '@testing-library/react';
import { i18n } from '@lingui/core';
import { I18nProvider } from '@lingui/react';
import { describe, expect, it } from 'vitest';
import { gallery as comboBoxGallery } from './ComboBox.gallery';
import { gallery as listBoxGallery } from './ListBox.gallery';
import { gallery as menuGallery } from './Menu.gallery';
import { gallery as selectGallery } from './Select.gallery';
import * as menus from './menus';
import type {
  ComboBoxProps,
  ListBoxItemProps,
  ListBoxProps,
  ListBoxSectionProps,
  MenuItemProps,
  MenuProps,
  MenuSectionProps,
  MenuSeparatorProps,
  MenuTriggerProps,
  SelectProps,
  SubmenuTriggerProps,
} from './menus';

// A compile-time check that every component's prop type leaves the group file with it.
type _GroupPropTypes = [
  ComboBoxProps<Record<string, unknown>>,
  ListBoxItemProps,
  ListBoxProps<Record<string, unknown>>,
  ListBoxSectionProps<Record<string, unknown>>,
  MenuItemProps,
  MenuProps<Record<string, unknown>>,
  MenuSectionProps<Record<string, unknown>>,
  MenuSeparatorProps,
  MenuTriggerProps,
  SelectProps<Record<string, unknown>>,
  SubmenuTriggerProps,
];

/**
 * The components themselves are tested in their own files.  This keeps the group's surface honest:
 * everything a caller needs is exported, and every gallery example still renders.
 */
describe('menus group', () => {
  it('exports every component of the group', () => {
    expect(Object.keys(menus).sort()).toEqual([
      'ComboBox',
      'ListBox',
      'ListBoxItem',
      'ListBoxSection',
      'Menu',
      'MenuItem',
      'MenuSection',
      'MenuSeparator',
      'MenuTrigger',
      'Select',
      'SubmenuTrigger',
    ]);
  });

  it('renders every gallery example of the group', () => {
    for (const entry of [menuGallery, selectGallery, comboBoxGallery, listBoxGallery]) {
      for (const example of entry.examples) {
        const { unmount } = render(<I18nProvider i18n={i18n}>{example.render()}</I18nProvider>);
        unmount();
      }
    }
  });
});
