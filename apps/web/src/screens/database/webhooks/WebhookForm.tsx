import { Trans, useLingui } from '@lingui/react/macro';
import { useMutation } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import {
  LIMITS,
  WEBHOOK_EVENTS,
  webhookUrlProblem,
  type TableMeta,
  type WebhookCreated,
  type WebhookEventType,
  type WebhookMeta,
} from '@riosoma/contracts';
import {
  Button,
  Checkbox,
  CheckboxGroup,
  DialogBody,
  DialogFooter,
  Form,
  Radio,
  RadioGroup,
  TextField,
} from '@riosoma/ui';
import { useServerMessage } from '../../../messages/useServerMessage';
import { ErrorBanner } from '../../../shell/ErrorBanner';
import { errorInfo } from '../../setup/useSetup';
import { createWebhook, updateWebhook } from './api';
import { useEventLabels } from './labels';

/** Which tables a webhook hears about: all of them, or a list picked here. */
type Reach = 'all' | 'chosen';

const isEvent = (value: string): value is WebhookEventType =>
  (WEBHOOK_EVENTS as readonly string[]).includes(value);

/** A new webhook starts with the record events, which is what most receivers want. */
const STARTING_EVENTS: WebhookEventType[] = ['record.created', 'record.updated', 'record.deleted'];

export interface WebhookFormProps {
  databaseId: string;
  tables: readonly TableMeta[];
  /** The webhook to change, or none for a new one */
  webhook?: WebhookMeta;
  onCancel(): void;
  onCreated(created: WebhookCreated): void;
  onSaved(webhook: WebhookMeta): void;
}

/** The address, events, and tables of a webhook, for adding one or changing it. */
export function WebhookForm({ databaseId, tables, webhook, onCancel, onCreated, onSaved }: WebhookFormProps) {
  const { t } = useLingui();
  const labels = useEventLabels();
  const message = useServerMessage();
  const fields = useRef<HTMLDivElement>(null);
  const [url, setUrl] = useState(webhook?.url ?? '');
  const [events, setEvents] = useState<WebhookEventType[]>(webhook?.events ?? STARTING_EVENTS);
  const [reach, setReach] = useState<Reach>(webhook?.tableIds ? 'chosen' : 'all');
  // A table deleted since the webhook was saved can't be chosen again.
  const [chosen, setChosen] = useState<string[]>(
    (webhook?.tableIds ?? []).filter((id) => tables.some((table) => table.id === id)),
  );
  // Complaints wait for the first submit, so the form doesn't open already red.
  const [attempted, setAttempted] = useState(false);
  const save = useMutation({
    mutationFn: async (body: { url: string; events: WebhookEventType[]; tableIds: string[] | null }) => {
      if (webhook) onSaved(await updateWebhook(databaseId, webhook.id, body));
      else onCreated(await createWebhook(databaseId, { ...body, enabled: true }));
    },
  });
  const pending = save.isPending;
  const problem = url.trim() ? webhookUrlProblem(url) : 'invalid';
  const missingTables = reach === 'chosen' && chosen.length === 0;

  // The address is what someone types first, so the field waits for them instead of the dialog.
  useEffect(() => {
    const frame = requestAnimationFrame(() => fields.current?.querySelector('input')?.focus());
    return () => cancelAnimationFrame(frame);
  }, []);

  function submit() {
    setAttempted(true);
    if (problem || events.length === 0 || missingTables || pending) return;
    save.mutate({ url: url.trim(), events, tableIds: reach === 'all' ? null : chosen });
  }

  return (
    <Form
      className="rio-webhooks__form"
      validationBehavior="aria"
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <DialogBody>
        <div className="rio-webhooks__fields" ref={fields}>
          <TextField
            label={t({ id: 'webhooks.url', message: 'Address' })}
            description={t({
              id: 'webhooks.url.description',
              message: 'Riosoma posts each change here.  It has to start with https://.',
            })}
            placeholder={t({ id: 'webhooks.url.placeholder', message: 'https://example.com/hooks' })}
            type="url"
            value={url}
            onChange={setUrl}
            maxLength={LIMITS.urlLength}
            isRequired
            isDisabled={pending}
            isInvalid={attempted && problem !== null}
            errorMessage={problem ? message(`webhooks.url.${problem}`) : undefined}
          />
          <CheckboxGroup
            label={t({ id: 'webhooks.events', message: 'Events' })}
            value={events}
            onChange={(values) => setEvents(values.filter(isEvent))}
            isDisabled={pending}
            validationBehavior="aria"
            isInvalid={attempted && events.length === 0}
            errorMessage={t({ id: 'webhooks.error.events', message: 'Choose at least one event.' })}
          >
            {WEBHOOK_EVENTS.map((event) => (
              <Checkbox key={event} value={event}>
                {labels[event]}
              </Checkbox>
            ))}
          </CheckboxGroup>
          <RadioGroup
            label={t({ id: 'webhooks.tables', message: 'Tables' })}
            value={reach}
            onChange={(key) => setReach(key === 'chosen' ? 'chosen' : 'all')}
            isDisabled={pending}
          >
            <Radio value="all">
              <Trans id="webhooks.tables.allLabel">All tables, including new ones</Trans>
            </Radio>
            <Radio value="chosen">
              <Trans id="webhooks.tables.chosen">Only these tables</Trans>
            </Radio>
          </RadioGroup>
          {reach === 'chosen' ? (
            <div className="rio-webhooks__pick">
              <CheckboxGroup
                aria-label={t({ id: 'webhooks.tables.chosen', message: 'Only these tables' })}
                value={chosen}
                onChange={setChosen}
                isDisabled={pending}
                validationBehavior="aria"
                isInvalid={attempted && missingTables}
                errorMessage={t({ id: 'webhooks.error.tables', message: 'Choose at least one table.' })}
              >
                {tables.map((table) => (
                  <Checkbox key={table.id} value={table.id}>
                    {table.name}
                  </Checkbox>
                ))}
              </CheckboxGroup>
            </div>
          ) : null}
          <ErrorBanner error={errorInfo(save.error)} />
        </div>
      </DialogBody>
      <DialogFooter>
        <Button onPress={onCancel} isDisabled={pending}>
          <Trans id="webhooks.cancel">Cancel</Trans>
        </Button>
        <Button type="submit" variant="primary" isPending={pending}>
          {webhook ? <Trans id="webhooks.save">Save</Trans> : <Trans id="webhooks.add">Add webhook</Trans>}
        </Button>
      </DialogFooter>
    </Form>
  );
}
