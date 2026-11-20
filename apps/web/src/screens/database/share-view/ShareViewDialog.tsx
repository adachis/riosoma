import { HelpDialogTitle } from '../../../docs/HelpDialogTitle';
import { faCopy } from '@fortawesome/free-solid-svg-icons';
import { useRef, useState } from 'react';
import { useLingui } from '@lingui/react/macro';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  embedSite,
  requiredFieldIds,
  SHARED_VIEW_LIMITS,
  sharedFieldIds,
  type FieldMeta,
  type SharedViewLink,
  type SharedViewUpdate,
  type ViewMeta,
} from '@riosoma/contracts';
import {
  Banner,
  Button,
  Checkbox,
  CheckboxGroup,
  ConfirmDialog,
  Dialog,
  DialogBody,
  Modal,
  PasswordField,
  Radio,
  RadioGroup,
  Spinner,
  Switch,
  TextArea,
  TextField,
} from '@riosoma/ui';
import { api, ApiError } from '../../../api';
import { useServerMessage } from '../../../messages/useServerMessage';
import { anchor } from '../../../demos/anchors';
import { PublicThemePicker } from '../../../features/themes/PublicThemePicker';
import './share-view.css';

export interface ShareViewDialogProps {
  view: ViewMeta;
  /** Every field of the view's table, in the table's order */
  fields: readonly FieldMeta[];
  primaryFieldId: string;
  onClose(): void;
}

/** An embed code for the link, with the view's name as the frame's accessible title. */
export function embedCode(url: string, name: string): string {
  const title = name
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
  return `<iframe src="${url}" title="${title}" width="100%" height="600" style="border: 0" loading="lazy"></iframe>`;
}

/**
 * Sharing a view by link, for people who can change the database's views: publishing it, what
 * the link shows and allows, a password, embedding it on other sites, and stopping it.
 */
export function ShareViewDialog(props: ShareViewDialogProps) {
  const { t } = useLingui();
  return (
    <Modal
      isOpen
      isDismissable
      size="md"
      onOpenChange={(open) => {
        if (!open) props.onClose();
      }}
    >
      <Dialog>
        <HelpDialogTitle moduleId="public-view-links" section="making-a-link" anchorId="shareView.dialog">
          {t({ id: 'shareView.title', message: 'Share view' })}
        </HelpDialogTitle>
        <DialogBody>
          <SharePanel {...props} />
        </DialogBody>
      </Dialog>
    </Modal>
  );
}

function SharePanel({ view, fields, primaryFieldId }: ShareViewDialogProps) {
  const { t } = useLingui();
  const message = useServerMessage();
  const client = useQueryClient();
  const root = useRef<HTMLDivElement>(null);
  const [confirming, setConfirming] = useState(false);
  const [copied, setCopied] = useState<'link' | 'embed' | null>(null);
  const path = `/api/views/${encodeURIComponent(view.id)}/shared-view`;
  const key = ['views', view.id, 'sharedView'];
  const link = useQuery({ queryKey: key, queryFn: () => api<SharedViewLink | null>(path) });
  const saved = (data: SharedViewLink) => client.setQueryData(key, data);
  const publish = useMutation({
    mutationFn: () => api<SharedViewLink>(path, { method: 'PUT' }),
    onSuccess: saved,
  });
  const change = useMutation({
    mutationFn: (update: SharedViewUpdate) => api<SharedViewLink>(path, { method: 'PATCH', body: update }),
    onSuccess: saved,
  });
  const stop = useMutation({
    mutationFn: () => api<void>(path, { method: 'DELETE' }),
    onSuccess: () => {
      client.setQueryData(key, null);
      setCopied(null);
      // The link and its settings go away with it, so the switch takes the focus.
      requestAnimationFrame(() => root.current?.querySelector<HTMLElement>('[role="switch"]')?.focus());
    },
  });
  const shared = link.data ?? null;
  const busy = link.isPending || publish.isPending || stop.isPending;
  const failure = publish.error ?? change.error ?? stop.error ?? link.error;
  // Someone the rules limit can't read a link another person shared, but may still stop it.
  const unreadable =
    link.error instanceof ApiError && link.error.info.messageKey === 'data.access.linkLimited';
  const url = shared ? new URL(shared.url ?? shared.path, window.location.origin).href : '';

  async function copy(text: string, what: 'link' | 'embed') {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(what);
    } catch {
      // A browser that refuses the clipboard still shows the text, ready to select and copy.
    }
  }

  function save(update: SharedViewUpdate) {
    change.reset();
    change.mutate(update);
  }

  return (
    <div ref={root} className="rio-share-view">
      <p className="rio-share-view__help" {...anchor('shareView.help')}>
        {t({
          id: 'shareView.help',
          message:
            'Anyone with the link can see this view without signing in.  Nobody can change anything through it.',
        })}
      </p>
      <div className="rio-share-view__row">
        <Switch
          isSelected={shared !== null}
          isDisabled={busy || link.isError}
          {...anchor('shareView.publish')}
          onChange={(on) => {
            publish.reset();
            stop.reset();
            if (on) publish.mutate();
            else setConfirming(true);
          }}
        >
          {t({ id: 'shareView.publish', message: 'Share by link' })}
        </Switch>
        {(busy || change.isPending) && <Spinner size="sm" />}
      </div>
      {shared && (
        <>
          <div className="rio-share-view__copy">
            <TextField label={t({ id: 'shareView.link', message: 'Link' })} value={url} isReadOnly />
            <Button
              onPress={() => void copy(url, 'link')}
              aria-label={t({ id: 'shareView.copyLink', message: 'Copy link' })}
              icon={faCopy}
            />
          </div>
          <p className="rio-share-view__note" role="status">
            {copied === 'link'
              ? t({ id: 'shareView.copiedLink', message: 'Copied the link' })
              : copied === 'embed'
                ? t({ id: 'shareView.copiedEmbed', message: 'Copied the embed code' })
                : ''}
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
          <FieldChoice
            link={shared}
            view={view}
            fields={fields}
            primaryFieldId={primaryFieldId}
            disabled={change.isPending}
            onSave={save}
          />
          <Switch
            isSelected={shared.settings.allowCopy}
            isDisabled={change.isPending}
            onChange={(allowCopy) => save({ allowCopy })}
          >
            {t({ id: 'shareView.allowCopy', message: 'Allow copying and downloading as CSV' })}
          </Switch>
          <div className="rio-share-view__section">
            <PublicThemePicker
              value={shared.settings.theme ?? null}
              onChange={(theme) => save({ theme })}
              isDisabled={change.isPending}
              anchorProps={anchor('shareView.theme')}
            />
          </div>
          <PasswordChoice link={shared} disabled={change.isPending} onSave={save} />
          <EmbedChoice
            link={shared}
            url={url}
            name={view.name}
            disabled={change.isPending}
            onSave={save}
            onCopy={(code) => void copy(code, 'embed')}
          />
          <Button variant="danger" isDisabled={busy} onPress={() => setConfirming(true)}>
            {t({ id: 'shareView.stop', message: 'Stop sharing' })}
          </Button>
        </>
      )}
      <p className="rio-share-view__error" role="alert">
        {failure
          ? failure instanceof ApiError
            ? message(failure.info.messageKey, failure.info.params)
            : message('errors.internal')
          : ''}
      </p>
      {unreadable && (
        <Button variant="danger" isDisabled={busy} onPress={() => setConfirming(true)}>
          {t({ id: 'shareView.stop', message: 'Stop sharing' })}
        </Button>
      )}
      <ConfirmDialog
        isOpen={confirming}
        onOpenChange={setConfirming}
        title={t({ id: 'shareView.stopTitle', message: 'Stop sharing this view?' })}
        message={t({
          id: 'shareView.stopBody',
          message: 'The link and every embed stop working at once.  Sharing again makes a new link.',
        })}
        confirmLabel={t({ id: 'shareView.stop', message: 'Stop sharing' })}
        tone="danger"
        // A failure closes the question too, so the reason shows in the panel behind it.
        onConfirm={() => stop.mutateAsync().catch(() => undefined)}
      />
    </div>
  );
}

/** A link whose sharer is suspended, and the way to bring it back at the same address */
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
    <Banner tone="warning" title={t({ id: 'shareView.paused', message: 'This link is paused' })}>
      <p className="rio-share-view__paused">
        {t({
          id: 'shareView.paused.body',
          message: `${sharer}, who shared it, is suspended, so it isn’t working.  Share it again to keep the same address and become its sharer.`,
        })}
      </p>
      <Button isPending={pending} onPress={onShareAgain}>
        {t({ id: 'shareView.shareAgain', message: 'Share again' })}
      </Button>
    </Banner>
  );
}

function FieldChoice({
  link,
  view,
  fields,
  primaryFieldId,
  disabled,
  onSave,
}: {
  link: SharedViewLink;
  view: ViewMeta;
  fields: readonly FieldMeta[];
  primaryFieldId: string;
  disabled: boolean;
  onSave(update: SharedViewUpdate): void;
}) {
  const { t } = useLingui();
  const byId = new Map(fields.map((field) => [field.id, field]));
  const visible = sharedFieldIds(view, fields, primaryFieldId, { fieldIds: null }).shown;
  const required = new Set(requiredFieldIds(view, fields, primaryFieldId));
  const picked = link.settings.fieldIds;
  const chosen = picked === null ? visible : visible.filter((id) => required.has(id) || picked.includes(id));
  // Fields the layout needs but the view hides still go out, so they're named here too.
  const extra = [...required].filter((id) => !visible.includes(id));
  const names = extra.map((id) => byId.get(id)?.name ?? '').join(', ');
  return (
    <div className="rio-share-view__section">
      <RadioGroup
        label={t({ id: 'shareView.fields', message: 'Fields' })}
        value={picked === null ? 'all' : 'some'}
        isDisabled={disabled}
        onChange={(value) =>
          onSave({ fieldIds: value === 'all' ? null : visible.filter((id) => !required.has(id)) })
        }
      >
        <Radio value="all">{t({ id: 'shareView.fieldsAll', message: 'Every field the view shows' })}</Radio>
        <Radio value="some">{t({ id: 'shareView.fieldsSome', message: 'Only the fields I pick' })}</Radio>
      </RadioGroup>
      {picked === null ? (
        <p className="rio-share-view__help">
          {t({
            id: 'shareView.fieldsAllHelp',
            message: 'Fields the view starts showing later are shared too.  Hidden fields never are.',
          })}
        </p>
      ) : (
        <CheckboxGroup
          aria-label={t({ id: 'shareView.fieldsPicked', message: 'Shared fields' })}
          value={chosen}
          isDisabled={disabled}
          onChange={(ids) => onSave({ fieldIds: ids.filter((id) => !required.has(id)) })}
        >
          {visible.map((id) => (
            <Checkbox
              key={id}
              value={id}
              isDisabled={required.has(id)}
              description={
                required.has(id)
                  ? t({ id: 'shareView.fieldRequired', message: 'Always shared, since the view needs it' })
                  : undefined
              }
            >
              {byId.get(id)?.name ?? ''}
            </Checkbox>
          ))}
        </CheckboxGroup>
      )}
      {extra.length > 0 && (
        <p className="rio-share-view__help">
          {t({
            id: 'shareView.fieldsExtra',
            message: `Also shared, since the view needs them: ${names}`,
          })}
        </p>
      )}
    </div>
  );
}

function PasswordChoice({
  link,
  disabled,
  onSave,
}: {
  link: SharedViewLink;
  disabled: boolean;
  onSave(update: SharedViewUpdate): void;
}) {
  const { t } = useLingui();
  const [choosing, setChoosing] = useState(false);
  const [password, setPassword] = useState('');
  const [problem, setProblem] = useState('');
  const open = link.hasPassword || choosing;
  const min = SHARED_VIEW_LIMITS.passwordMin;

  function submit() {
    if (password.length < min) {
      setProblem(t({ id: 'shareView.passwordShort', message: `Use at least ${min} characters.` }));
      return;
    }
    // The field stays open, so it reads "New password" once the server has the first one.
    onSave({ password });
    setPassword('');
    setProblem('');
  }

  return (
    <div className="rio-share-view__section">
      <Switch
        isSelected={open}
        isDisabled={disabled}
        onChange={(on) => {
          setProblem('');
          setPassword('');
          setChoosing(on);
          if (!on && link.hasPassword) onSave({ password: null });
        }}
      >
        {t({ id: 'shareView.passwordOn', message: 'Ask for a password' })}
      </Switch>
      {open && (
        <form
          className="rio-share-view__copy"
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            submit();
          }}
        >
          <PasswordField
            label={
              link.hasPassword
                ? t({ id: 'shareView.passwordNew', message: 'New password' })
                : t({ id: 'shareView.password', message: 'Password' })
            }
            description={
              link.hasPassword
                ? t({
                    id: 'shareView.passwordSet',
                    message: 'A password is set.  Changing it asks everyone again.',
                  })
                : undefined
            }
            value={password}
            onChange={(value) => {
              setPassword(value);
              setProblem('');
            }}
            autoComplete="new-password"
            isInvalid={Boolean(problem)}
            errorMessage={problem}
          />
          <Button type="submit" isDisabled={disabled || !password}>
            {link.hasPassword
              ? t({ id: 'shareView.passwordChange', message: 'Change password' })
              : t({ id: 'shareView.passwordSave', message: 'Save password' })}
          </Button>
        </form>
      )}
    </div>
  );
}

export function EmbedChoice({
  link,
  url,
  name,
  disabled,
  onSave,
  onCopy,
}: {
  link: { settings: Pick<SharedViewLink['settings'], 'embed'> };
  url: string;
  name: string;
  disabled: boolean;
  onSave(update: SharedViewUpdate): void;
  onCopy(code: string): void;
}) {
  const { t } = useLingui();
  const { enabled, sites } = link.settings.embed;
  const [draft, setDraft] = useState<string | null>(null);
  const [problem, setProblem] = useState('');
  const section = useRef<HTMLDivElement>(null);
  const text = draft ?? sites.join('\n');
  const code = embedCode(url, name);

  function saveSites() {
    const lines = text
      .split(/[\n,]/)
      .map((line) => line.trim())
      .filter(Boolean);
    const bad = lines.find((line) => embedSite(line) === null);
    if (bad !== undefined) {
      setProblem(t({ id: 'shareView.siteInvalid', message: `This isn’t a web address: ${bad}` }));
      return;
    }
    const parsed = [...new Set(lines.map((line) => embedSite(line)!))];
    if (parsed.length > SHARED_VIEW_LIMITS.sites) {
      const most = SHARED_VIEW_LIMITS.sites;
      setProblem(t({ id: 'shareView.siteLimit', message: `List at most ${most} sites.` }));
      return;
    }
    setProblem('');
    setDraft(null);
    // A saved list is no longer a draft, and a button with nothing to save is disabled, which
    // would drop the focus out of the dialog and leave Escape with nothing to close.  It stays in
    // the list just saved.
    section.current?.querySelector<HTMLTextAreaElement>('textarea')?.focus();
    onSave({ embed: { enabled, sites: parsed } });
  }

  return (
    <div className="rio-share-view__section" ref={section}>
      <Switch
        isSelected={enabled}
        isDisabled={disabled}
        onChange={(on) => onSave({ embed: { enabled: on, sites } })}
      >
        {t({ id: 'shareView.embedOn', message: 'Allow embedding on other sites' })}
      </Switch>
      {enabled && (
        <>
          <TextArea
            label={t({ id: 'shareView.sites', message: 'Sites that may embed it' })}
            description={t({
              id: 'shareView.sitesHelp',
              message: 'One exact origin per line, including https://.  An empty list allows only this site.',
            })}
            rows={3}
            value={text}
            onChange={(value) => {
              setDraft(value);
              setProblem('');
            }}
            isInvalid={Boolean(problem)}
            errorMessage={problem}
          />
          <Button
            className="rio-share-view__start"
            isDisabled={disabled || draft === null}
            onPress={saveSites}
          >
            {t({ id: 'shareView.sitesSave', message: 'Save sites' })}
          </Button>
          <div className="rio-share-view__copy">
            <TextArea
              label={t({ id: 'shareView.embedCode', message: 'Embed code' })}
              rows={3}
              value={code}
              isReadOnly
            />
            <Button
              onPress={() => onCopy(code)}
              aria-label={t({ id: 'shareView.copyEmbed', message: 'Copy embed code' })}
              icon={faCopy}
            />
          </div>
        </>
      )}
    </div>
  );
}
