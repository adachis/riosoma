import { faXmark, faPlus } from '@fortawesome/free-solid-svg-icons';
import { ActionFields } from './ActionFields';
import { useLingui } from '@lingui/react/macro';
import type { AutomationConfig, AutomationStep } from '@riosoma/contracts';
import { Button, ListBoxItem, Select, SortableItem, SortableList, TextField, moveList } from '@riosoma/ui';
import type { DatabaseSession, SchemaState } from '../../../data/types';
import { FilterEditor } from '../view/FilterEditor';
import { newStepId, triggerTableId } from './model';
import { TemplateInput, type TokenCatalog } from './TemplateInput';

export function FlowFields({
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
  onChange(step: AutomationStep, options?: { immediate: boolean }): void;
}) {
  const { t } = useLingui();
  const itemToken = '{{item}}';
  const indexToken = '{{index}}';
  const tableId = triggerTableId(config.trigger, schema);
  const filter = step.kind === 'if' || (step.kind === 'wait' && step.mode === 'condition');
  return (
    <>
      <ActionFields
        step={step}
        config={config}
        schema={schema}
        session={session}
        readOnly={readOnly}
        catalog={catalog}
        onChange={onChange}
      />
      {filter ? (
        <FilterEditor
          fields={tableId ? (schema.fields.get(tableId) ?? []) : []}
          session={session}
          collaborators={schema.collaborators}
          primaryFieldId={tableId ? schema.tableById.get(tableId)?.primaryFieldId : undefined}
          value={step.conditions}
          readOnly={readOnly}
          onChange={(conditions) => onChange({ ...step, conditions })}
        />
      ) : null}
      {step.kind === 'switch' ? (
        <>
          <TemplateInput
            label={t({ id: 'automations.switch.value', message: 'Value to match' })}
            value={step.value}
            catalog={catalog}
            readOnly={readOnly}
            onChange={(value) => onChange({ ...step, value })}
          />
          <SortableList
            items={step.cases.map((path) => ({ id: path.id, name: path.value }))}
            disabledReason={
              readOnly
                ? t({
                    id: 'automations.steps.readOnly',
                    message: 'You need permission to arrange these steps.',
                  })
                : undefined
            }
            onMove={(from, to) =>
              onChange({ ...step, cases: [...moveList(step.cases, from, to)] }, { immediate: true })
            }
          >
            {step.cases.map((path) => (
              <SortableItem id={path.id} key={path.id} className="rio-automation-flow__case">
                <>
                  <TextField
                    label={t({ id: 'automations.switch.case', message: 'Path value' })}
                    value={path.value}
                    isReadOnly={readOnly}
                    onChange={(value) =>
                      onChange({
                        ...step,
                        cases: step.cases.map((item) => (item.id === path.id ? { ...item, value } : item)),
                      })
                    }
                  />
                  {!readOnly ? (
                    <Button
                      onPress={() =>
                        onChange({ ...step, cases: step.cases.filter((item) => item.id !== path.id) })
                      }
                      aria-label={t({ id: 'automations.switch.remove', message: 'Remove path' })}
                      icon={faXmark}
                    />
                  ) : null}
                </>
              </SortableItem>
            ))}
          </SortableList>
          {!readOnly ? (
            <Button
              isDisabled={step.cases.length >= 20}
              onPress={() =>
                onChange({
                  ...step,
                  cases: [
                    ...step.cases,
                    { id: newStepId(), value: String(step.cases.length + 1), steps: [] },
                  ],
                })
              }
              aria-label={t({ id: 'automations.switch.add', message: 'Add a path' })}
              icon={faPlus}
            />
          ) : null}
        </>
      ) : null}
      {step.kind === 'repeat' ? (
        <>
          <TemplateInput
            label={t({ id: 'automations.loop.listInput', message: 'List to repeat over' })}
            value={step.list}
            catalog={catalog}
            readOnly={readOnly}
            onChange={(list) => onChange({ ...step, list })}
          />
          <p>
            {t({
              id: 'automations.loop.help',
              message: `Choose a multi-value field or an earlier step’s array of records or values.  You can also enter a JSON array.  Inside this loop, use ${itemToken} and ${indexToken}.`,
            })}
          </p>
        </>
      ) : null}
      {step.kind === 'wait' ? (
        <>
          <Select
            label={t({ id: 'automations.wait.mode', message: 'Wait for' })}
            selectedKey={step.mode}
            isDisabled={readOnly}
            onSelectionChange={(mode) => {
              if (mode === 'duration' || mode === 'date' || mode === 'condition') onChange({ ...step, mode });
            }}
          >
            <ListBoxItem id="duration">
              {t({ id: 'automations.wait.duration', message: 'A duration' })}
            </ListBoxItem>
            <ListBoxItem id="date">
              {t({ id: 'automations.wait.untilDate', message: 'A date or time' })}
            </ListBoxItem>
            <ListBoxItem id="condition">
              {t({ id: 'automations.wait.untilCondition', message: 'A record condition' })}
            </ListBoxItem>
          </Select>
          {step.mode === 'date' ? (
            <TemplateInput
              label={t({ id: 'automations.wait.dateField', message: 'Date or time' })}
              value={step.date}
              catalog={catalog}
              readOnly={readOnly}
              onChange={(date) => onChange({ ...step, date })}
            />
          ) : (
            <TextField
              type="number"
              label={
                step.mode === 'duration'
                  ? t({ id: 'automations.wait.seconds', message: 'Duration in seconds' })
                  : t({ id: 'automations.wait.timeoutSeconds', message: 'Timeout in seconds' })
              }
              value={String(step.mode === 'duration' ? step.seconds : step.timeoutSeconds)}
              isReadOnly={readOnly}
              onChange={(value) =>
                onChange({
                  ...step,
                  [step.mode === 'duration' ? 'seconds' : 'timeoutSeconds']: Number(value),
                })
              }
            />
          )}
        </>
      ) : null}
    </>
  );
}
