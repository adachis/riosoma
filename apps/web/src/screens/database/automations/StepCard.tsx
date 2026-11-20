import {
  faArrowDown,
  faArrowUp,
  faClone,
  faPlus,
  faTrashCan,
  faXmark,
} from '@fortawesome/free-solid-svg-icons';
import { useLingui } from '@lingui/react/macro';
import type { AutomationConfig, AutomationStep, AutomationRun } from '@riosoma/contracts';
import { connectionAncestors, flattenAutomationSteps } from '@riosoma/contracts';
import { Button, ListBoxItem, Menu, MenuItem, MenuTrigger, Select, TextField } from '@riosoma/ui';
import { useMemo, useState } from 'react';
import type { SchemaState } from '../../../data/types';
import { fieldTypeInfo } from '../fields/fieldTypes';
import { NotificationFields } from './NotificationFields';
import { Card } from './Card';
import { phoneCatalog, stepRecordLabel, tokenCatalog, triggerRecordLabel } from './catalog';
import { SmsPolicy } from './SmsPolicy';
import { ScriptField } from './ScriptField';
import { STEP_LABELS } from './labels';
import { triggerTableId, writableFields } from './model';
import type { Problem } from './problems';
import { ParsedTemplateInput, TemplateInput, type TokenCatalog } from './TemplateInput';
import { formatHeaders, joinList, parseHeaders, sameHeaders, sameList, splitList } from './tokens';

const METHODS = ['POST', 'PUT', 'PATCH'] as const;
/** The contract's limit on recipients */
const MAX_RECIPIENTS = 20;

type Step<K extends AutomationStep['kind']> = Extract<AutomationStep, { kind: K }>;

export interface StepCardProps {
  step: AutomationStep;
  availableSteps?: AutomationStep[];
  inLoop?: boolean;
  children?: React.ReactNode;
  index: number;
  config: AutomationConfig;
  schema: SchemaState;
  problems: ReadonlySet<Problem> | undefined;
  readOnly: boolean;
  canDuplicate: boolean;
  result?: AutomationRun['steps'][number];
  onTest?(): void;
  testing?: boolean;
  onChange(step: AutomationStep): void;
  onMove(offset: number): void;
  onDuplicate(): void;
  onDelete(): void;
}

export function StepCard({
  step,
  availableSteps = [],
  inLoop = false,
  children,
  index,
  config,
  schema,
  problems,
  readOnly,
  canDuplicate,
  result,
  onTest,
  testing,
  onChange,
  onMove,
  onDuplicate,
  onDelete,
}: StepCardProps) {
  const { t, i18n } = useLingui();
  const context = useMemo(
    () => (config.connections ? config : { ...config, steps: [...availableSteps, ...config.steps] }),
    [config, availableSteps],
  );
  const contextIndex = config.connections
    ? flattenAutomationSteps(context.steps).findIndex((entry) => entry.id === step.id)
    : availableSteps.length + index;
  const catalog = useMemo(
    () => tokenCatalog(context, contextIndex, schema, i18n, inLoop),
    [context, contextIndex, schema, i18n, inLoop],
  );
  const shared = { schema, readOnly, catalog };
  return (
    <Card
      title={i18n._(STEP_LABELS[step.kind])}
      number={(config.connections ? contextIndex : index) + 1}
      problems={problems}
      stepId={step.id}
      actions={
        readOnly ? null : (
          <>
            <Button
              variant="quiet"
              size="sm"
              icon={faArrowUp}
              aria-label={t({ id: 'automations.step.moveUp', message: 'Move up' })}
              isDisabled={index === 0}
              onPress={() => onMove(-1)}
            />
            <Button
              variant="quiet"
              size="sm"
              icon={faArrowDown}
              aria-label={t({ id: 'automations.step.moveDown', message: 'Move down' })}
              isDisabled={index === config.steps.length - 1}
              onPress={() => onMove(1)}
            />
            <Button
              variant="quiet"
              size="sm"
              icon={faClone}
              aria-label={t({ id: 'automations.step.duplicate', message: 'Duplicate' })}
              isDisabled={!canDuplicate}
              onPress={onDuplicate}
            />
            <Button
              variant="quiet"
              size="sm"
              icon={faTrashCan}
              aria-label={t({ id: 'automations.step.delete', message: 'Delete step' })}
              onPress={onDelete}
            />
          </>
        )
      }
    >
      {step.kind === 'script' ? (
        <>
          <ScriptField
            value={step.script}
            onChange={(script) => onChange({ ...step, script })}
            readOnly={readOnly}
            errorLine={result?.error?.line}
          />
          <ScriptInputs step={step} catalog={catalog} readOnly={readOnly} onChange={onChange} />
        </>
      ) : null}
      {step.kind === 'updateRecord' ? (
        <UpdateRecord
          inLoop={inLoop}
          {...shared}
          step={step}
          index={contextIndex}
          config={context}
          onChange={onChange}
        />
      ) : null}
      {step.kind === 'createRecord' ? <CreateRecord {...shared} step={step} onChange={onChange} /> : null}
      {step.kind === 'sendNotification' ? (
        <NotificationFields
          {...shared}
          step={step}
          triggerTable={triggerTableId(config.trigger, schema)}
          onChange={onChange}
        />
      ) : null}
      {step.kind === 'sendEmail' ? <SendEmail {...shared} step={step} onChange={onChange} /> : null}
      {step.kind === 'slack' ||
      step.kind === 'teams' ||
      step.kind === 'studioFlow' ||
      step.kind === 'discord' ||
      step.kind === 'sms' ? (
        <>
          <Messaging {...shared} step={step} onChange={onChange} />
        </>
      ) : null}
      {step.kind === 'callWebhook' ? <CallWebhook {...shared} step={step} onChange={onChange} /> : null}
      {children}
      {!readOnly && onTest ? (
        <Button isPending={testing} onPress={onTest}>
          {t({ id: 'automations.test.step', message: 'Test step' })}
        </Button>
      ) : null}
    </Card>
  );
}

interface SettingsProps<K extends AutomationStep['kind']> {
  step: Step<K>;
  schema: SchemaState;
  readOnly: boolean;
  catalog: TokenCatalog;
  onChange(step: Step<K>): void;
}

function UpdateRecord({
  inLoop,
  step,
  index,
  config,
  schema,
  readOnly,
  catalog,
  onChange,
}: SettingsProps<'updateRecord'> & { index: number; config: AutomationConfig; inLoop: boolean }) {
  const { t, i18n } = useLingui();
  const triggerTable = triggerTableId(config.trigger, schema);
  const sources: Array<{ id: string; label: string; tableId: string | null; disabled?: boolean }> = [];
  const ancestors = config.connections ? connectionAncestors(config, step.id) : null;
  if (inLoop || step.record === 'item')
    sources.push({
      id: 'item',
      label: t({ id: 'automations.loop.item', message: 'Current item' }),
      tableId: step.tableId,
    });
  if (triggerTable || step.record === 'trigger')
    sources.push({ id: 'trigger', label: triggerRecordLabel(i18n), tableId: triggerTable });
  const steps = config.connections ? flattenAutomationSteps(config.steps) : config.steps;
  steps.forEach((item, position) => {
    // A later step stays listed while it's chosen, so the card can say what's wrong with it.
    const available = ancestors ? ancestors.has(item.id) : position < index;
    if (item.kind === 'createRecord' && (available || item.id === step.record))
      sources.push({
        id: item.id,
        label: stepRecordLabel(i18n, position + 1),
        tableId: item.tableId,
        disabled: Boolean(ancestors) && !available,
      });
  });
  return (
    <>
      <Select
        label={t({ id: 'automations.step.record', message: 'Record' })}
        selectedKey={sources.some((source) => source.id === step.record) ? step.record : null}
        isDisabled={readOnly}
        onSelectionChange={(key) => {
          const source = sources.find((item) => item.id === key);
          if (source && source.id !== step.record)
            onChange({ ...step, record: source.id, tableId: source.tableId ?? step.tableId });
        }}
      >
        {sources.map((source) => (
          <ListBoxItem key={source.id} id={source.id} isDisabled={source.disabled}>
            {source.label}
          </ListBoxItem>
        ))}
      </Select>
      {step.record === 'item' ? (
        <Select
          label={t({ id: 'automations.trigger.table', message: 'Table' })}
          selectedKey={step.tableId}
          isDisabled={readOnly}
          onSelectionChange={(tableId) => {
            if (tableId !== null) onChange({ ...step, tableId: String(tableId), values: {} });
          }}
        >
          {schema.tables.map((table) => (
            <ListBoxItem key={table.id} id={table.id}>
              {table.name}
            </ListBoxItem>
          ))}
        </Select>
      ) : null}
      <RecordValues
        tableId={step.tableId}
        values={step.values}
        schema={schema}
        readOnly={readOnly}
        catalog={catalog}
        onChange={(values) => onChange({ ...step, values })}
      />
    </>
  );
}

function CreateRecord({ step, schema, readOnly, catalog, onChange }: SettingsProps<'createRecord'>) {
  const { t } = useLingui();
  return (
    <>
      <Select
        label={t({ id: 'automations.trigger.table', message: 'Table' })}
        selectedKey={schema.tableById.has(step.tableId) ? step.tableId : null}
        isDisabled={readOnly}
        onSelectionChange={(key) => {
          if (key !== null && key !== step.tableId) onChange({ ...step, tableId: String(key) });
        }}
      >
        {schema.tables.map((table) => (
          <ListBoxItem key={table.id} id={table.id}>
            {table.name}
          </ListBoxItem>
        ))}
      </Select>
      <RecordValues
        tableId={step.tableId}
        values={step.values}
        schema={schema}
        readOnly={readOnly}
        catalog={catalog}
        onChange={(values) => onChange({ ...step, values })}
      />
    </>
  );
}

/** The fields a step sets, each with the text to fill it with. */
function RecordValues({
  tableId,
  values,
  schema,
  readOnly,
  catalog,
  onChange,
}: {
  tableId: string;
  values: Readonly<Record<string, string>>;
  schema: SchemaState;
  readOnly: boolean;
  catalog: TokenCatalog;
  onChange(values: Record<string, string>): void;
}) {
  const { t, i18n } = useLingui();
  const [added, setAdded] = useState<string | null>(null);
  const unset = writableFields(schema, tableId).filter((field) => !(field.id in values));
  const setField = t({ id: 'automations.step.setField', message: 'Set a field' });
  return (
    <div className="rio-automation-values">
      {Object.entries(values).map(([fieldId, template]) => {
        const field = schema.fieldById.get(fieldId);
        const name = field?.name ?? t({ id: 'automations.token.missing', message: 'A deleted field' });
        return (
          <div key={fieldId} className="rio-automation-values__row">
            <TemplateInput
              label={name}
              value={template}
              catalog={catalog}
              readOnly={readOnly}
              multiline={field?.type === 'longText'}
              autoFocus={added === fieldId}
              onChange={(next) => onChange({ ...values, [fieldId]: next })}
            />
            {readOnly ? null : (
              <Button
                className="rio-automation-values__remove"
                variant="quiet"
                size="sm"
                icon={faXmark}
                aria-label={t({ id: 'automations.step.removeField', message: `Remove ${name}` })}
                onPress={() => {
                  const { [fieldId]: _removed, ...rest } = values;
                  onChange(rest);
                }}
              />
            )}
          </div>
        );
      })}
      {readOnly || !unset.length ? null : (
        <MenuTrigger>
          <Button className="rio-automation-values__add" variant="quiet" icon={faPlus}>
            {setField}
          </Button>
          <Menu
            aria-label={setField}
            onAction={(key) => {
              const fieldId = String(key);
              setAdded(fieldId);
              onChange({ ...values, [fieldId]: '' });
            }}
          >
            {unset.map((field) => {
              const info = fieldTypeInfo(field.type);
              return (
                <MenuItem
                  key={field.id}
                  id={field.id}
                  icon={info.icon}
                  textValue={field.name}
                  description={i18n._(info.name)}
                >
                  {field.name}
                </MenuItem>
              );
            })}
          </Menu>
        </MenuTrigger>
      )}
    </div>
  );
}

function SendEmail({ step, readOnly, catalog, onChange }: SettingsProps<'sendEmail'>) {
  const { t } = useLingui();
  return (
    <>
      <ParsedTemplateInput<string[]>
        label={t({ id: 'automations.step.to', message: 'To' })}
        value={step.to}
        format={joinList}
        parse={(text) => splitList(text).slice(0, MAX_RECIPIENTS)}
        same={sameList}
        catalog={catalog}
        readOnly={readOnly}
        onChange={(to) => onChange({ ...step, to })}
      />
      <TemplateInput
        label={t({ id: 'automations.step.subject', message: 'Subject' })}
        value={step.subject}
        catalog={catalog}
        readOnly={readOnly}
        onChange={(subject) => onChange({ ...step, subject })}
      />
      <TemplateInput
        label={t({ id: 'automations.step.body', message: 'Message' })}
        value={step.body}
        catalog={catalog}
        readOnly={readOnly}
        multiline
        onChange={(body) => onChange({ ...step, body })}
      />
    </>
  );
}

function CallWebhook({ step, readOnly, catalog, onChange }: SettingsProps<'callWebhook'>) {
  const { t } = useLingui();
  return (
    <>
      <TemplateInput
        label={t({ id: 'automations.step.url', message: 'Address' })}
        value={step.url}
        catalog={catalog}
        readOnly={readOnly}
        onChange={(url) => onChange({ ...step, url })}
      />
      <Select
        label={t({ id: 'automations.step.method', message: 'Method' })}
        selectedKey={step.method}
        isDisabled={readOnly}
        onSelectionChange={(key) => {
          const method = METHODS.find((item) => item === key);
          if (method) onChange({ ...step, method });
        }}
      >
        {METHODS.map((method) => (
          <ListBoxItem key={method} id={method}>
            {method}
          </ListBoxItem>
        ))}
      </Select>
      <ParsedTemplateInput<Record<string, string>>
        label={t({ id: 'automations.step.headers', message: 'Headers' })}
        value={step.headers}
        format={formatHeaders}
        parse={parseHeaders}
        same={sameHeaders}
        catalog={catalog}
        readOnly={readOnly}
        multiline
        monospace
        onChange={(headers) => onChange({ ...step, headers })}
      />
      <TemplateInput
        label={t({ id: 'automations.step.json', message: 'JSON body' })}
        value={step.body}
        catalog={catalog}
        readOnly={readOnly}
        multiline
        monospace
        onChange={(body) => onChange({ ...step, body })}
      />
    </>
  );
}

function ScriptInputs({ step, catalog, readOnly, onChange }: Omit<SettingsProps<'script'>, 'schema'>) {
  const { t } = useLingui();
  const [name, setName] = useState('');
  return (
    <>
      {Object.entries(step.input).map(([key, value]) => (
        <div key={key}>
          <TemplateInput
            label={key}
            value={value}
            catalog={catalog}
            readOnly={readOnly}
            onChange={(next) => onChange({ ...step, input: { ...step.input, [key]: next } })}
          />
          {!readOnly ? (
            <Button
              variant="quiet"
              onPress={() => {
                const input = { ...step.input };
                delete input[key];
                onChange({ ...step, input });
              }}
              aria-label={t({ id: 'automations.script.removeInput', message: 'Remove input' })}
              icon={faXmark}
            />
          ) : null}
        </div>
      ))}
      {!readOnly ? (
        <div>
          <label>
            {t({ id: 'automations.script.inputName', message: 'Input name' })}
            <input value={name} onChange={(event) => setName(event.target.value)} />
          </label>
          <Button
            isDisabled={!/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(name) || Object.hasOwn(step.input, name)}
            onPress={() => {
              onChange({ ...step, input: { ...step.input, [name]: '' } });
              setName('');
            }}
            aria-label={t({ id: 'automations.script.addInput', message: 'Add input' })}
            icon={faPlus}
          />
        </div>
      ) : null}
    </>
  );
}

function Messaging({
  step,
  schema,
  readOnly,
  catalog,
  onChange,
}: SettingsProps<'slack' | 'teams' | 'studioFlow' | 'discord' | 'sms'>) {
  const { t } = useLingui();
  const [replacing, setReplacing] = useState(false);
  const secret = step.kind === 'sms' ? step.authToken : step.webhookUrl;
  const saved = step.secretSaved && !secret && !replacing;
  const label =
    step.kind === 'sms'
      ? t({ id: 'automations.messaging.authToken', message: 'Auth token' })
      : t({ id: 'automations.messaging.webhookUrl', message: 'Incoming webhook address' });
  return (
    <>
      {step.kind === 'sms' ? (
        <>
          <SmsPolicy />
          <TextField
            label={t({ id: 'automations.messaging.accountSid', message: 'Account SID' })}
            value={step.accountSid}
            isReadOnly={readOnly}
            onChange={(accountSid) => onChange({ ...step, accountSid })}
          />
          <TextField
            label={t({ id: 'automations.messaging.from', message: 'Sending number' })}
            value={step.from}
            isReadOnly={readOnly}
            onChange={(from) => onChange({ ...step, from })}
          />
          <TemplateInput
            label={t({ id: 'automations.step.to', message: 'To' })}
            value={step.to}
            catalog={phoneCatalog(catalog, schema)}
            readOnly={readOnly}
            onChange={(to) => onChange({ ...step, to })}
          />
          <p>
            {t({
              id: 'automations.messaging.numbers',
              message:
                'Use E.164 numbers, starting with + and the country code.  The recipient can be a phone field token.',
            })}
          </p>
        </>
      ) : null}
      {saved ? (
        <div>
          <span>
            {label}: {t({ id: 'automations.messaging.saved', message: 'Saved' })}
          </span>
          {!readOnly ? (
            <Button variant="quiet" onPress={() => setReplacing(true)}>
              {t({ id: 'automations.messaging.replace', message: 'Replace' })}
            </Button>
          ) : null}
        </div>
      ) : (
        <TextField
          label={label}
          type="password"
          autoComplete="new-password"
          value={secret}
          isReadOnly={readOnly}
          onChange={(value) => {
            setReplacing(false);
            onChange(step.kind === 'sms' ? { ...step, authToken: value } : { ...step, webhookUrl: value });
          }}
        />
      )}
      {step.kind === 'studioFlow' ? (
        <div data-anchor="automations.step.studioFlow">
          <TemplateInput
            label={t({
              id: 'automations.studioFlow.recipient',
              message: 'Recipient email or channel reference',
            })}
            value={step.recipient}
            catalog={catalog}
            readOnly={readOnly}
            onChange={(recipient) => onChange({ ...step, recipient })}
          />
          <TemplateInput
            label={t({ id: 'automations.studioFlow.title', message: 'Title (optional)' })}
            value={step.title}
            catalog={catalog}
            readOnly={readOnly}
            onChange={(title) => onChange({ ...step, title })}
          />
          <TemplateInput
            label={t({ id: 'automations.studioFlow.recordUrl', message: 'Record link' })}
            value={step.recordUrl}
            catalog={catalog}
            readOnly={readOnly}
            onChange={(recordUrl) => onChange({ ...step, recordUrl })}
          />
          <p>
            {t({
              id: 'automations.studioFlow.help',
              message:
                'Use a Power Automate HTTP trigger that posts as your agent.  Channel references need routing in the flow.  Personal chats require the recipient to install the agent in Teams.',
            })}
          </p>
        </div>
      ) : null}
      <TemplateInput
        label={t({ id: 'automations.step.body', message: 'Message' })}
        value={step.body}
        catalog={catalog}
        readOnly={readOnly}
        multiline
        onChange={(body) => onChange({ ...step, body })}
      />
    </>
  );
}
