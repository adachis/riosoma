import { useState } from 'react';
import { Trans } from '@lingui/react/macro';
import { useMutation, useQuery } from '@tanstack/react-query';
import type { FeedbackItem } from '@riosoma/contracts';
import { Button, Checkbox, Dialog, DialogBody, DialogFooter, DialogTitle, Modal, Spinner } from '@riosoma/ui';
import { ErrorBanner } from '../../shell/ErrorBanner';
import { errorInfo } from '../../screens/setup/useSetup';
import { previewHubReport, sendHubReport } from './api';

export function HubDialog({
  item,
  onClose,
  onSent,
}: {
  item: FeedbackItem;
  onClose(): void;
  onSent(): void;
}) {
  const [softwareBug, setSoftwareBug] = useState(false);
  const preview = useQuery({
    queryKey: ['feedback-hub-preview', item.id],
    queryFn: () => previewHubReport(item.id),
    retry: false,
    gcTime: 0,
  });
  const send = useMutation({
    mutationFn: () => sendHubReport(item.id),
    onSuccess: () => {
      onSent();
      onClose();
    },
  });
  return (
    <Modal
      isOpen
      size="lg"
      isDismissable={!send.isPending}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <Dialog>
        <DialogTitle>
          <Trans id="feedback.hub.send">Send upstream</Trans>
        </DialogTitle>
        <DialogBody>
          <ErrorBanner error={errorInfo(preview.error ?? send.error)} />
          {preview.isPending ? (
            <Spinner />
          ) : preview.data ? (
            <>
              <p>
                <Trans id="feedback.hub.exactly">
                  This is exactly what goes to the hub and becomes public on GitHub. Review the text for
                  personal information. Screenshots never go upstream.
                </Trans>
              </p>
              <p>{preview.data.url}</p>
              <pre className="rio-feedback-issue__body" tabIndex={0}>
                {JSON.stringify(preview.data.payload, null, 2)}
              </pre>
              <Checkbox isSelected={softwareBug} onChange={setSoftwareBug} isDisabled={send.isPending}>
                <Trans id="feedback.hub.softwareBug">
                  I have confirmed this is a software bug and the preview is safe to publish.
                </Trans>
              </Checkbox>
            </>
          ) : null}
        </DialogBody>
        <DialogFooter>
          <Button onPress={onClose} isDisabled={send.isPending}>
            <Trans id="feedback.hub.cancel">Cancel</Trans>
          </Button>
          <Button
            variant="primary"
            isPending={send.isPending}
            isDisabled={!softwareBug || !preview.data}
            onPress={() => send.mutate()}
          >
            <Trans id="feedback.hub.send">Send upstream</Trans>
          </Button>
        </DialogFooter>
      </Dialog>
    </Modal>
  );
}
