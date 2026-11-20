import { useRef, useState, type ReactNode } from 'react';
import { useLingui } from '@lingui/react/macro';
import { faEllipsis } from '@fortawesome/free-solid-svg-icons';
import { Button } from '@riosoma/ui';
import { LazyBoundary, lazyFeature } from './lazy';

const PopoverSurface = lazyFeature(() =>
  import('./PopoverSurface').then((module) => ({ default: module.PopoverSurface })),
);

/** Secondary controls keep their own behavior while the header reserves room for personal actions. */
export function HeaderOverflow({ children }: { children: ReactNode }) {
  const { t } = useLingui();
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const label = t({ id: 'shell.moreControls', message: 'More header controls' });
  return (
    <>
      <span
        ref={(element) => {
          trigger.current = element?.querySelector('button') ?? null;
        }}
      >
        <Button
          variant="quiet"
          size="sm"
          primaryAction
          icon={faEllipsis}
          aria-label={label}
          aria-haspopup="dialog"
          aria-expanded={open}
          onPress={() => setOpen(!open)}
        />
      </span>
      {open && (
        <LazyBoundary size="popover" triggerRef={trigger}>
          <PopoverSurface
            triggerRef={trigger}
            onClose={() => setOpen(false)}
            title={label}
            className="rio-shell__overflow"
            dialogClassName="rio-shell__overflow-controls"
          >
            {children}
          </PopoverSurface>
        </LazyBoundary>
      )}
    </>
  );
}
