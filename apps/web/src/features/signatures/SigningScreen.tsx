import { useState, useSyncExternalStore } from 'react';
import { useLingui } from '@lingui/react/macro';
import { useMutation, useQuery } from '@tanstack/react-query';
import {
  SIGNATURE_TEXT_LIMIT,
  type PublicSignatureRequest,
  type SignatureAnswer,
  type SignatureDrawing,
} from '@riosoma/contracts';
import { Banner, Button, Checkbox, Spinner } from '@riosoma/ui';
import { api, ApiError } from '../../api';
import { SignaturePad } from '../../fields/SignaturePad';
import { useServerMessage } from '../../messages/useServerMessage';
import { signatureKinds } from './messages';
import './signatures.css';

async function signatureRaster(drawing: SignatureDrawing | null, name: string | null) {
  const canvas = document.createElement('canvas');
  canvas.width = drawing?.width ?? 800;
  canvas.height = drawing?.height ?? 160;
  const context = canvas.getContext('2d')!;
  // Saved ink stays black even when the signing page uses a dark theme.
  context.strokeStyle = 'black';
  context.fillStyle = context.strokeStyle;
  if (drawing) {
    context.lineWidth = 2;
    context.lineCap = 'round';
    context.lineJoin = 'round';
    context.stroke(new Path2D(drawing.path));
  } else {
    await document.fonts.load('64px "Rio Signature"');
    context.font = '64px "Rio Signature"';
    context.fillText(name ?? '', 12, 110, 776);
  }
  return canvas.toDataURL('image/png');
}

function onHashChange(changed: () => void) {
  window.addEventListener('hashchange', changed);
  return () => window.removeEventListener('hashchange', changed);
}

/**
 * The page for the signing link in the address.  Another link opened in the same tab differs only
 * after the #, so the browser doesn't load the page again: the screen follows the address instead,
 * and starts over for the new link, so nothing from the last request carries into it.
 */
export function SigningScreen() {
  const token = useSyncExternalStore(onHashChange, () => window.location.hash.slice(1));
  return <SigningRequest key={token} token={token} />;
}

function SigningRequest({ token }: { token: string }) {
  const { t, i18n } = useLingui();
  const messageFor = useServerMessage();
  const query = `token=${encodeURIComponent(token)}`;
  const preview = useQuery({
    queryKey: ['public-signature', token],
    queryFn: () => api<PublicSignatureRequest>(`/api/public/signatures?${query}`),
    retry: false,
  });
  const [values, setValues] = useState<Record<string, SignatureAnswer>>({});
  const [step, setStep] = useState(0);
  const [consent, setConsent] = useState(false);
  const [reason, setReason] = useState('');
  const [declining, setDeclining] = useState(false);
  const [imageError, setImageError] = useState(false);
  const [imagePending, setImagePending] = useState(false);
  const finish = useMutation({
    mutationFn: (decline: boolean) =>
      api(`/api/public/signatures/${decline ? 'decline' : 'sign'}?${query}`, {
        method: 'POST',
        body: decline
          ? { reason }
          : {
              consent,
              consentText: preview.data?.consent,
              values,
              // The date signed is stamped in the signer's own zone.
              timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
            },
      }),
  });
  const fields = [...(preview.data?.fields ?? [])].sort((a, b) => a.page - b.page || a.y - b.y || a.x - b.x);
  const active = fields[step];
  const documentName = preview.data?.name ?? '';
  const ready = (field: (typeof fields)[number]) =>
    field.kind === 'name' ||
    field.kind === 'date' ||
    (field.kind === 'text' ? Boolean(values[field.id]?.text.trim()) : Boolean(values[field.id]?.image));
  const complete = fields.length > 0 && fields.every(ready);
  const failure = preview.error ?? finish.error;
  async function imageFor(fieldId: string, create: () => Promise<string>, text: string) {
    setImagePending(true);
    setImageError(false);
    try {
      const image = await create();
      setValues((values) => ({ ...values, [fieldId]: { text, image } }));
    } catch {
      setImageError(true);
    } finally {
      setImagePending(false);
    }
  }
  return (
    <main className="rio-signatures rio-signatures__public">
      <h1>
        {documentName
          ? t({ id: 'signatures.sign.title', message: `Sign ${documentName}` })
          : t({ id: 'signatures.sign.untitled', message: 'Signing request' })}
      </h1>
      {failure && (
        <Banner tone="danger">
          {failure instanceof ApiError
            ? messageFor(failure.info.messageKey, failure.info.params)
            : messageFor('errors.internal')}
        </Banner>
      )}
      {!preview.data && !failure && (
        <Spinner label={t({ id: 'signatures.sign.loading', message: 'Loading signing request' })} />
      )}
      {finish.isSuccess ? (
        <p role="status">
          {declining
            ? t({ id: 'signatures.sign.declined', message: 'You declined this request.' })
            : t({
                id: 'signatures.sign.done',
                message:
                  'Your signature has been recorded.  You will receive the signed PDF after everyone signs and the file passes its scan.',
              })}
        </p>
      ) : (
        preview.data && (
          <>
            <p>{preview.data.message}</p>
            <p>
              {t({
                id: 'signatures.sign.due',
                message: `Sign by ${new Date(preview.data.expiresAt).toLocaleString(i18n.locale)}`,
              })}
            </p>
            <ul>
              {preview.data.signers.map((person, index) => (
                <li key={index}>
                  {person.name}—
                  {person.signed
                    ? t({ id: 'signatures.state.signed', message: 'Signed' })
                    : t({ id: 'signatures.state.pending', message: 'Pending' })}
                </li>
              ))}
            </ul>
            {preview.data.otherFields.length > 0 && (
              <p>
                {t({
                  id: 'signatures.sign.othersNote',
                  message:
                    'Outlined fields marked “For” another name belong to the other signers.  Those people will fill them in.',
                })}
              </p>
            )}
            <iframe
              className="rio-signatures__reader"
              title={t({ id: 'signatures.sign.document', message: 'Document to sign' })}
              src={`/api/public/signatures/document?${query}#page=${(active?.page ?? 0) + 1}`}
            />
            {active && (
              <section aria-label={t({ id: 'signatures.sign.fields', message: 'Your signing fields' })}>
                <h2>
                  {t({
                    id: 'signatures.sign.progress',
                    message: `Field ${step + 1} of ${fields.length} on page ${active.page + 1}`,
                  })}
                </h2>
                <h3>{i18n._(signatureKinds[active.kind])}</h3>
                {active.kind === 'signature' || active.kind === 'initials' ? (
                  <>
                    <SignaturePad
                      key={active.id}
                      label={i18n._(signatureKinds[active.kind])}
                      onSign={({ drawing, name }) => {
                        void imageFor(active.id, () => signatureRaster(drawing, name), name ?? '');
                      }}
                    />
                    <label>
                      {t({ id: 'signatures.sign.upload', message: 'Or upload a signature image' })}
                      <input
                        type="file"
                        accept="image/png,image/jpeg"
                        disabled={imagePending}
                        onChange={(event) => {
                          const file = event.target.files?.[0];
                          if (!file) return;
                          void imageFor(
                            active.id,
                            async () => {
                              if (file.size > 2_000_000) throw new Error('image size');
                              const bitmap = await createImageBitmap(file);
                              try {
                                if (bitmap.width * bitmap.height > 2_000_000)
                                  throw new Error('image dimensions');
                                const canvas = document.createElement('canvas');
                                const scale = Math.min(1, 1200 / bitmap.width, 400 / bitmap.height);
                                canvas.width = Math.max(1, Math.round(bitmap.width * scale));
                                canvas.height = Math.max(1, Math.round(bitmap.height * scale));
                                canvas.getContext('2d')!.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
                                return canvas.toDataURL('image/png');
                              } finally {
                                bitmap.close();
                              }
                            },
                            '',
                          );
                        }}
                      />
                    </label>
                    {values[active.id]?.image && (
                      <img
                        className="rio-signatures__signature"
                        src={values[active.id]!.image}
                        alt={t({ id: 'signatures.sign.preview', message: 'Your signature preview' })}
                      />
                    )}
                    {imageError && <Banner tone="danger">{messageFor('signatures.invalidImage')}</Banner>}
                  </>
                ) : active.kind === 'text' ? (
                  <label>
                    {i18n._(signatureKinds.text)}
                    <textarea
                      maxLength={SIGNATURE_TEXT_LIMIT}
                      value={values[active.id]?.text ?? ''}
                      onChange={(event) =>
                        setValues({ ...values, [active.id]: { text: event.target.value } })
                      }
                    />
                  </label>
                ) : (
                  <p>
                    {active.kind === 'name'
                      ? preview.data.signerName
                      : t({
                          id: 'signatures.sign.serverDate',
                          message: 'The date you finish signing is recorded, in your own time zone.',
                        })}
                  </p>
                )}
                <div className="rio-signatures__actions">
                  <Button isDisabled={step === 0 || imagePending} onPress={() => setStep(step - 1)}>
                    {t({ id: 'signatures.sign.previous', message: 'Previous field' })}
                  </Button>
                  <Button
                    isDisabled={step === fields.length - 1 || !ready(active) || imagePending}
                    onPress={() => setStep(step + 1)}
                  >
                    {t({ id: 'signatures.sign.next', message: 'Next field' })}
                  </Button>
                </div>
              </section>
            )}
            <Checkbox isSelected={consent} onChange={setConsent}>
              {preview.data.consent}
            </Checkbox>
            <Button
              variant="primary"
              isDisabled={!complete || !consent || imagePending}
              isPending={finish.isPending}
              onPress={() => {
                setDeclining(false);
                finish.mutate(false);
              }}
            >
              {t({ id: 'signatures.sign.finish', message: 'Agree and finish signing' })}
            </Button>
            <Button variant="quiet" onPress={() => setDeclining(!declining)}>
              {t({ id: 'signatures.sign.decline', message: 'Decline to sign' })}
            </Button>
            {declining && (
              <div className="rio-signatures">
                <label>
                  {t({ id: 'signatures.sign.reason', message: 'Reason for declining' })}
                  <textarea
                    value={reason}
                    maxLength={2000}
                    onChange={(event) => setReason(event.target.value)}
                  />
                </label>
                <Button
                  isDisabled={!reason.trim()}
                  isPending={finish.isPending}
                  onPress={() => finish.mutate(true)}
                >
                  {t({ id: 'signatures.sign.confirmDecline', message: 'Confirm decline' })}
                </Button>
              </div>
            )}
          </>
        )
      )}
    </main>
  );
}
