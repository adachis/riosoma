import { Checkbox } from './Checkbox';
import { CheckboxGroup } from './CheckboxGroup';
import type { GalleryEntry } from './gallery';

// Gallery examples are a developer tool, so their sample labels are plain text.
export const gallery: GalleryEntry = {
  id: 'ui.checkbox-group',
  title: 'CheckboxGroup',
  examples: [
    {
      id: 'vertical',
      render: () => (
        <CheckboxGroup label="Export formats" defaultValue={['csv']}>
          <Checkbox value="csv">CSV</Checkbox>
          <Checkbox value="json">JSON</Checkbox>
          <Checkbox value="parquet">Parquet</Checkbox>
        </CheckboxGroup>
      ),
    },
    {
      id: 'horizontal',
      render: () => (
        <CheckboxGroup label="Columns" orientation="horizontal" defaultValue={['name', 'size']}>
          <Checkbox value="name">Name</Checkbox>
          <Checkbox value="size">Size</Checkbox>
          <Checkbox value="owner">Owner</Checkbox>
          <Checkbox value="updated">Updated</Checkbox>
        </CheckboxGroup>
      ),
    },
    {
      id: 'description',
      render: () => (
        <CheckboxGroup label="Notifications" description="Applies to every member of the workspace.">
          <Checkbox value="email" description="Uses the address on your profile.">
            Email
          </Checkbox>
          <Checkbox value="webhook">Webhook</Checkbox>
        </CheckboxGroup>
      ),
    },
    {
      id: 'invalid',
      render: () => (
        <CheckboxGroup label="Retention" isInvalid errorMessage="Choose at least one option.">
          <Checkbox value="history">Keep history</Checkbox>
          <Checkbox value="snapshots">Keep snapshots</Checkbox>
        </CheckboxGroup>
      ),
    },
    {
      id: 'disabled',
      render: () => (
        <CheckboxGroup label="Danger zone" isDisabled defaultValue={['vacuum']}>
          <Checkbox value="drop">Drop tables</Checkbox>
          <Checkbox value="vacuum">Vacuum</Checkbox>
        </CheckboxGroup>
      ),
    },
    {
      id: 'read-only',
      render: () => (
        <CheckboxGroup label="Included features" isReadOnly defaultValue={['audit']}>
          <Checkbox value="audit">Audit log</Checkbox>
          <Checkbox value="backup">Nightly backup</Checkbox>
        </CheckboxGroup>
      ),
    },
  ],
};
