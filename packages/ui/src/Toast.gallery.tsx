import { useMemo, type ReactNode } from 'react';
import { Button } from './Button';
import { createToastApi, createToastQueue, ToastRegion, type ToastApi } from './Toast';
import type { GalleryEntry } from './gallery';

/*
 * Gallery examples are a developer tool, so their sample labels are plain text.  A toast only
 * exists while it is queued, and it always renders in the corner of the page, so each example
 * pushes one on press instead of holding a stack open.  Examples keep their own queue, which
 * leaves the app's queue alone.
 */
function Demo({ children }: { children: (toasts: ToastApi) => ReactNode }) {
  const queue = useMemo(() => createToastQueue(), []);
  const toasts = useMemo(() => createToastApi(queue), [queue]);
  return (
    <>
      {children(toasts)}
      <ToastRegion queue={queue} />
    </>
  );
}

export const gallery: GalleryEntry = {
  id: 'ui.toast',
  title: 'Toast',
  examples: [
    {
      id: 'tones',
      render: () => (
        <Demo>
          {(toasts) => (
            <>
              <Button
                onPress={() =>
                  toasts.show({
                    title: 'Query saved',
                    description: 'It runs every night at 02:00.',
                    tone: 'info',
                  })
                }
              >
                Info
              </Button>
              <Button
                onPress={() =>
                  toasts.show({
                    title: 'Nightly backup finished',
                    description: '4.2 GB written to the archive volume.',
                    tone: 'success',
                  })
                }
              >
                Success
              </Button>
              <Button
                onPress={() =>
                  toasts.show({
                    title: 'Disk almost full',
                    description: '92% of the data volume is used.',
                    tone: 'warning',
                  })
                }
              >
                Warning
              </Button>
              <Button
                onPress={() =>
                  toasts.show({
                    title: 'Replication stopped',
                    description: 'The replica is 4 hours behind the primary.',
                    tone: 'danger',
                  })
                }
              >
                Danger
              </Button>
            </>
          )}
        </Demo>
      ),
    },
    {
      id: 'timeouts',
      render: () => (
        <Demo>
          {(toasts) => (
            <>
              <Button onPress={() => toasts.show({ title: 'Goes away after five seconds', tone: 'info' })}>
                Default timeout
              </Button>
              <Button onPress={() => toasts.show({ title: 'Stays until dismissed', tone: 'danger' })}>
                No timeout
              </Button>
              <Button
                onPress={() =>
                  toasts.show({ title: 'Goes away after two seconds', tone: 'success', timeout: 2000 })
                }
              >
                Two seconds
              </Button>
              <Button
                onPress={() =>
                  toasts.show({
                    title: 'Stays until dismissed',
                    description: 'A timeout of zero keeps even a transient tone on screen.',
                    tone: 'info',
                    timeout: 0,
                  })
                }
              >
                Transient tone, no timeout
              </Button>
            </>
          )}
        </Demo>
      ),
    },
    {
      id: 'stacking',
      render: () => (
        <Demo>
          {(toasts) => (
            <>
              <Button
                onPress={() => {
                  for (let i = 1; i <= 6; i += 1) {
                    toasts.show({
                      title: `Event ${i}`,
                      description: 'Only four stay on screen.',
                      tone: 'info',
                    });
                  }
                }}
              >
                Queue six
              </Button>
              <Button onPress={() => toasts.show({ title: 'Title only', tone: 'success' })}>
                Title only
              </Button>
              <Button
                onPress={() =>
                  toasts.show({
                    title: 'A long notice',
                    description:
                      'Riosoma keeps a write-ahead log for every change, so a replica that falls behind can catch up without a full copy of the data.',
                    tone: 'warning',
                  })
                }
              >
                Long description
              </Button>
            </>
          )}
        </Demo>
      ),
    },
  ],
};
