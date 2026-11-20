import { Radio } from './Radio';
import { RadioGroup } from './RadioGroup';
import type { GalleryEntry } from './gallery';

// A radio only exists inside a group, which owns the selection, so every example brings its own.
// Gallery examples are a developer tool, so their sample labels are plain text.
export const gallery: GalleryEntry = {
  id: 'ui.radio',
  title: 'Radio',
  examples: [
    {
      id: 'states',
      render: () => (
        <RadioGroup label="Write mode" defaultValue="append">
          <Radio value="append">Append</Radio>
          <Radio value="overwrite">Overwrite</Radio>
          <Radio value="replace">Replace</Radio>
        </RadioGroup>
      ),
    },
    {
      id: 'description',
      render: () => (
        <RadioGroup label="Schedule">
          <Radio value="hourly" description="Runs at the top of every hour.">
            Hourly
          </Radio>
          <Radio value="daily" description="Runs overnight, in the workspace time zone.">
            Daily
          </Radio>
        </RadioGroup>
      ),
    },
    {
      id: 'disabled',
      render: () => (
        <RadioGroup label="Write mode" defaultValue="append">
          <Radio value="append">Append</Radio>
          <Radio value="overwrite" isDisabled>
            Overwrite
          </Radio>
          <Radio value="replace" isDisabled>
            Replace
          </Radio>
        </RadioGroup>
      ),
    },
    {
      id: 'invalid',
      render: () => (
        <RadioGroup label="Write mode" isInvalid>
          <Radio value="append">Append</Radio>
          <Radio value="overwrite">Overwrite</Radio>
        </RadioGroup>
      ),
    },
    {
      id: 'right-to-left',
      render: () => (
        <div dir="rtl">
          <RadioGroup label="Write mode" defaultValue="overwrite">
            <Radio value="append">Label at the inline end</Radio>
            <Radio value="overwrite" description="Mirrored too.">
              Overwrite
            </Radio>
          </RadioGroup>
        </div>
      ),
    },
  ],
};
