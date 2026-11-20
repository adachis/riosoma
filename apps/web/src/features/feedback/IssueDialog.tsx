import { useState } from 'react';
import { Trans, useLingui } from '@lingui/react/macro';
import { useMutation, useQuery } from '@tanstack/react-query';
import type { FeedbackItem, FeedbackIssueSend } from '@riosoma/contracts';
import {
  Button,
  Checkbox,
  Dialog,
  DialogBody,
  DialogFooter,
  DialogTitle,
  Modal,
  Spinner,
  toast,
} from '@riosoma/ui';
import { ErrorBanner } from '../../shell/ErrorBanner';
import { errorInfo } from '../../screens/setup/useSetup';
import { previewIssue, sendIssue } from './api';

type Send = { mode: 'create' } | { mode: 'comment'; issueNumber: number };

/**
 * Turns something broken into a GitHub issue.  It shows exactly what goes, word for word, before
 * anything is sent: the message and the context, and never the sender's name.  The screenshot
 * goes only when the admin ticks it.  Open issues with a close title are listed first, so the
 * report can join one of them as a comment instead.
 */
export function IssueDialog({
  item,
  onClose,
  onSent,
}: {
  item: FeedbackItem;
  onClose(): void;
  onSent(item: FeedbackItem): void;
}) {
  const { t } = useLingui();
  const [includeScreenshot, setIncludeScreenshot] = useState(false);
  const preview = useQuery({
    // Kept apart from the inbox's keys, so refreshing the inbox never asks GitHub again.
    queryKey: ['feedback-issue-preview', item.id, includeScreenshot],
    queryFn: () => previewIssue(item.id, includeScreenshot),
    retry: false,
    staleTime: 0,
    gcTime: 0,
  });
  const send = useMutation({
    mutationFn: (how: Send) => sendIssue(item.id, { ...how, includeScreenshot } as FeedbackIssueSend),
    onSuccess: (updated, how) => {
      const number = updated.issue?.number ?? 0;
      toast.show({
        tone: 'success',
        title:
          how.mode === 'create'
            ? t({ id: 'feedback.github.created', message: `Opened issue #${number}` })
            : t({ id: 'feedback.github.commented', message: `Added to issue #${number}` }),
      });
      onSent(updated);
      onClose();
    },
  });
  const shown = preview.data;
  const repository = shown?.repository ?? '';
  const path = shown?.screenshot?.path ?? '';

  return (
    <Modal
      isOpen
      isDismissable={!send.isPending}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      size="lg"
    >
      <Dialog>
        <DialogTitle>
          <Trans id="feedback.github.dialog">Send to GitHub</Trans>
        </DialogTitle>
        <DialogBody className="rio-feedback__body">
          <ErrorBanner error={errorInfo(preview.error ?? send.error)} />
          {item.screenshot ? (
            <Checkbox
              isSelected={includeScreenshot}
              onChange={setIncludeScreenshot}
              isDisabled={send.isPending}
              description={t({
                id: 'feedback.github.screenshot.detail',
                message: 'It’s added to the repository as a file, and the issue shows it.',
              })}
            >
              {t({ id: 'feedback.github.screenshot', message: 'Send the screenshot too' })}
            </Checkbox>
          ) : null}
          {preview.isPending ? (
            <Spinner label={t({ id: 'feedback.github.loading', message: 'Getting it ready' })} />
          ) : shown ? (
            <>
              <p className="rio-feedback__hint">
                {t({
                  id: 'feedback.github.exactly',
                  message: `This is exactly what’s sent to ${repository}.  The sender’s name never goes.`,
                })}
              </p>
              <section className="rio-feedback__section" aria-labelledby="feedback-issue-title">
                <h3 id="feedback-issue-title" className="rio-feedback__heading">
                  <Trans id="feedback.github.issueTitle">Title</Trans>
                </h3>
                <p>{shown.title}</p>
              </section>
              <section className="rio-feedback__section" aria-labelledby="feedback-issue-body">
                <h3 id="feedback-issue-body" className="rio-feedback__heading">
                  <Trans id="feedback.github.issueBody">Text</Trans>
                </h3>
                <pre className="rio-feedback-issue__body">{shown.body}</pre>
                {shown.screenshot ? (
                  <p className="rio-feedback__hint">
                    {t({
                      id: 'feedback.github.screenshotPath',
                      message: `The screenshot is added at ${path}, and its link takes the place marked in the text.`,
                    })}
                  </p>
                ) : null}
              </section>
              {shown.similar.length ? (
                <section className="rio-feedback__section" aria-labelledby="feedback-issue-similar">
                  <h3 id="feedback-issue-similar" className="rio-feedback__heading">
                    <Trans id="feedback.github.similar">Open issues with a close title</Trans>
                  </h3>
                  <ul className="rio-feedback-issue__similar">
                    {shown.similar.map((issue) => {
                      const number = issue.number;
                      return (
                        <li key={issue.number} className="rio-feedback-inbox__actions">
                          <a href={issue.url} target="_blank" rel="noreferrer">
                            #{number} {issue.title}
                          </a>
                          <Button
                            size="sm"
                            isPending={
                              send.isPending &&
                              send.variables?.mode === 'comment' &&
                              send.variables.issueNumber === issue.number
                            }
                            isDisabled={send.isPending}
                            onPress={() => {
                              send.reset();
                              send.mutate({ mode: 'comment', issueNumber: issue.number });
                            }}
                          >
                            <Trans id="feedback.github.comment">Add as a comment on #{number}</Trans>
                          </Button>
                        </li>
                      );
                    })}
                  </ul>
                </section>
              ) : null}
            </>
          ) : null}
        </DialogBody>
        <DialogFooter>
          <Button isDisabled={send.isPending} onPress={onClose}>
            <Trans id="feedback.cancel">Cancel</Trans>
          </Button>
          <Button
            variant="primary"
            isDisabled={!shown || (send.isPending && send.variables?.mode !== 'create')}
            isPending={send.isPending && send.variables?.mode === 'create'}
            onPress={() => {
              send.reset();
              send.mutate({ mode: 'create' });
            }}
          >
            <Trans id="feedback.github.open">Open a new issue</Trans>
          </Button>
        </DialogFooter>
      </Dialog>
    </Modal>
  );
}
