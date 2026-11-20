import { faXmark, faPlus } from '@fortawesome/free-solid-svg-icons';
import { useMemo, useRef, useState } from 'react';
import { Trans, useLingui } from '@lingui/react/macro';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { FEEDBACK_KINDS, FEEDBACK_LIMITS, type FeedbackContext, type FeedbackKind } from '@riosoma/contracts';
import {
  Banner,
  Button,
  Dialog,
  DialogBody,
  DialogFooter,
  DialogTitle,
  Modal,
  Radio,
  RadioGroup,
  TextArea,
  toast,
} from '@riosoma/ui';
import { appConfigQuery } from '../../app-config';
import { appliedSettings, useSession } from '../../session';
import { ErrorBanner } from '../../shell/ErrorBanner';
import { errorInfo } from '../../screens/setup/useSetup';
import { sendFeedback, sentFeedbackKey } from './api';
import { captureScreenshot, readImage } from './capture';
import { ContextList } from './ContextList';
import { feedbackContext } from './context';
import { useFeedbackWords } from './words';
import './feedback.css';

export interface FeedbackDialogProps {
  isOpen: boolean;
  onClose(): void;
}

/**
 * Send feedback: what kind it is, what the person wants to say, and a screenshot if they want one.
 * The context that goes with it is read once as the dialog opens and shown before it's sent.
 */
export function FeedbackDialog({ isOpen, onClose }: FeedbackDialogProps) {
  // Mounting is what starts a fresh message and reads the context from the page as it is now.
  return isOpen ? <FeedbackPanel onClose={onClose} /> : null;
}

function FeedbackPanel({ onClose }: { onClose(): void }) {
  const { t, i18n } = useLingui();
  const session = useSession();
  const words = useFeedbackWords();
  const queryClient = useQueryClient();
  const config = useQuery(appConfigQuery);
  // Where the person was and what went wrong, as they were when the dialog opened.
  const [opened] = useState(() =>
    feedbackContext({
      pathname: window.location.pathname,
      version: undefined,
      preferences: session?.preferences,
      org: appliedSettings(session),
      language: i18n.locale || 'en-US',
    }),
  );
  // The version arrives with the app's settings, once, and fills in the one blank.
  const context = useMemo<FeedbackContext>(
    () => ({ ...opened, appVersion: (config.data?.version ?? '').slice(0, 60) }),
    [opened, config.data?.version],
  );
  const [kind, setKind] = useState<FeedbackKind>('broken');
  const [message, setMessage] = useState('');
  const [attempted, setAttempted] = useState(false);
  const [screenshot, setScreenshot] = useState<string | null>(null);
  const [capturing, setCapturing] = useState(false);
  const [captureFailed, setCaptureFailed] = useState(false);
  const [uploadRefused, setUploadRefused] = useState(false);
  const upload = useRef<HTMLInputElement>(null);
  const empty = !message.trim();

  const send = useMutation({
    mutationFn: () =>
      sendFeedback({
        kind,
        message: message.trim(),
        context,
        ...(screenshot ? { screenshot } : {}),
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: sentFeedbackKey });
      // An admin who sends feedback sees it in the inbox and its count at once.
      void queryClient.invalidateQueries({ queryKey: ['admin', 'feedback'] });
      toast.show({
        tone: 'success',
        title: t({ id: 'feedback.sent', message: 'Thanks.  Your feedback is on its way to your admins.' }),
      });
      onClose();
    },
  });

  async function capture() {
    setCapturing(true);
    setCaptureFailed(false);
    setUploadRefused(false);
    const taken = await captureScreenshot(document.body);
    setCapturing(false);
    if (taken) setScreenshot(taken);
    else setCaptureFailed(true);
  }

  async function choose(file: File | undefined) {
    if (!file) return;
    const read = await readImage(file);
    setUploadRefused(!read);
    if (read) {
      setCaptureFailed(false);
      setScreenshot(read);
    }
  }

  return (
    <Modal
      isOpen
      isDismissable={!send.isPending}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      size="lg"
      // The screenshot is of the page, so the dialog and its scrim leave themselves out of it.
      overlayClassName="rio-feedback-overlay"
    >
      <Dialog className="rio-feedback">
        <DialogTitle>
          <Trans id="feedback.title">Send feedback</Trans>
        </DialogTitle>
        <DialogBody className="rio-feedback__body">
          <p className="rio-feedback__intro">
            {t({
              id: 'feedback.intro',
              message:
                'Your organization’s admins read everything sent here.  It stays in your organization.',
            })}
          </p>
          <ErrorBanner error={errorInfo(send.error)} />
          <RadioGroup
            label={t({ id: 'feedback.kind', message: 'What is it?' })}
            orientation="horizontal"
            value={kind}
            onChange={(value) => {
              const next = FEEDBACK_KINDS.find((item) => item === value);
              if (next) setKind(next);
            }}
            isDisabled={send.isPending}
          >
            {FEEDBACK_KINDS.map((item) => (
              <Radio key={item} value={item}>
                {words.kinds[item]}
              </Radio>
            ))}
          </RadioGroup>
          <TextArea
            label={t({ id: 'feedback.message', message: 'Your message' })}
            description={
              kind === 'broken'
                ? t({
                    id: 'feedback.message.broken',
                    message: 'What were you doing, what did you expect, and what happened instead?',
                  })
                : undefined
            }
            value={message}
            onChange={setMessage}
            rows={5}
            maxLength={FEEDBACK_LIMITS.messageLength}
            isRequired
            isDisabled={send.isPending}
            isInvalid={attempted && empty}
            errorMessage={t({ id: 'feedback.message.missing', message: 'Write a few words first.' })}
            autoFocus
          />
          <section className="rio-feedback__section" aria-labelledby="feedback-screenshot">
            <h3 id="feedback-screenshot" className="rio-feedback__heading">
              <Trans id="feedback.screenshot">Screenshot</Trans>
            </h3>
            {screenshot ? (
              <figure className="rio-feedback__shot">
                <img
                  src={screenshot}
                  alt={t({
                    id: 'feedback.screenshot.alt',
                    message: 'This page, with every value blurred out',
                  })}
                />
                <figcaption>
                  {t({
                    id: 'feedback.screenshot.caption',
                    message:
                      'This is exactly what’s sent.  Values, names, and anything typed are blurred out.',
                  })}
                </figcaption>
                <Button
                  size="sm"
                  isDisabled={send.isPending}
                  onPress={() => setScreenshot(null)}
                  aria-label={t({ id: 'feedback.screenshot.remove', message: 'Remove the screenshot' })}
                  icon={faXmark}
                />
              </figure>
            ) : (
              <>
                <p className="rio-feedback__hint">
                  {t({
                    id: 'feedback.screenshot.hint',
                    message:
                      'Add a picture of this page.  Every value, name, email address, and anything typed is blurred out before it leaves your browser, and you see it first.',
                  })}
                </p>
                <div className="rio-feedback__actions">
                  <Button
                    size="sm"
                    isPending={capturing}
                    isDisabled={send.isPending}
                    onPress={() => void capture()}
                    aria-label={t({
                      id: 'feedback.screenshot.take',
                      message: 'Add a screenshot of this page',
                    })}
                    icon={faPlus}
                  />
                  {captureFailed || uploadRefused ? (
                    <Button size="sm" isDisabled={send.isPending} onPress={() => upload.current?.click()}>
                      <Trans id="feedback.screenshot.upload">Choose an image instead</Trans>
                    </Button>
                  ) : null}
                </div>
                {captureFailed ? (
                  <Banner tone="info">
                    {t({
                      id: 'feedback.screenshot.failed',
                      message:
                        'This browser couldn’t take the screenshot.  You can choose an image of your own instead, up to 2 MB.',
                    })}
                  </Banner>
                ) : null}
                {uploadRefused ? (
                  <Banner tone="warning">
                    <Trans id="feedback.screenshot.refused">
                      Choose a PNG, JPEG, or WebP image of 2 MB or less.
                    </Trans>
                  </Banner>
                ) : null}
                <input
                  ref={upload}
                  type="file"
                  accept="image/png,image/jpeg,image/webp"
                  hidden
                  aria-label={t({ id: 'feedback.screenshot.upload', message: 'Choose an image instead' })}
                  onChange={(event) => {
                    void choose(event.target.files?.[0]);
                    event.target.value = '';
                  }}
                />
              </>
            )}
          </section>
          <section className="rio-feedback__section" aria-labelledby="feedback-context">
            <h3 id="feedback-context" className="rio-feedback__heading">
              <Trans id="feedback.context.title">Sent with it</Trans>
            </h3>
            <p className="rio-feedback__hint">
              {t({
                id: 'feedback.context.hint',
                message:
                  'So your admins can see where you were.  It never includes a record or any of its values.',
              })}
            </p>
            <ContextList context={context} />
          </section>
        </DialogBody>
        <DialogFooter>
          <Button isDisabled={send.isPending} onPress={onClose}>
            <Trans id="feedback.cancel">Cancel</Trans>
          </Button>
          <Button
            variant="primary"
            isPending={send.isPending}
            onPress={() => {
              setAttempted(true);
              if (empty) return;
              send.reset();
              send.mutate();
            }}
          >
            <Trans id="feedback.send">Send feedback</Trans>
          </Button>
        </DialogFooter>
      </Dialog>
    </Modal>
  );
}
