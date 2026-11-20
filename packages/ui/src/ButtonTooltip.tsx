import type { RefObject } from 'react';
import { Tooltip, TooltipTrigger } from './Tooltip';

/** The trigger stays mounted while tooltip positioning loads on intent. */
export default function ButtonTooltip({
  anchor,
  label,
  close,
}: {
  anchor: RefObject<HTMLElement | null>;
  label: string;
  close(): void;
}) {
  return (
    <TooltipTrigger
      isOpen
      onOpenChange={(open) => {
        if (!open) close();
      }}
    >
      <Tooltip
        triggerRef={anchor}
        // A native dialog's top layer also needs to contain its tooltip portal.
        UNSTABLE_portalContainer={anchor.current?.closest('dialog') ?? undefined}
      >
        {label}
      </Tooltip>
    </TooltipTrigger>
  );
}
