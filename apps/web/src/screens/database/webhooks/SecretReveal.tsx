import { faCopy } from '@fortawesome/free-solid-svg-icons';
import { Trans, useLingui } from '@lingui/react/macro';
import { Banner, Button, DialogBody, DialogFooter, TextField, toast } from '@riosoma/ui';

export interface SecretRevealProps {
  secret: string;
  /** When a replaced secret stops signing, for a secret that replaced another */
  previousExpiresAt?: string;
  onDone(): void;
}

/**
 * Shows a signing secret the one time the server sends it.  Only a sealed copy is kept, so after
 * this the value is gone for good, and the warning and the read-only field are there for that.
 */
export function SecretReveal({ secret, previousExpiresAt, onDone }: SecretRevealProps) {
  const { t, i18n } = useLingui();

  async function copy() {
    try {
      await navigator.clipboard.writeText(secret);
    } catch {
      // A browser that refuses the clipboard still leaves the field, so it can be copied by hand.
      return;
    }
    toast.show({ tone: 'success', title: t({ id: 'webhooks.copied', message: 'Copied the secret' }) });
  }

  const until = previousExpiresAt
    ? i18n.date(new Date(previousExpiresAt), { dateStyle: 'medium', timeStyle: 'short' })
    : null;
  return (
    <>
      <DialogBody className="rio-webhooks__reveal">
        <Banner tone="warning">
          {t({
            id: 'webhooks.secret.warning',
            message: 'Copy this secret now.  You won’t be able to see it again.',
          })}
        </Banner>
        <p className="rio-webhooks__note">
          {until ? (
            <Trans id="webhooks.secret.replaced">
              Calls are signed with the old secret too until {until}, so you can update the receiver first.
            </Trans>
          ) : (
            <Trans id="webhooks.secret.use">
              The receiver uses it to check the Riosoma-Signature header on each call.
            </Trans>
          )}
        </p>
        <div className="rio-webhooks__secret">
          <div className="rio-webhooks__secret-field">
            <TextField
              label={t({ id: 'webhooks.secret.label', message: 'Signing secret' })}
              value={secret}
              isReadOnly
            />
          </div>
          <Button
            onPress={() => {
              void copy();
            }}
            aria-label={t({ id: 'webhooks.copy', message: 'Copy' })}
            icon={faCopy}
          />
        </div>
      </DialogBody>
      <DialogFooter>
        <Button variant="primary" onPress={onDone}>
          <Trans id="webhooks.done">Done</Trans>
        </Button>
      </DialogFooter>
    </>
  );
}
