import { useState } from 'react';
import { useLingui } from '@lingui/react/macro';
import {
  describeTemplate,
  FieldOptions,
  type AutomationMeta,
  type ScriptMeta,
  LIMITS,
  resolveTemplate,
  templateScheme,
  type FieldMeta,
  type FieldOptionsOf,
} from '@riosoma/contracts';
import { Checkbox, ListBoxItem, Select, TextField } from '@riosoma/ui';

/** Why a link template can't be saved, or null when it can. */
export function buttonTemplateProblem(
  template: string,
  fields: readonly FieldMeta[],
  fieldId?: string,
): { kind: 'scheme' } | { kind: 'unknown'; name: string } | null {
  if (!templateScheme(template)) return { kind: 'scheme' };
  const resolved = resolveTemplate(
    template,
    fields.filter((field) => field.id !== fieldId),
  );
  return 'unknown' in resolved ? { kind: 'unknown', name: resolved.unknown } : null;
}

/**
 * A button's label and link.  The link shows field names in braces, which the server stores as
 * field IDs, so renaming a field never breaks a button.
 */
export function ButtonOptions({
  options,
  fields,
  fieldId,
  automations = [],
  scripts = [],
  onChange,
}: {
  options: unknown;
  fields: readonly FieldMeta[];
  fieldId?: string;
  automations?: readonly AutomationMeta[];
  scripts?: readonly ScriptMeta[];
  onChange: (options: FieldOptionsOf<'button'>) => void;
}) {
  const { t } = useLingui();
  const button = FieldOptions.button.parse(options ?? {});
  const others = fields.filter((field) => field.id !== fieldId && field.type !== 'button');
  const [template, setTemplate] = useState(() =>
    describeTemplate(button.action.kind === 'openUrl' ? button.action.urlTemplate : '', fields),
  );
  const problem = buttonTemplateProblem(template, fields, fieldId);
  const example = 'https://example.com/orders/{Order ID}';
  const name = problem?.kind === 'unknown' ? problem.name : '';

  function changeTemplate(next: string) {
    setTemplate(next);
    onChange({ ...button, action: { kind: 'openUrl', urlTemplate: next } });
  }

  return (
    <>
      <TextField
        label={t({ id: 'fields.button.label', message: 'Button label' })}
        description={t({ id: 'fields.button.labelHelp', message: 'Leave it empty to use the field’s name.' })}
        value={button.label}
        maxLength={LIMITS.buttonLabelLength}
        onChange={(label) => onChange({ ...button, label })}
      />
      <Select
        label={t({ id: 'fields.button.action', message: 'Action' })}
        selectedKey={button.action.kind}
        onSelectionChange={(key) => {
          if (key === 'openUrl') changeTemplate(template);
          if (key === 'runAutomation' && automations[0])
            onChange({ ...button, action: { kind: 'runAutomation', automationId: automations[0].id } });
          if (key === 'runScript' && scripts[0])
            onChange({ ...button, action: { kind: 'runScript', scriptId: scripts[0].id } });
        }}
      >
        <ListBoxItem id="openUrl">{t({ id: 'fields.button.openUrl', message: 'Open a link' })}</ListBoxItem>
        <ListBoxItem id="runAutomation" isDisabled={!automations.length}>
          {t({ id: 'fields.button.runAutomation', message: 'Run an automation' })}
        </ListBoxItem>
        <ListBoxItem id="runScript" isDisabled={!scripts.length}>
          {t({ id: 'fields.button.runScript', message: 'Run a script' })}
        </ListBoxItem>
      </Select>
      {button.action.kind === 'runAutomation' && (
        <Checkbox
          isSelected={button.action.allowConditionalTriggers ?? false}
          onChange={(allowConditionalTriggers) => {
            if (button.action.kind === 'runAutomation')
              onChange({ ...button, action: { ...button.action, allowConditionalTriggers } });
          }}
        >
          {t({
            id: 'fields.button.conditionalTriggers',
            message: 'Allow matching records and recorded form submissions',
          })}
        </Checkbox>
      )}
      {button.action.kind === 'openUrl' ? (
        <>
          <TextField
            label={t({ id: 'fields.button.link', message: 'Link' })}
            description={t({
              id: 'fields.button.linkHelp',
              message: `Put a field’s name in braces to use its value, like ${example}.  The link opens in a new tab.`,
            })}
            value={template}
            maxLength={LIMITS.urlTemplateLength}
            isInvalid={problem !== null}
            validationBehavior="aria"
            errorMessage={
              problem?.kind === 'unknown'
                ? t({
                    id: 'fields.button.unknownField',
                    message: `There’s no field named ${name} in this table.`,
                  })
                : t({
                    id: 'fields.button.scheme',
                    message: 'Start the link with http:// or https://, or with a field that holds one.',
                  })
            }
            onChange={changeTemplate}
          />
          <Select
            label={t({ id: 'fields.button.addField', message: 'Add a field to the link' })}
            selectedKey={null}
            isDisabled={others.length === 0}
            onSelectionChange={(key) => {
              const field = others.find((other) => other.id === key);
              if (field) changeTemplate(`${template}{${field.name}}`);
            }}
          >
            {others.map((field) => (
              <ListBoxItem key={field.id} id={field.id}>
                {field.name}
              </ListBoxItem>
            ))}
          </Select>
        </>
      ) : (
        <Select
          label={t({ id: 'fields.button.target', message: 'Run' })}
          selectedKey={
            button.action.kind === 'runAutomation' ? button.action.automationId : button.action.scriptId
          }
          onSelectionChange={(key) => {
            if (!key) return;
            onChange({
              ...button,
              action:
                button.action.kind === 'runAutomation'
                  ? { kind: 'runAutomation', automationId: String(key) }
                  : { kind: 'runScript', scriptId: String(key) },
            });
          }}
        >
          {(button.action.kind === 'runAutomation' ? automations : scripts).map((item) => (
            <ListBoxItem id={item.id} key={item.id}>
              {item.name}
            </ListBoxItem>
          ))}
        </Select>
      )}
    </>
  );
}
