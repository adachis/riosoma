import { Switch } from './Switch';
import type { GalleryEntry } from './gallery';

// Gallery examples are a developer tool, so their sample labels are plain text.
export const gallery: GalleryEntry = {
  id: 'ui.switch',
  title: 'Switch',
  examples: [
    {
      id: 'states',
      render: () => (
        <>
          <Switch>Off</Switch>
          <Switch defaultSelected>On</Switch>
        </>
      ),
    },
    {
      id: 'description',
      render: () => (
        <Switch description="Applies to new connections only." defaultSelected>
          Require encryption
        </Switch>
      ),
    },
    {
      id: 'disabled',
      render: () => (
        <>
          <Switch isDisabled>Unavailable, off</Switch>
          <Switch isDisabled defaultSelected>
            Unavailable, on
          </Switch>
        </>
      ),
    },
    {
      id: 'read-only',
      render: () => (
        <>
          <Switch isReadOnly defaultSelected>
            Locked on
          </Switch>
          <Switch isReadOnly>Locked off</Switch>
        </>
      ),
    },
    {
      id: 'invalid',
      render: () => <Switch isInvalid>Allow anonymous access</Switch>,
    },
    {
      id: 'right-to-left',
      render: () => (
        <div dir="rtl">
          <Switch>Off</Switch>
          <Switch defaultSelected description="The thumb travels the other way.">
            On
          </Switch>
        </div>
      ),
    },
  ],
};
