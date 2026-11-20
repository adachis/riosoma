import { lazy, Suspense } from 'react';
import type { TextConflictDialogProps } from './TextConflictDialog';

const Dialog = lazy(() =>
  import('./TextConflictDialog').then((module) => ({ default: module.TextConflictDialog })),
);

export function TextConflictDialog(props: TextConflictDialogProps) {
  return (
    <Suspense fallback={null}>
      <Dialog {...props} />
    </Suspense>
  );
}
