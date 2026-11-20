import { faCopy } from '@fortawesome/free-solid-svg-icons';
import { plural } from '@lingui/core/macro';
import { useLingui } from '@lingui/react/macro';
import type { AutomationConfig, AutomationMeta, AutomationTrigger, FilterGroup } from '@riosoma/contracts';
import {
  Button,
  Checkbox,
  CheckboxGroup,
  FilterableList,
  ComboBox,
  ListBoxItem,
  NumberField,
  Select,
  TextField,
  toast,
} from '@riosoma/ui';
import { useId, useState } from 'react';
import type { DatabaseSession, SchemaState } from '../../../data/types';
import { FilterEditor } from '../view/FilterEditor';
import { Card } from './Card';
import { TRIGGER_ICONS, TRIGGER_LABELS } from './labels';
import { useLevel } from '../../../levels/context';
import { featureAt } from '../../../levels/features';
import { useFeatureCommands } from '../../../levels/palette';
import { formViews, TRIGGER_KINDS, triggerOfKind, type ScheduleTrigger } from './model';
import type { Problem } from './problems';

/** The contract's limit on watched fields */
const MAX_WATCHED = 50;
const NO_VIEW = '#none';
const UNITS = ['hour', 'day', 'week'] as const;

type RecordTrigger = Extract<AutomationTrigger, { tableId: string }>;

export interface TriggerCardProps {
  session: DatabaseSession;
  schema: SchemaState;
  automation: AutomationMeta;
  config: AutomationConfig;
  problems: ReadonlySet<Problem>;
  readOnly: boolean;
  fallbackTableId: string;
  onChange(config: AutomationConfig): void;
}

export function TriggerCard({
  session,
  schema,
  automation,
  config,
  problems,
  readOnly,
  fallbackTableId,
  onChange,
}: TriggerCardProps) {
  const { t, i18n } = useLingui();
  const { trigger } = config;
  const forms = formViews(schema);
  const set = (next: AutomationTrigger) => onChange({ ...config, trigger: next });
  const when = t({ id: 'automations.trigger', message: 'When' });
  const { offers } = useLevel();
  // Webhook triggers are Advanced.  The automation's own trigger always shows, whatever its kind,
  // and a kind any automation in the database starts from stays on offer at every level.
  const kinds = TRIGGER_KINDS.filter((kind) => kind === trigger.kind || offers('triggerPicker', kind));
  // Every registered trigger is in the palette whatever the level.
  useFeatureCommands(
    `automation.${automation.id}.trigger`,
    readOnly
      ? []
      : TRIGGER_KINDS.filter((kind) => featureAt('triggerPicker', kind)).map((kind) => ({
          place: `triggerPicker:${kind}` as const,
          run: () => {
            if (kind !== config.trigger.kind)
              set(triggerOfKind(kind, config.trigger, schema, fallbackTableId));
          },
        })),
  );
  return (
    <Card title={when} problems={problems}>
      <Select
        aria-label={when}
        selectedKey={trigger.kind}
        isDisabled={readOnly}
        disabledKeys={forms.length ? [] : ['formSubmitted']}
        onSelectionChange={(key) => {
          const kind = kinds.find((item) => item === key);
          if (kind && kind !== trigger.kind) set(triggerOfKind(kind, trigger, schema, fallbackTableId));
        }}
      >
        {kinds.map((kind) => (
          <ListBoxItem key={kind} id={kind} icon={TRIGGER_ICONS[kind]}>
            {i18n._(TRIGGER_LABELS[kind])}
          </ListBoxItem>
        ))}
      </Select>
      {'tableId' in trigger ? (
        <RecordTriggerSettings
          session={session}
          schema={schema}
          trigger={trigger}
          readOnly={readOnly}
          onChange={set}
        />
      ) : null}
      {trigger.kind === 'formSubmitted' ? (
        <Select
          label={t({ id: 'automations.trigger.form', message: 'Form' })}
          selectedKey={trigger.viewId}
          isDisabled={readOnly}
          onSelectionChange={(key) => {
            if (key !== null) set({ kind: 'formSubmitted', viewId: String(key) });
          }}
        >
          {forms.map((view) => (
            <ListBoxItem
              key={view.id}
              id={view.id}
              textValue={view.name}
              description={schema.tableById.get(view.tableId)?.name}
            >
              {view.name}
            </ListBoxItem>
          ))}
        </Select>
      ) : null}
      {trigger.kind === 'schedule' ? (
        <ScheduleSettings trigger={trigger} readOnly={readOnly} onChange={set} />
      ) : null}
      {trigger.kind === 'webhook' ? <WebhookAddress automation={automation} /> : null}
    </Card>
  );
}

function RecordTriggerSettings({
  session,
  schema,
  trigger,
  readOnly,
  onChange,
}: {
  session: DatabaseSession;
  schema: SchemaState;
  trigger: RecordTrigger;
  readOnly: boolean;
  onChange(trigger: AutomationTrigger): void;
}) {
  const { t } = useLingui();
  const fields = schema.fields.get(trigger.tableId) ?? [];
  const table = schema.tableById.get(trigger.tableId);
  const setTable = (tableId: string) => {
    switch (trigger.kind) {
      case 'recordCreated':
        return onChange({ kind: 'recordCreated', tableId });
      case 'recordUpdated':
        return onChange({ kind: 'recordUpdated', tableId, fieldIds: [] });
      case 'recordMatches':
        return onChange({ kind: 'recordMatches', tableId, viewId: null, filter: null });
    }
  };
  const deleted = t({ id: 'automations.token.missing', message: 'A deleted field' });
  return (
    <>
      <Select
        label={t({ id: 'automations.trigger.table', message: 'Table' })}
        selectedKey={table ? trigger.tableId : null}
        isDisabled={readOnly}
        onSelectionChange={(key) => {
          if (key !== null && key !== trigger.tableId) setTable(String(key));
        }}
      >
        {schema.tables.map((item) => (
          <ListBoxItem key={item.id} id={item.id}>
            {item.name}
          </ListBoxItem>
        ))}
      </Select>
      {trigger.kind === 'recordUpdated' ? (
        fields.length > 10 ? (
          <FilterableList
            listId={`automation.fields:${trigger.tableId}`}
            label={t({ id: 'automations.trigger.fields', message: 'When these fields change' })}
            description={
              trigger.fieldIds.length
                ? undefined
                : t({ id: 'automations.trigger.anyField', message: 'Any field' })
            }
            items={[
              ...fields.map((field) => ({
                id: field.id,
                name: field.name,
                isDisabled: !trigger.fieldIds.includes(field.id) && trigger.fieldIds.length >= MAX_WATCHED,
              })),
              ...trigger.fieldIds
                .filter((id) => !fields.some((field) => field.id === id))
                .map((id) => ({ id, name: deleted })),
            ]}
            selectedKeys={trigger.fieldIds}
            selectionMode="multiple"
            isDisabled={readOnly}
            onSelectionChange={(keys) => onChange({ ...trigger, fieldIds: [...keys].map(String) })}
          />
        ) : (
          <CheckboxGroup
            label={t({ id: 'automations.trigger.fields', message: 'When these fields change' })}
            description={
              trigger.fieldIds.length
                ? undefined
                : t({ id: 'automations.trigger.anyField', message: 'Any field' })
            }
            orientation="horizontal"
            value={trigger.fieldIds}
            isDisabled={readOnly}
            onChange={(fieldIds) => onChange({ ...trigger, fieldIds })}
          >
            {fields.map((field) => (
              <Checkbox
                key={field.id}
                value={field.id}
                isDisabled={!trigger.fieldIds.includes(field.id) && trigger.fieldIds.length >= MAX_WATCHED}
              >
                {field.name}
              </Checkbox>
            ))}
            {/* Fields deleted since stay listed, so they can be let go of. */}
            {trigger.fieldIds
              .filter((fieldId) => !fields.some((field) => field.id === fieldId))
              .map((fieldId) => (
                <Checkbox key={fieldId} value={fieldId}>
                  {deleted}
                </Checkbox>
              ))}
          </CheckboxGroup>
        )
      ) : null}
      {trigger.kind === 'recordMatches' ? (
        <>
          <Select
            label={t({ id: 'automations.trigger.view', message: 'View' })}
            selectedKey={
              trigger.viewId === null
                ? NO_VIEW
                : schema.viewById.get(trigger.viewId)?.tableId === trigger.tableId
                  ? trigger.viewId
                  : null
            }
            isDisabled={readOnly}
            onSelectionChange={(key) => {
              if (key !== null) onChange({ ...trigger, viewId: key === NO_VIEW ? null : String(key) });
            }}
          >
            {[
              <ListBoxItem key={NO_VIEW} id={NO_VIEW}>
                {t({ id: 'automations.trigger.noView', message: 'No view' })}
              </ListBoxItem>,
              ...(schema.views.get(trigger.tableId) ?? []).map((view) => (
                <ListBoxItem key={view.id} id={view.id}>
                  {view.name}
                </ListBoxItem>
              )),
            ]}
          </Select>
          <FilterEditor
            fields={fields}
            session={session}
            primaryFieldId={table?.primaryFieldId}
            collaborators={schema.collaborators}
            value={trigger.filter}
            readOnly={readOnly}
            onChange={(filter: FilterGroup | null) => onChange({ ...trigger, filter })}
          />
        </>
      ) : null}
    </>
  );
}

/** The unit's name for a number of them, without the number when the phrase starts or ends with it. */
function unitName(phrase: string, number: string): string {
  const escaped = number.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const stripped = phrase
    .replace(new RegExp(`^\\s*${escaped}\\s*`), '')
    .replace(new RegExp(`\\s*${escaped}\\s*$`), '');
  return stripped.trim() || phrase;
}

function ScheduleSettings({
  trigger,
  readOnly,
  onChange,
}: {
  trigger: ScheduleTrigger;
  readOnly: boolean;
  onChange(trigger: ScheduleTrigger): void;
}) {
  const { t, i18n } = useLingui();
  const everyId = useId();
  const [zones] = useState(() => Intl.supportedValuesOf('timeZone'));
  const { n, unit } = trigger.every;
  const number = i18n.number(n);
  const units = {
    hour: t({ id: 'automations.schedule.hour', message: plural(n, { one: 'hour', other: '# hours' }) }),
    day: t({ id: 'automations.schedule.day', message: plural(n, { one: 'day', other: '# days' }) }),
    week: t({ id: 'automations.schedule.week', message: plural(n, { one: 'week', other: '# weeks' }) }),
  };
  const clock = new Intl.DateTimeFormat(i18n.locale, { hour: 'numeric', minute: '2-digit', timeZone: 'UTC' });
  const times = Array.from({ length: 48 }, (_, index) =>
    [Math.floor(index / 2), index % 2 ? 30 : 0].map((part) => String(part).padStart(2, '0')).join(':'),
  );
  if (!times.includes(trigger.at)) times.push(trigger.at);
  times.sort();
  const time = (at: string) => {
    const [hours = 0, minutes = 0] = at.split(':').map(Number);
    return clock.format(Date.UTC(2024, 0, 1, hours, minutes));
  };
  const weekday = new Intl.DateTimeFormat(i18n.locale, { weekday: 'long', timeZone: 'UTC' });
  return (
    <>
      <div className="rio-automation-schedule" role="group" aria-labelledby={everyId}>
        <span id={everyId} className="rio-automation-schedule__label">
          {t({ id: 'automations.schedule.every', message: 'Every' })}
        </span>
        <div className="rio-automation-schedule__every">
          <NumberField
            aria-labelledby={everyId}
            value={n}
            minValue={1}
            maxValue={52}
            step={1}
            formatOptions={{ maximumFractionDigits: 0 }}
            isDisabled={readOnly}
            onChange={(value) => {
              if (Number.isInteger(value) && value >= 1 && value <= 52 && value !== n)
                onChange({ ...trigger, every: { unit, n: value } });
            }}
          />
          <Select
            aria-labelledby={everyId}
            selectedKey={unit}
            isDisabled={readOnly}
            onSelectionChange={(key) => {
              const next = UNITS.find((item) => item === key);
              if (next && next !== unit) onChange({ ...trigger, every: { unit: next, n } });
            }}
          >
            {UNITS.map((item) => (
              <ListBoxItem key={item} id={item}>
                {unitName(units[item], number)}
              </ListBoxItem>
            ))}
          </Select>
        </div>
      </div>
      {unit === 'hour' ? null : (
        <Select
          label={t({ id: 'automations.schedule.at', message: 'At' })}
          selectedKey={trigger.at}
          isDisabled={readOnly}
          onSelectionChange={(key) => {
            if (key !== null) onChange({ ...trigger, at: String(key) });
          }}
        >
          {times.map((at) => (
            <ListBoxItem key={at} id={at}>
              {time(at)}
            </ListBoxItem>
          ))}
        </Select>
      )}
      {unit === 'week' ? (
        <Select
          label={t({ id: 'automations.schedule.weekday', message: 'On' })}
          selectedKey={String(trigger.weekday)}
          isDisabled={readOnly}
          onSelectionChange={(key) => {
            const day = Number(key);
            if (Number.isInteger(day) && day >= 0 && day <= 6) onChange({ ...trigger, weekday: day });
          }}
        >
          {Array.from({ length: 7 }, (_, day) => (
            <ListBoxItem key={day} id={String(day)}>
              {/* The first of January 2023 was a Sunday, which the contract counts as day 0. */}
              {weekday.format(Date.UTC(2023, 0, 1 + day))}
            </ListBoxItem>
          ))}
        </Select>
      ) : null}
      <ComboBox
        label={t({ id: 'automations.schedule.timeZone', message: 'Time zone' })}
        selectedKey={trigger.timeZone}
        isDisabled={readOnly}
        onSelectionChange={(key) => {
          if (key !== null) onChange({ ...trigger, timeZone: String(key) });
        }}
      >
        {(zones.includes(trigger.timeZone) ? zones : [trigger.timeZone, ...zones]).map((zone) => (
          <ListBoxItem key={zone} id={zone} textValue={zone}>
            {zone}
          </ListBoxItem>
        ))}
      </ComboBox>
    </>
  );
}

function WebhookAddress({ automation }: { automation: AutomationMeta }) {
  const { t } = useLingui();
  const address = automation.webhookPath
    ? new URL(automation.webhookPath, window.location.origin).toString()
    : null;
  async function copy(text: string) {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      // The read-only field still lets the address be selected and copied by hand.
      return;
    }
    toast.show({
      tone: 'success',
      title: t({ id: 'automations.webhook.copied', message: 'Copied the address' }),
    });
  }
  return (
    <div className="rio-automation-webhook">
      {address ? (
        <div className="rio-automation-webhook__address">
          <TextField
            label={t({ id: 'automations.webhook.address', message: 'Webhook address' })}
            value={address}
            isReadOnly
          />
          <Button
            icon={faCopy}
            onPress={() => void copy(address)}
            aria-label={t({ id: 'automations.webhook.copy', message: 'Copy address' })}
          />
        </div>
      ) : null}
      <p className="rio-automation-webhook__note">
        {t({
          id: 'automations.webhook.note',
          message: 'Anything that sends JSON to this address starts the automation.  Keep it private.',
        })}
      </p>
    </div>
  );
}
