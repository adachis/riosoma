import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { DialogTitle } from '@riosoma/ui';
import { HelpButton } from './HelpButton';
import { anchor, type AnchorId } from '../demos/anchors';

export function HelpDialogTitle({
  children,
  moduleId,
  section,
  anchorId,
}: {
  children: ReactNode;
  moduleId: string;
  section: string;
  anchorId: AnchorId;
}) {
  const heading = useRef<HTMLDivElement>(null);
  const [subject, setSubject] = useState(typeof children === 'string' ? children : '');
  useLayoutEffect(() => {
    setSubject(heading.current?.textContent ?? '');
  }, [children]);
  return (
    <div className="rio-help-heading rio-help-dialog-heading" {...anchor(anchorId)}>
      <div ref={heading}>
        <DialogTitle>{children}</DialogTitle>
      </div>
      <HelpButton subject={subject} moduleId={moduleId} section={section} />
    </div>
  );
}
