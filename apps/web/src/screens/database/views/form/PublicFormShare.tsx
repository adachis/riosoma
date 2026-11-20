import { SettingsBar, SettingsTrigger } from '../../view/ToolbarSettings';
import { FormFilesPanel } from '../../../../features/public-sharing/FormFilesPanel';
import { EmbedPanel } from '../../../../features/public-sharing/EmbedPanel';
import { PublicThemePicker } from '../../../../features/themes/PublicThemePicker';
import { anchor } from '../../../../demos/anchors';
import { useEffect, useRef, useState } from 'react';
import { plural } from '@lingui/core/macro';
import { useLingui } from '@lingui/react/macro';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { faLink, faCopy } from '@fortawesome/free-solid-svg-icons';
import {
  PUBLIC_QUESTION_TYPES,
  type FieldMeta,
  type FormQuestion,
  type PublicFormLink,
  type ThemePick,
} from '@riosoma/contracts';
import {
  Banner,
  Button,
  ConfirmDialog,
  Dialog,
  DialogBody,
  DialogTitle,
  Modal,
  Spinner,
  Switch,
  TextField,
} from '@riosoma/ui';
import { api, ApiError } from '../../../../api';
import { useServerMessage } from '../../../../messages/useServerMessage';
import { useCelebrations } from '../../../../features/celebrations/useCelebrations';
import './public-form-share.css';

const PUBLIC_TYPES: ReadonlySet<string> = new Set(PUBLIC_QUESTION_TYPES);

export interface PublicFormShareProps {
  viewId: string;
  questions: readonly FormQuestion[];
  /** The table's fields, to name the questions a public form leaves out */
  fields: readonly FieldMeta[];
  /** The theme the form's public page picks for itself, or null for the database's */
  theme?: ThemePick | null;
  /** Saves the page's theme with the form's settings, for people who may change the form */
  onTheme?: (theme: ThemePick | null) => void;
}

/** The questions a form shared by link can't ask: people, linked records, files, and computed fields. */
export function omittedQuestions(questions: readonly FormQuestion[], fields: readonly FieldMeta[]): string[] {
  const byId = new Map(fields.map((field) => [field.id, field]));
  return questions.flatMap((question) => {
    const field = byId.get(question.fieldId);
    return field &&
      (!PUBLIC_TYPES.has(field.type) ||
        ((field.type === 'singleSelect' || field.type === 'multipleSelect') &&
          (field.options.source ||
            (field.options.cascade &&
              !questions.some((question) => question.fieldId === field.options.cascade?.fieldId)))))
      ? [question.label || field.name]
      : [];
  });
}

/**
 * Sharing a form by link, for people who can change the database's views.  It opens as a dialog,
 * like sharing a database, so the question before stopping can open over it.
 */
export function PublicFormShare(props: PublicFormShareProps) {
  const { t } = useLingui();
  const label = t({ id: 'forms.public.share', message: 'Share publicly' });
  return (
    <SettingsBar className="rio-public-form-share">
      <SettingsTrigger
        label={label}
        helpTopic={{ id: 'forms', section: 'sharing-a-form-by-link', anchorId: 'forms.public.theme' }}
      >
        <Button icon={faLink}>{label}</Button>
        <Modal isDismissable size="sm">
          <Dialog>
            <DialogTitle>{label}</DialogTitle>
            <DialogBody>
              <SharePanel {...props} />
            </DialogBody>
          </Dialog>
        </Modal>
      </SettingsTrigger>
    </SettingsBar>
  );
}

function SharePanel({ viewId, questions, fields, theme = null, onTheme }: PublicFormShareProps) {
  const { t } = useLingui();
  const message = useServerMessage();
  const client = useQueryClient();
  const root = useRef<HTMLDivElement>(null);
  const publishFocus = useRef<HTMLElement | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [copied, setCopied] = useState(false);
  const [revoking, setRevoking] = useState(false);
  const path = `/api/views/${encodeURIComponent(viewId)}/public-form`;
  const key = ['views', viewId, 'publicForm'];
  const link = useQuery({ queryKey: key, queryFn: () => api<PublicFormLink | null>(path) });
  const publish = useMutation({
    mutationFn: () => api<PublicFormLink>(path, { method: 'PUT' }),
    onSuccess: (data) => client.setQueryData(key, data),
    onSettled: () => {
      // Disabling the focused switch can leave focus on the body until the request finishes.
      requestAnimationFrame(() => {
        if (document.activeElement === document.body)
          root.current?.querySelector<HTMLElement>('[role="switch"]')?.focus();
      });
    },
  });
  const stop = useMutation({
    mutationFn: () => api<void>(path, { method: 'DELETE' }),
    onSuccess: () => {
      client.setQueryData(key, null);
      setCopied(false);
      // The link and its buttons go away with the link, so the switch takes the focus.
      requestAnimationFrame(() => root.current?.querySelector<HTMLElement>('[role="switch"]')?.focus());
    },
  });
  const revoke = useMutation({ mutationFn: () => api<void>(`${path}/revoke-edits`, { body: {} }) });
  const shared = link.data ?? null;
  const url = shared ? new URL(shared.url ?? shared.path, window.location.origin).href : '';
  const busy = link.isPending || publish.isPending || stop.isPending;
  useEffect(() => {
    if (busy || !publishFocus.current) return;
    // Focus parked on the dialog goes back to the switch.  So does focus a browser dropped to the
    // page while the switch was disabled, which the frame after settling can miss if it runs first.
    const active = document.activeElement;
    if (active === publishFocus.current || active === document.body || active === null) {
      root.current?.querySelector<HTMLElement>('[role="switch"]')?.focus();
    }
    publishFocus.current = null;
  }, [busy, publish.status]);
  const failure = publish.error ?? stop.error ?? revoke.error ?? link.error;
  const omitted = omittedQuestions(questions, fields);
  // The count is every answer the link ever took, so seeing it at none and later at one or more
  // means the form got its first answer.
  const submissions = shared?.submissions;
  const { observe } = useCelebrations();
  useEffect(() => {
    if (submissions === undefined) return;
    observe('formFirstResponse', viewId, submissions > 0, {
      anchor: root.current?.querySelector('.rio-public-form-share__count'),
      cause: 'others',
    });
  }, [submissions, viewId, observe]);

  async function copy() {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
    } catch {
      // A browser that refuses the clipboard still shows the link, ready to select and copy.
    }
  }

  return (
    <div ref={root} className="rio-public-form-share__body">
      <p className="rio-public-form-share__help">
        {t({
          id: 'forms.public.shareHelp',
          message: 'Anyone with the link can add a record, without signing in.',
        })}
      </p>
      <div className="rio-public-form-share__switch">
        <Switch
          isSelected={shared !== null}
          isDisabled={busy || link.isError}
          onChange={(on) => {
            publish.reset();
            stop.reset();
            if (on) {
              const toggle = root.current?.querySelector<HTMLElement>('[role="switch"]');
              if (toggle && document.activeElement === toggle) {
                // Disabling the switch would lose focus, leaving Escape outside the dialog.
                const dialog = toggle.closest<HTMLElement>('[role="dialog"]');
                publishFocus.current = dialog;
                dialog?.focus();
              }
              publish.mutate();
            } else setConfirming(true);
          }}
        >
          {t({ id: 'forms.public.share', message: 'Share publicly' })}
        </Switch>
        {busy && <Spinner size="sm" />}
      </div>
      {shared && (
        <>
          <div className="rio-public-form-share__link">
            <TextField
              label={t({ id: 'forms.public.link', message: 'Public link' })}
              value={url}
              isReadOnly
            />
            <Button
              onPress={() => {
                void copy();
              }}
              aria-label={t({ id: 'forms.public.copy', message: 'Copy link' })}
              icon={faCopy}
            />
          </div>
          <p className="rio-public-form-share__note" role="status">
            {copied ? t({ id: 'forms.public.copied', message: 'Copied the link' }) : ''}
          </p>
          {shared.suspendedSharer && (
            <Paused
              sharer={shared.suspendedSharer.name}
              pending={publish.isPending}
              onShareAgain={() => {
                publish.reset();
                publish.mutate();
              }}
            />
          )}
          <Responses count={shared.submissions} />
          <Button isPending={revoke.isPending} onPress={() => setRevoking(true)}>
            {t({ id: 'forms.edit.revoke', message: 'Revoke all edit links' })}
          </Button>
          {revoke.isSuccess && (
            <p role="status">
              {t({
                id: 'forms.edit.revokedAll',
                message: 'All existing edit links and sessions were revoked.',
              })}
            </p>
          )}
          {onTheme ? (
            <div className="rio-public-form-share__theme">
              <PublicThemePicker
                value={theme}
                onChange={onTheme}
                anchorProps={anchor('forms.public.theme')}
              />
            </div>
          ) : null}
          <FormFilesPanel formId={shared.formId} />
          <EmbedPanel
            target={{ kind: 'form', linkId: shared.formId }}
            url={url}
            name={t({ id: 'forms.public.share', message: 'Share publicly' })}
          />
          <Button variant="danger" isDisabled={busy} onPress={() => setConfirming(true)}>
            {t({ id: 'forms.public.stop', message: 'Stop sharing' })}
          </Button>
        </>
      )}
      {omitted.length > 0 && <OmittedQuestions names={omitted} />}
      <p className="rio-public-form-share__error" role="alert">
        {failure
          ? failure instanceof ApiError
            ? message(failure.info.messageKey, failure.info.params)
            : message('errors.internal')
          : ''}
      </p>
      <ConfirmDialog
        isOpen={revoking}
        onOpenChange={setRevoking}
        title={t({ id: 'forms.edit.revokeTitle', message: 'Revoke all edit links?' })}
        message={t({
          id: 'forms.edit.revokeHelp',
          message:
            'Existing edit links and open edit sessions will stop working.  New responses can still receive new links.',
        })}
        confirmLabel={t({ id: 'forms.edit.revoke', message: 'Revoke all edit links' })}
        tone="danger"
        onConfirm={() => revoke.mutateAsync().catch(() => undefined)}
      />
      <ConfirmDialog
        isOpen={confirming}
        onOpenChange={setConfirming}
        title={t({ id: 'forms.public.stop.title', message: 'Stop sharing this form?' })}
        message={t({
          id: 'forms.public.stop.body',
          message: 'The link stops working at once.  Sharing again makes a new link.',
        })}
        confirmLabel={t({ id: 'forms.public.stop', message: 'Stop sharing' })}
        tone="danger"
        // A failure closes the question too, so the reason shows in the panel behind it.
        onConfirm={() => stop.mutateAsync().catch(() => undefined)}
      />
    </div>
  );
}

/** A form whose sharer is suspended, and the way to bring it back at the same address */
function Paused({
  sharer,
  pending,
  onShareAgain,
}: {
  sharer: string;
  pending: boolean;
  onShareAgain(): void;
}) {
  const { t } = useLingui();
  return (
    <Banner tone="warning" title={t({ id: 'forms.public.paused', message: 'This form is paused' })}>
      <p className="rio-public-form-share__paused">
        {t({
          id: 'forms.public.paused.body',
          message: `${sharer}, who shared it, is suspended, so it isn’t taking answers.  Share it again to keep the same address and become its sharer.`,
        })}
      </p>
      <Button isPending={pending} onPress={onShareAgain}>
        {t({ id: 'forms.public.shareAgain', message: 'Share again' })}
      </Button>
    </Banner>
  );
}

function Responses({ count }: { count: number }) {
  const { t } = useLingui();
  return (
    <p className="rio-public-form-share__count">
      {t({
        id: 'forms.public.responses',
        message: plural(count, { one: '# response', other: '# responses' }),
      })}
    </p>
  );
}

function OmittedQuestions({ names }: { names: readonly string[] }) {
  const { t } = useLingui();
  const count = names.length;
  return (
    <div className="rio-public-form-share__omitted">
      <p>
        {t({
          id: 'forms.public.omitted',
          message: plural(count, {
            one: 'This question can’t be asked publicly:',
            other: 'These questions can’t be asked publicly:',
          }),
        })}
      </p>
      <ul>
        {names.map((name, index) => (
          <li key={`${index}:${name}`}>{name}</li>
        ))}
      </ul>
      <p className="rio-public-form-share__help">
        {t({
          id: 'forms.public.omittedReason',
          message: 'People, linked records, attachments, and calculated fields stay private.',
        })}
      </p>
    </div>
  );
}
