import { faXmark, faPlus } from '@fortawesome/free-solid-svg-icons';
import { triggerTableId } from './model';
import { useState } from 'react';
import { useLingui } from '@lingui/react/macro';
import type { AutomationConfig, AutomationStep } from '@riosoma/contracts';
import { connectionAncestors, flattenAutomationSteps } from '@riosoma/contracts';
import { Button, ListBoxItem, Select, TextField } from '@riosoma/ui';
import type { DatabaseSession, SchemaState } from '../../../data/types';
import { FilterEditor } from '../view/FilterEditor';
import { TemplateInput, type TokenCatalog } from './TemplateInput';

export function ActionFields({
  step,
  config,
  schema,
  session,
  readOnly,
  catalog,
  onChange,
}: {
  step: AutomationStep;
  config: AutomationConfig;
  schema: SchemaState;
  session: DatabaseSession;
  readOnly: boolean;
  catalog: TokenCatalog;
  onChange(step: AutomationStep): void;
}) {
  const { t } = useLingui();
  const [placeholder, setPlaceholder] = useState('');
  const input = (label: string, value: string, change: (value: string) => void, multiline = false) => (
    <TemplateInput
      label={label}
      value={value}
      onChange={change}
      multiline={multiline}
      catalog={catalog}
      readOnly={readOnly}
    />
  );
  const table = 'tableId' in step ? step.tableId : null;
  const tablePicker = table ? (
    <Select
      label={t({ id: 'automations.trigger.table', message: 'Table' })}
      selectedKey={table}
      isDisabled={readOnly}
      onSelectionChange={(id) => {
        if (id !== null && (step.kind === 'findRecords' || step.kind === 'generateDocument'))
          onChange(
            step.kind === 'findRecords'
              ? { ...step, tableId: String(id), filter: null }
              : { ...step, tableId: String(id), templateFieldId: '', attachmentFieldId: '' },
          );
      }}
    >
      {schema.tables.map((item) => (
        <ListBoxItem key={item.id} id={item.id}>
          {item.name}
        </ListBoxItem>
      ))}
    </Select>
  ) : null;
  if (step.kind === 'findRecords')
    return (
      <>
        {tablePicker}
        <FilterEditor
          fields={schema.fields.get(step.tableId) ?? []}
          session={session}
          collaborators={schema.collaborators}
          primaryFieldId={schema.tableById.get(step.tableId)?.primaryFieldId}
          value={step.filter}
          readOnly={readOnly}
          onChange={(filter) => onChange({ ...step, filter })}
        />
        <TextField
          label={t({ id: 'automations.find.limit', message: 'Maximum records' })}
          type="number"
          value={String(step.limit)}
          isReadOnly={readOnly}
          onChange={(text) => {
            const limit = Number(text);
            if (Number.isInteger(limit) && limit >= 1 && limit <= 100) onChange({ ...step, limit });
          }}
        />
        <p>
          {t({
            id: 'automations.find.help',
            message:
              'Results contain only records and fields the run owner can read.  Use Records from this step in a later loop.',
          })}
        </p>
      </>
    );
  if (step.kind === 'createCalendarEvent')
    return (
      <>
        <Select
          label={t({ id: 'automations.calendar.account', message: 'Calendar account' })}
          selectedKey={step.provider}
          isDisabled={readOnly}
          onSelectionChange={(provider) => {
            if (provider === 'google-calendar' || provider === 'microsoft-calendar')
              onChange({ ...step, provider });
          }}
        >
          <ListBoxItem id="google-calendar">
            {t({ id: 'connections.googleCalendar', message: 'Google Calendar' })}
          </ListBoxItem>
          <ListBoxItem id="microsoft-calendar">
            {t({ id: 'connections.microsoftCalendar', message: 'Microsoft 365 Calendar' })}
          </ListBoxItem>
        </Select>
        <a href="/settings/connected-accounts">
          {t({ id: 'automations.calendar.connect', message: 'Manage connected accounts' })}
        </a>
        <TextField
          label={t({
            id: 'automations.calendar.id',
            message: 'Calendar ID (blank for the primary calendar)',
          })}
          value={step.calendarId}
          isReadOnly={readOnly}
          onChange={(calendarId) => onChange({ ...step, calendarId })}
        />
        {input(t({ id: 'automations.calendar.title', message: 'Event title' }), step.title, (title) =>
          onChange({ ...step, title }),
        )}
        {input(
          t({ id: 'automations.calendar.description', message: 'Description' }),
          step.description,
          (description) => onChange({ ...step, description }),
          true,
        )}
        {input(t({ id: 'automations.calendar.start', message: 'Start date and time' }), step.start, (start) =>
          onChange({ ...step, start }),
        )}
        {input(t({ id: 'automations.calendar.end', message: 'End date and time' }), step.end, (end) =>
          onChange({ ...step, end }),
        )}
        <TextField
          label={t({ id: 'automations.calendar.zone', message: 'Event time zone' })}
          value={step.timeZone}
          isReadOnly={readOnly}
          onChange={(timeZone) => onChange({ ...step, timeZone })}
        />
        <p>
          {t({
            id: 'automations.calendar.help',
            message:
              'Use ISO dates with an offset.  Events use the run owner’s connected account.  A test creates a real event, and the simulator sends nothing.',
          })}
        </p>
      </>
    );
  if (step.kind === 'askAi')
    return (
      <>
        {input(
          t({ id: 'automations.ask.promptLabel', message: 'Prompt' }),
          step.prompt,
          (prompt) => onChange({ ...step, prompt }),
          true,
        )}
        <Select
          label={t({ id: 'automations.ask.format', message: 'Answer format' })}
          selectedKey={step.format}
          isDisabled={readOnly}
          onSelectionChange={(format) => {
            if (format === 'text' || format === 'json') onChange({ ...step, format });
          }}
        >
          <ListBoxItem id="text">{t({ id: 'automations.ask.text', message: 'Text' })}</ListBoxItem>
          <ListBoxItem id="json">{t({ id: 'automations.ask.json', message: 'JSON' })}</ListBoxItem>
        </Select>
        <Select
          label={t({ id: 'automations.ask.tier', message: 'Model tier' })}
          selectedKey={step.tier}
          isDisabled={readOnly}
          onSelectionChange={(tier) => {
            if (tier === 'everyday' || tier === 'power') onChange({ ...step, tier });
          }}
        >
          <ListBoxItem id="everyday">
            {t({ id: 'automations.ask.everyday', message: 'Everyday' })}
          </ListBoxItem>
          <ListBoxItem id="power">{t({ id: 'automations.ask.power', message: 'Power' })}</ListBoxItem>
        </Select>
        <Select
          label={t({ id: 'automations.ask.classification', message: 'Data classification' })}
          selectedKey={step.classification}
          isDisabled={readOnly}
          onSelectionChange={(classification) => {
            if (
              classification === 'public' ||
              classification === 'internal' ||
              classification === 'confidential' ||
              classification === 'restricted'
            )
              onChange({ ...step, classification });
          }}
        >
          <ListBoxItem id="public">{t({ id: 'automations.ask.public', message: 'Public' })}</ListBoxItem>
          <ListBoxItem id="internal">
            {t({ id: 'automations.ask.internal', message: 'Internal' })}
          </ListBoxItem>
          <ListBoxItem id="confidential">
            {t({ id: 'automations.ask.confidential', message: 'Confidential' })}
          </ListBoxItem>
          <ListBoxItem id="restricted">
            {t({ id: 'automations.ask.restricted', message: 'Restricted' })}
          </ListBoxItem>
        </Select>
        <p>
          {t({
            id: 'automations.ask.help',
            message:
              'Data classification is self-declared.  Choose the highest classification of the values in the prompt.  Organization rules check that label, without detecting sensitive content.  Review generated answers before using them in sending steps.  Runs record token use, cost, and footprint.  Simulation uses an empty stand-in answer.',
          })}
        </p>
      </>
    );
  if (step.kind !== 'generateDocument') return null;
  const sourceTable = triggerTableId(config.trigger, schema);
  const steps = config.connections ? flattenAutomationSteps(config.steps) : config.steps;
  const ancestors = config.connections ? connectionAncestors(config, step.id) : null;
  const fields = (schema.fields.get(step.tableId) ?? []).filter((field) => field.type === 'attachment');
  const fieldPicker = (key: 'templateFieldId' | 'attachmentFieldId', label: string) => (
    <Select
      label={label}
      selectedKey={step[key] || null}
      isDisabled={readOnly}
      onSelectionChange={(id) => {
        if (id !== null) onChange({ ...step, [key]: String(id) });
      }}
    >
      {fields.map((field) => (
        <ListBoxItem id={field.id} key={field.id}>
          {field.name}
        </ListBoxItem>
      ))}
    </Select>
  );
  return (
    <>
      {step.record === 'item' ? tablePicker : null}
      <Select
        label={t({ id: 'automations.step.record', message: 'Record' })}
        selectedKey={step.record}
        isDisabled={readOnly}
        onSelectionChange={(record) => {
          if (record !== null) {
            const selected = steps.find((item) => item.id === record && item.kind === 'createRecord');
            const tableId =
              record === 'trigger'
                ? sourceTable
                : selected && 'tableId' in selected
                  ? selected.tableId
                  : step.tableId;
            onChange({ ...step, record: String(record), tableId: tableId ?? step.tableId });
          }
        }}
      >
        <ListBoxItem id="trigger">
          {t({ id: 'automations.step.triggerRecord', message: 'The record that started it' })}
        </ListBoxItem>
        {(catalog.groups.some((group) => group.id === 'loop') || step.record === 'item') && (
          <ListBoxItem id="item">{t({ id: 'automations.loop.item', message: 'Current item' })}</ListBoxItem>
        )}
        {steps
          .filter(
            (item) =>
              item.kind === 'createRecord' &&
              (!ancestors || ancestors.has(item.id) || item.id === step.record),
          )
          .map((item) => (
            <ListBoxItem
              id={item.id}
              key={item.id}
              isDisabled={ancestors !== null && !ancestors.has(item.id)}
            >
              {item.name || item.id}
            </ListBoxItem>
          ))}
      </Select>
      {fieldPicker(
        'templateFieldId',
        t({ id: 'automations.document.source', message: 'Template attachment field' }),
      )}
      {fieldPicker(
        'attachmentFieldId',
        t({ id: 'automations.document.target', message: 'Save to attachment field' }),
      )}
      <Select
        label={t({ id: 'automations.document.format', message: 'Document format' })}
        selectedKey={step.format}
        isDisabled={readOnly}
        onSelectionChange={(format) => {
          if (format === 'docx' || format === 'pdf' || format === 'xlsx') onChange({ ...step, format });
        }}
      >
        <ListBoxItem id="docx">{t({ id: 'automations.document.word', message: 'Word' })}</ListBoxItem>
        <ListBoxItem id="pdf">{t({ id: 'automations.document.pdf', message: 'PDF' })}</ListBoxItem>
        <ListBoxItem id="xlsx">{t({ id: 'automations.document.excel', message: 'Excel' })}</ListBoxItem>
      </Select>
      {input(t({ id: 'automations.document.filename', message: 'File name' }), step.filename, (filename) =>
        onChange({ ...step, filename }),
      )}
      {Object.entries(step.values).map(([key, value]) => (
        <div key={key}>
          {input(key, value, (next) => onChange({ ...step, values: { ...step.values, [key]: next } }))}
          {!readOnly && (
            <Button
              variant="quiet"
              onPress={() => {
                const values = { ...step.values };
                delete values[key];
                onChange({ ...step, values });
              }}
              aria-label={t({ id: 'automations.document.remove', message: 'Remove placeholder' })}
              icon={faXmark}
            />
          )}
        </div>
      ))}
      {!readOnly && (
        <>
          <TextField
            label={t({ id: 'automations.document.placeholder', message: 'Placeholder name' })}
            value={placeholder}
            onChange={setPlaceholder}
            onKeyDown={(event) => {
              if (event.key === 'Enter') event.preventDefault();
            }}
          />
          <Button
            isDisabled={
              !placeholder.trim() ||
              placeholder.length > 100 ||
              Object.hasOwn(step.values, placeholder.trim())
            }
            onPress={() => {
              onChange({ ...step, values: { ...step.values, [placeholder.trim()]: '' } });
              setPlaceholder('');
            }}
            aria-label={t({ id: 'automations.document.add', message: 'Add placeholder' })}
            icon={faPlus}
          />
        </>
      )}
      <p>
        {t({
          id: 'automations.document.help',
          message:
            'Use the first matching template in the source field.  Word and Excel use named placeholders in double braces.  PDF uses form field names.  The generated file is added without removing existing attachments.',
        })}
      </p>
    </>
  );
}
