import { ComboBox } from './ComboBox';
import { ListBoxItem } from './ListBox';
import type { GalleryEntry } from './gallery';

// Gallery examples are a developer tool, so their sample labels are plain text.
const tables = (
  <>
    <ListBoxItem id="orders">orders</ListBoxItem>
    <ListBoxItem id="order_lines">order_lines</ListBoxItem>
    <ListBoxItem id="people">people</ListBoxItem>
    <ListBoxItem id="sessions">sessions</ListBoxItem>
  </>
);

export const gallery: GalleryEntry = {
  id: 'ui.comboBox',
  title: 'ComboBox',
  examples: [
    {
      id: 'default',
      render: () => (
        <ComboBox label="Jump to table" placeholder="Start typing">
          {tables}
        </ComboBox>
      ),
    },
    {
      id: 'sizes',
      render: () => (
        <>
          <ComboBox aria-label="Table, small" size="sm" defaultInputValue="orders">
            {tables}
          </ComboBox>
          <ComboBox aria-label="Table, medium" defaultInputValue="orders">
            {tables}
          </ComboBox>
          <ComboBox aria-label="Table, large" size="lg" defaultInputValue="orders">
            {tables}
          </ComboBox>
        </>
      ),
    },
    {
      id: 'help',
      render: () => (
        <ComboBox label="Jump to table" description="Matches any part of the name" defaultInputValue="orders">
          {tables}
        </ComboBox>
      ),
    },
    {
      id: 'invalid',
      render: () => (
        <ComboBox label="Jump to table" isInvalid errorMessage="That table is not in this database">
          {tables}
        </ComboBox>
      ),
    },
    {
      id: 'disabled',
      render: () => (
        <ComboBox label="Jump to table" isDisabled defaultInputValue="orders">
          {tables}
        </ComboBox>
      ),
    },
    {
      id: 'filtered',
      render: () => (
        // A combo box opens its panel only on interaction, so these start with the text already
        // typed: open one to see the filtered list, the empty state, or a custom value.
        <ComboBox label="Jump to table" defaultInputValue="order">
          {tables}
        </ComboBox>
      ),
    },
    {
      id: 'empty',
      render: () => (
        <ComboBox label="Jump to table" defaultInputValue="durian">
          {tables}
        </ComboBox>
      ),
    },
    {
      id: 'custom-value',
      render: () => (
        <ComboBox
          label="Jump to table"
          description="A name that is not in the list yet is allowed"
          allowsCustomValue
          defaultInputValue="audit_log"
        >
          {tables}
        </ComboBox>
      ),
    },
  ],
};
