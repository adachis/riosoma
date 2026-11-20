import { faEllipsis, faGear, faPlus } from '@fortawesome/free-solid-svg-icons';
import { Trans, useLingui } from '@lingui/react/macro';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import type { TableMeta, WebhookCreated, WebhookList, WebhookMeta } from '@riosoma/contracts';
import {
  Button,
  ConfirmDialog,
  Dialog,
  DialogBody,
  DialogTitle,
  Menu,
  MenuItem,
  MenuTrigger,
  Modal,
  Spinner,
  Switch,
} from '@riosoma/ui';
import { useServerMessage } from '../../../messages/useServerMessage';
import { useRelativeTime } from '../../../relative-time';
import { ErrorBanner } from '../../../shell/ErrorBanner';
import { errorInfo } from '../../setup/useSetup';
import { deleteWebhook, listWebhooks, replaceSecret, updateWebhook, webhooksKey } from './api';
import { Deliveries } from './Deliveries';
import { useEventLabels } from './labels';
import { SecretReveal } from './SecretReveal';
import { WebhookForm } from './WebhookForm';
import { useLevel } from '../../../levels/context';
import { anchor } from '../../../demos/anchors';
import './webhooks.css';

/** The database header's menu for its settings, offered to people who can change its schema. */
export function DatabaseSettingsMenu({
  databaseId,
  onWebhooks,
  onMemories,
  onKnowledge,
  onSimilar,
  onImportReport,
  platformReport,
  onSnapshots,
  onDuplicate,
  onSaveTemplate,
  onTheme,
}: {
  /** The database whose settings these are, so the menu can tell whether it has webhooks */
  databaseId: string;
  onWebhooks(): void;
  onMemories?: () => void;
  onKnowledge?: () => void;
  onSimilar?: () => void;
  /** Opens the report of the Airtable import that made the database, when one did */
  onImportReport?: () => void;
  /** The report of the import from another tool that made the database, when one did */
  platformReport?: { label: string; open(): void };
  /** Opens the database's snapshots */
  onSnapshots?: () => void;
  /** Duplicates the database as a new one */
  onDuplicate?: () => void;
  /** Saves the database as a template for the organization, for its admins */
  onSaveTemplate?: () => void;
  /** Opens the theme everyone sees in the database, for its owner */
  onTheme?: () => void;
}) {
  const { t } = useLingui();
  // Webhooks are Advanced.  Below it a database that has some keeps them in this menu, and the
  // palette always has them.
  const { offers, tidies } = useLevel();
  const existing = useQuery({
    queryKey: webhooksKey(databaseId),
    queryFn: ({ signal }) => listWebhooks(databaseId, signal),
    enabled: tidies('webhooks'),
  });
  const held = { webhooks: existing.data?.webhooks.length ?? 0 };
  const label = t({ id: 'webhooks.menu', message: 'Database settings' });
  return (
    <MenuTrigger>
      <Button variant="quiet" icon={faGear} aria-label={label} primaryAction {...anchor('database.menu')} />
      <Menu aria-label={label}>
        {onKnowledge && (
          <MenuItem id="knowledge" onAction={onKnowledge}>
            {t({ id: 'libraries.database', message: 'Database knowledge' })}
          </MenuItem>
        )}
        {onMemories && (
          <MenuItem id="memories" onAction={onMemories}>
            {t({ id: 'knowledge.databaseMemories', message: 'Database memories' })}
          </MenuItem>
        )}
        {onSimilar && (
          <MenuItem id="similar" onAction={onSimilar}>
            {t({ id: 'knowledge.similar', message: 'Find similar records' })}
          </MenuItem>
        )}
        {onTheme ? (
          <MenuItem id="theme" {...anchor('database.menu.theme')} onAction={onTheme}>
            {t({ id: 'databaseTheme.menu', message: 'Database theme' })}
          </MenuItem>
        ) : null}
        {onSnapshots ? (
          <MenuItem id="snapshots" {...anchor('database.menu.snapshots')} onAction={onSnapshots}>
            {t({ id: 'archives.snapshots.title', message: 'Snapshots' })}
          </MenuItem>
        ) : null}
        {onDuplicate ? (
          <MenuItem id="duplicate" onAction={onDuplicate}>
            {t({ id: 'archives.duplicate.menu', message: 'Duplicate database' })}
          </MenuItem>
        ) : null}
        {onSaveTemplate ? (
          <MenuItem id="saveTemplate" onAction={onSaveTemplate}>
            {t({ id: 'archives.template.title', message: 'Save as a template' })}
          </MenuItem>
        ) : null}
        {offers('databaseMenu', 'webhooks', held) ? (
          <MenuItem id="webhooks" onAction={onWebhooks}>
            {t({ id: 'webhooks.title', message: 'Webhooks' })}
          </MenuItem>
        ) : null}
        {onImportReport ? (
          <MenuItem id="airtableReport" onAction={onImportReport}>
            {t({ id: 'import.airtable.reportTitle', message: 'Airtable import report' })}
          </MenuItem>
        ) : null}
        {platformReport ? (
          <MenuItem id="platformReport" onAction={platformReport.open}>
            {platformReport.label}
          </MenuItem>
        ) : null}
      </Menu>
    </MenuTrigger>
  );
}

type View =
  | { kind: 'list' }
  | { kind: 'add' }
  | { kind: 'edit'; webhook: WebhookMeta }
  | { kind: 'secret'; secret: string; previousExpiresAt?: string }
  | { kind: 'deliveries'; webhookId: string };

/** The list keeps metadata only, so a secret the server answered with never lands in a cache. */
function withoutSecret(created: WebhookCreated): WebhookMeta {
  const { secret: _secret, ...meta } = created;
  return meta;
}

function WebhookItem({
  webhook,
  tables,
  toggling,
  onToggle,
  onDeliveries,
  onEdit,
  onReplaceSecret,
  onDelete,
}: {
  webhook: WebhookMeta;
  tables: readonly TableMeta[];
  toggling: boolean;
  onToggle(enabled: boolean): void;
  onDeliveries(): void;
  onEdit(): void;
  onReplaceSecret(): void;
  onDelete(): void;
}) {
  const { t, i18n } = useLingui();
  const labels = useEventLabels();
  const message = useServerMessage();
  const since = useRelativeTime(webhook.failingSince ?? webhook.lastSuccessAt ?? webhook.createdAt);
  const list = (items: string[]) => new Intl.ListFormat(i18n.locale, { type: 'conjunction' }).format(items);
  const names = new Map(tables.map((table) => [table.id, table.name]));
  const url = webhook.url;
  const menu = t({ id: 'webhooks.actions', message: `More for ${url}` });
  return (
    <li className="rio-webhooks__item" data-enabled={webhook.enabled}>
      <div className="rio-webhooks__head">
        {/* The switch is named by the address, the one thing that tells webhooks apart. */}
        <Switch
          className="rio-webhooks__switch"
          isSelected={webhook.enabled}
          isDisabled={toggling}
          onChange={onToggle}
        >
          {url}
        </Switch>
        <MenuTrigger>
          <Button variant="quiet" size="sm" icon={faEllipsis} aria-label={menu} />
          <Menu aria-label={menu}>
            <MenuItem id="edit" onAction={onEdit}>
              {t({ id: 'webhooks.edit', message: 'Edit' })}
            </MenuItem>
            <MenuItem id="secret" onAction={onReplaceSecret}>
              {t({ id: 'webhooks.secret.new', message: 'New secret' })}
            </MenuItem>
            <MenuItem id="delete" tone="danger" onAction={onDelete}>
              {t({ id: 'webhooks.delete', message: 'Delete' })}
            </MenuItem>
          </Menu>
        </MenuTrigger>
      </div>
      <dl className="rio-webhooks__facts">
        <div>
          <dt>
            <Trans id="webhooks.events">Events</Trans>
          </dt>
          <dd>{list(webhook.events.map((event) => labels[event]))}</dd>
        </div>
        <div>
          <dt>
            <Trans id="webhooks.tables">Tables</Trans>
          </dt>
          <dd>
            {webhook.tableIds ? (
              // A table deleted since keeps its ID, which still says which one it was.
              list(webhook.tableIds.map((id) => names.get(id) ?? id))
            ) : (
              <Trans id="webhooks.tables.all">All tables</Trans>
            )}
          </dd>
        </div>
      </dl>
      {!webhook.enabled && webhook.disabledReason ? (
        <p className="rio-webhooks__status" data-tone="warning">
          {message(webhook.disabledReason)}
        </p>
      ) : webhook.failingSince ? (
        <p className="rio-webhooks__status" data-tone="danger">
          {t({ id: 'webhooks.status.failing', message: `Deliveries started failing ${since}` })}
        </p>
      ) : webhook.lastSuccessAt ? (
        <p className="rio-webhooks__status">
          {t({ id: 'webhooks.status.delivered', message: `Last delivered ${since}` })}
        </p>
      ) : null}
      <div>
        <Button size="sm" onPress={onDeliveries}>
          <Trans id="webhooks.deliveries.title">Deliveries</Trans>
        </Button>
      </div>
    </li>
  );
}

export interface WebhooksDialogProps {
  databaseId: string;
  /** The database's tables, for choosing which ones a webhook hears about */
  tables: readonly TableMeta[];
  onClose(): void;
}

/**
 * A database's webhooks: the list, adding and changing them, turning them on and off, their
 * secrets, and their recent deliveries.  Everything happens in this one dialog, one view at a time.
 */
export function WebhooksDialog({ databaseId, tables, onClose }: WebhooksDialogProps) {
  const { t } = useLingui();
  const queryClient = useQueryClient();
  const key = webhooksKey(databaseId);
  const [view, setView] = useState<View>({ kind: 'list' });
  const [deleting, setDeleting] = useState<WebhookMeta | null>(null);
  const [replacing, setReplacing] = useState<WebhookMeta | null>(null);
  const webhooks = useQuery({ queryKey: key, queryFn: ({ signal }) => listWebhooks(databaseId, signal) });
  const store = (webhook: WebhookMeta) =>
    queryClient.setQueryData<WebhookList>(key, (current) => ({
      webhooks: current?.webhooks.some((item) => item.id === webhook.id)
        ? current.webhooks.map((item) => (item.id === webhook.id ? webhook : item))
        : [...(current?.webhooks ?? []), webhook],
    }));
  const toggle = useMutation({
    mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) =>
      updateWebhook(databaseId, id, { enabled }),
    onSuccess: store,
  });
  const remove = useMutation({
    mutationFn: (id: string) => deleteWebhook(databaseId, id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: key }),
  });
  const replace = useMutation({
    mutationFn: (id: string) => replaceSecret(databaseId, id),
    onSuccess: (answer) =>
      setView({ kind: 'secret', secret: answer.secret, previousExpiresAt: answer.previousExpiresAt }),
  });
  const listed = webhooks.data?.webhooks ?? [];
  const showing = view.kind === 'deliveries' ? listed.find((item) => item.id === view.webhookId) : undefined;
  // A webhook deleted while its deliveries were open leaves the list showing instead.
  const current: View['kind'] = view.kind === 'deliveries' && !showing ? 'list' : view.kind;
  const back = () => setView({ kind: 'list' });

  const titles: Record<View['kind'], string> = {
    list: t({ id: 'webhooks.title', message: 'Webhooks' }),
    add: t({ id: 'webhooks.add.title', message: 'Add a webhook' }),
    edit: t({ id: 'webhooks.edit.title', message: 'Edit webhook' }),
    secret: t({ id: 'webhooks.secret.title', message: 'Copy the signing secret' }),
    deliveries: t({ id: 'webhooks.deliveries.title', message: 'Deliveries' }),
  };
  const add = (
    <Button
      variant="primary"
      onPress={() => setView({ kind: 'add' })}
      aria-label={t({ id: 'webhooks.add', message: 'Add webhook' })}
      icon={faPlus}
    />
  );
  const deletingUrl = deleting?.url ?? '';

  return (
    <>
      <Modal
        isOpen
        isDismissable
        onOpenChange={(open) => {
          if (!open) onClose();
        }}
        size="lg"
      >
        <Dialog>
          <DialogTitle>{titles[current]}</DialogTitle>
          {view.kind === 'add' || view.kind === 'edit' ? (
            <WebhookForm
              key={view.kind === 'edit' ? view.webhook.id : 'new'}
              databaseId={databaseId}
              tables={tables}
              {...(view.kind === 'edit' ? { webhook: view.webhook } : {})}
              onCancel={back}
              onCreated={(created) => {
                store(withoutSecret(created));
                setView({ kind: 'secret', secret: created.secret });
              }}
              onSaved={(webhook) => {
                store(webhook);
                back();
              }}
            />
          ) : view.kind === 'secret' ? (
            <SecretReveal
              secret={view.secret}
              {...(view.previousExpiresAt ? { previousExpiresAt: view.previousExpiresAt } : {})}
              onDone={back}
            />
          ) : view.kind === 'deliveries' && showing ? (
            <Deliveries databaseId={databaseId} webhook={showing} onBack={back} />
          ) : (
            <DialogBody className="rio-webhooks">
              <p className="rio-webhooks__intro">
                <Trans id="webhooks.intro">
                  {
                    'Webhooks tell other apps when something changes in this database.  Each call names what changed, not the values, so the app reads what it needs through the API.'
                  }
                </Trans>
              </p>
              <ErrorBanner error={errorInfo(webhooks.error ?? toggle.error)} />
              {webhooks.isPending ? (
                <Spinner label={t({ id: 'webhooks.loading', message: 'Loading webhooks' })} />
              ) : listed.length === 0 ? (
                <div className="rio-webhooks__empty">
                  <p>
                    <Trans id="webhooks.empty">No webhooks yet.</Trans>
                  </p>
                  {webhooks.isError ? null : add}
                </div>
              ) : (
                <>
                  <div className="rio-webhooks__actions">{add}</div>
                  <ul className="rio-webhooks__list">
                    {listed.map((webhook) => (
                      <WebhookItem
                        key={webhook.id}
                        webhook={webhook}
                        tables={tables}
                        toggling={toggle.isPending && toggle.variables?.id === webhook.id}
                        onToggle={(enabled) => {
                          toggle.reset();
                          toggle.mutate({ id: webhook.id, enabled });
                        }}
                        onDeliveries={() => setView({ kind: 'deliveries', webhookId: webhook.id })}
                        onEdit={() => setView({ kind: 'edit', webhook })}
                        onReplaceSecret={() => {
                          replace.reset();
                          setReplacing(webhook);
                        }}
                        onDelete={() => {
                          remove.reset();
                          setDeleting(webhook);
                        }}
                      />
                    ))}
                  </ul>
                </>
              )}
            </DialogBody>
          )}
        </Dialog>
      </Modal>
      {deleting ? (
        <ConfirmDialog
          isOpen
          tone="danger"
          title={t({ id: 'webhooks.delete.title', message: 'Delete this webhook?' })}
          message={
            <>
              <Trans id="webhooks.delete.body">Riosoma stops sending to {deletingUrl} at once.</Trans>
              <ErrorBanner error={errorInfo(remove.error)} />
            </>
          }
          confirmLabel={t({ id: 'webhooks.delete', message: 'Delete' })}
          onOpenChange={(open) => {
            if (!open) setDeleting(null);
          }}
          onConfirm={() => remove.mutateAsync(deleting.id)}
        />
      ) : null}
      {replacing ? (
        <ConfirmDialog
          isOpen
          title={t({ id: 'webhooks.secret.confirm.title', message: 'Make a new secret?' })}
          message={
            <>
              <Trans id="webhooks.secret.confirm.body">
                The current secret keeps working for 24 hours, so you have time to update the receiver.
              </Trans>
              <ErrorBanner error={errorInfo(replace.error)} />
            </>
          }
          confirmLabel={t({ id: 'webhooks.secret.confirm', message: 'Make new secret' })}
          onOpenChange={(open) => {
            if (!open) setReplacing(null);
          }}
          onConfirm={() => replace.mutateAsync(replacing.id)}
        />
      ) : null}
    </>
  );
}
