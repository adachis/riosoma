import { Checkbox } from './Checkbox';
import type { GalleryEntry } from './gallery';

// Gallery examples are a developer tool, so their sample labels are plain text.
export const gallery: GalleryEntry = {
  id: 'ui.checkbox',
  title: 'Checkbox',
  examples: [
    {
      id: 'states',
      render: () => (
        <>
          <Checkbox>Unchecked</Checkbox>
          <Checkbox defaultSelected>Checked</Checkbox>
          <Checkbox isIndeterminate>Mixed</Checkbox>
          <Checkbox defaultSelected isIndeterminate>
            Mixed over checked
          </Checkbox>
        </>
      ),
    },
    {
      id: 'description',
      render: () => (
        <Checkbox description="Sent at most once a day." defaultSelected>
          Email me about failures
        </Checkbox>
      ),
    },
    {
      id: 'disabled',
      render: () => (
        <>
          <Checkbox isDisabled>Unavailable</Checkbox>
          <Checkbox isDisabled defaultSelected>
            Unavailable, checked
          </Checkbox>
          <Checkbox isDisabled isIndeterminate>
            Unavailable, mixed
          </Checkbox>
        </>
      ),
    },
    {
      id: 'read-only',
      render: () => (
        <>
          <Checkbox isReadOnly defaultSelected>
            Locked on
          </Checkbox>
          <Checkbox isReadOnly>Locked off</Checkbox>
        </>
      ),
    },
    {
      id: 'invalid',
      render: () => <Checkbox isInvalid>You have to accept the terms first</Checkbox>,
    },
    {
      id: 'right-to-left',
      render: () => (
        <div dir="rtl">
          <Checkbox defaultSelected>Label at the inline end</Checkbox>
          <Checkbox description="Mirrored too." isIndeterminate>
            Mixed
          </Checkbox>
        </div>
      ),
    },
  ],
};
