import { useState } from 'react';
import { Button } from './Button';
import { ConfirmDialog, ConfirmProvider, useConfirm, type ConfirmTone } from './ConfirmDialog';
import type { GalleryEntry } from './gallery';

// Gallery examples are a developer tool, so their sample labels are plain text.
function wait(ms: number) {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}

function ConfirmDemo({
  label,
  tone,
  work,
}: {
  label: string;
  tone?: ConfirmTone;
  work?: () => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button variant={tone === 'danger' ? 'danger' : 'secondary'} onPress={() => setOpen(true)}>
        {label}
      </Button>
      <ConfirmDialog
        isOpen={open}
        onOpenChange={setOpen}
        tone={tone}
        title="Delete this row?"
        message="Every query that reads the row has to be run again, and the change cannot be undone."
        confirmLabel="Delete row"
        onConfirm={work}
      />
    </>
  );
}

function AskThroughHook() {
  const confirm = useConfirm();
  const [answer, setAnswer] = useState('Nothing asked yet');
  return (
    <>
      <Button
        variant="danger"
        onPress={async () => {
          const confirmed = await confirm({
            title: 'Drop this table?',
            message: 'The table and every index on it are removed.',
            confirmLabel: 'Drop table',
            tone: 'danger',
            onConfirm: () => wait(900),
          });
          setAnswer(confirmed ? 'Answered yes' : 'Answered no');
        }}
      >
        Ask with the hook
      </Button>
      <span>{answer}</span>
    </>
  );
}

export const gallery: GalleryEntry = {
  id: 'ui.confirm-dialog',
  title: 'ConfirmDialog',
  examples: [
    {
      id: 'tones',
      render: () => (
        <>
          <ConfirmDemo label="Default tone" />
          <ConfirmDemo label="Danger tone" tone="danger" />
        </>
      ),
    },
    {
      id: 'pending',
      render: () => (
        <>
          <ConfirmDemo label="Work that takes a moment" tone="danger" work={() => wait(1500)} />
          <ConfirmDemo
            label="Work that fails"
            tone="danger"
            work={() => wait(900).then(() => Promise.reject(new Error('The connection dropped')))}
          />
        </>
      ),
    },
    {
      id: 'hook',
      render: () => (
        <ConfirmProvider>
          <AskThroughHook />
        </ConfirmProvider>
      ),
    },
  ],
};
