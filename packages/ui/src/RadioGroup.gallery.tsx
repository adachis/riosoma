import { Radio } from './Radio';
import { RadioGroup } from './RadioGroup';
import type { GalleryEntry } from './gallery';

// Gallery examples are a developer tool, so their sample labels are plain text.
export const gallery: GalleryEntry = {
  id: 'ui.radio-group',
  title: 'RadioGroup',
  examples: [
    {
      id: 'vertical',
      render: () => (
        <RadioGroup label="Write mode" defaultValue="append">
          <Radio value="append">Append</Radio>
          <Radio value="overwrite">Overwrite</Radio>
          <Radio value="replace">Replace</Radio>
        </RadioGroup>
      ),
    },
    {
      id: 'horizontal',
      render: () => (
        <RadioGroup label="Sampling" orientation="horizontal" defaultValue="off">
          <Radio value="off">Off</Radio>
          <Radio value="rows">Every 100 rows</Radio>
          <Radio value="seconds">Every 5 seconds</Radio>
        </RadioGroup>
      ),
    },
    {
      id: 'description',
      render: () => (
        <RadioGroup
          label="Access"
          description="Changes apply the next time a connection is opened."
          defaultValue="members"
        >
          <Radio value="private">Private</Radio>
          <Radio value="members">Members only</Radio>
          <Radio value="public">Public</Radio>
        </RadioGroup>
      ),
    },
    {
      id: 'invalid',
      render: () => (
        <RadioGroup label="Write mode" isInvalid errorMessage="Pick a write mode.">
          <Radio value="append">Append</Radio>
          <Radio value="overwrite">Overwrite</Radio>
        </RadioGroup>
      ),
    },
    {
      id: 'disabled',
      render: () => (
        <RadioGroup label="Write mode" isDisabled defaultValue="append">
          <Radio value="append">Append</Radio>
          <Radio value="overwrite">Overwrite</Radio>
        </RadioGroup>
      ),
    },
    {
      id: 'read-only',
      render: () => (
        <RadioGroup label="Included features" isReadOnly defaultValue="standard">
          <Radio value="standard">Standard</Radio>
          <Radio value="enterprise">Enterprise</Radio>
        </RadioGroup>
      ),
    },
  ],
};
