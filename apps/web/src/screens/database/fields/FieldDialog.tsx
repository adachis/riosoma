import { joinedSources } from '@riosoma/contracts';
import { HelpDialogTitle } from '../../../docs/HelpDialogTitle';
import { needsFieldConversion } from '@riosoma/contracts';
import { faPlus } from '@fortawesome/free-solid-svg-icons';
import { plural } from '@lingui/core/macro';
import { useEffect, useRef, useState } from 'react';
import { useLingui } from '@lingui/react/macro';
import {
  defaultIssue,
  describeTemplate,
  FIELD_TYPES,
  fieldDefault,
  FieldSpec,
  isAiOutputType,
  keptDefault,
  LIMITS,
  liveAllowsType,
  PRIMARY_FIELD_TYPES,
  readsSourceLive,
  withDefault,
  type AiFieldSettingsInput,
  type ConversionPreview,
  type FieldMeta,
  type FieldType,
} from '@riosoma/contracts';
import {
  Banner,
  Button,
  Dialog,
  DialogBody,
  DialogFooter,
  Disclosure,
  DisclosurePanel,
  DisclosureTrigger,
  Modal,
  TextArea,
  TextField,
} from '@riosoma/ui';
import { duplicateChoiceNames } from './ChoicesEditor';
import { FieldOptionsForm } from './FieldOptionsForm';
import { FieldTypePicker } from './FieldTypePicker';
import { AI_FIELD_INFO, fieldTypeInfo } from './fieldTypes';
import { AiFieldOptions, aiPromptProblem } from './AiFieldOptions';
import { useServerMessage } from '../../../messages/useServerMessage';
import type { SchemaState } from '../../../data';
import { checkFormula } from '../../../data/formulas';
import { initialSpec, relationalSpec, rollupFunctions } from './RelationalOptions';
import { buttonTemplateProblem } from './ButtonOptions';
import { anchor } from '../../../demos/anchors';
import { useLinkedFieldSchema } from './useLinkedFieldSchema';
import './FieldDialog.css';

export interface FieldDialogProps {
  mode: 'create' | 'edit';
  schema?: SchemaState;
  tableId?: string;
  initial?: FieldMeta;
  isPrimary?: boolean;
  existingNames: readonly string[];
  conversion?: ConversionPreview | null;
  onTypeChange?: (spec: FieldSpec) => void;
  /** `ai` holds an AI field's settings, or null when an AI field becomes an ordinary one */
  onSubmit: (result: {
    name: string;
    description: string;
    spec: FieldSpec;
    ai?: AiFieldSettingsInput | null;
  }) => void;
  onDuplicate?: () => void;
  onCancel: () => void;
  isSaving: boolean;
  /** Already localized by the caller. */
  error?: string;
  duplicates?: { values: string[]; href: string };
  /** Why AI fields can't run in the organization, as a server message key, or null when they can */
  aiUnavailable?: string | null;
  /** The type a new field starts as, or an AI field, when something asked for one kind, such as the palette */
  initialType?: FieldType | 'ai';
}

function normalized(name: string): string {
  return name.trim().toLowerCase();
}

function cleanSpec(spec: FieldSpec): FieldSpec {
  if (spec.type !== 'singleSelect' && spec.type !== 'multipleSelect') return spec;
  return {
    ...spec,
    options: {
      ...spec.options,
      choices: spec.options.source
        ? []
        : spec.options.choices
            .filter(({ name }) => name.trim() !== '')
            .map((choice) => ({ ...choice, name: choice.name.trim() })),
    },
  };
}

function relatedTypes(before: FieldType, after: FieldType): boolean {
  const dates: readonly FieldType[] = ['date', 'createdTime', 'lastModifiedTime'];
  const selects: readonly FieldType[] = ['singleSelect', 'multipleSelect'];
  return (
    (dates.includes(before) && dates.includes(after)) || (selects.includes(before) && selects.includes(after))
  );
}

/** Mount one dialog per editing session; the caller owns dismissal and persistence. */
export function FieldDialog({
  mode,
  schema: sourceSchema,
  initial,
  tableId = initial?.tableId,
  isPrimary,
  existingNames,
  conversion,
  onTypeChange,
  onSubmit,
  onCancel,
  onDuplicate,
  isSaving,
  error,
  duplicates,
  aiUnavailable,
  initialType,
}: FieldDialogProps) {
  const { i18n, t } = useLingui();
  const message = useServerMessage();
  const tableFields = sourceSchema?.fields.get(tableId ?? '') ?? [];
  const startType = mode === 'create' && !initial ? initialType : undefined;
  // An AI field starts writing text, as choosing it from the type menu does.
  const startsAi = startType === 'ai';
  const [ai, setAi] = useState<AiFieldSettingsInput | null>(() =>
    initial?.ai
      ? {
          prompt: describeTemplate(initial.ai.prompt, sourceSchema?.fields.get(tableId ?? '') ?? []),
          tier: initial.ai.tier,
          trigger: initial.ai.trigger,
        }
      : startsAi
        ? { prompt: '', tier: 'fast', trigger: 'referencedChange' }
        : null,
  );
  const [name, setName] = useState(
    () =>
      initial?.name ??
      (startType
        ? freeName(i18n._((startType === 'ai' ? AI_FIELD_INFO : fieldTypeInfo(startType)).name))
        : ''),
  );
  const [nameTyped, setNameTyped] = useState(Boolean(initial?.name));
  const [description, setDescription] = useState(initial?.description ?? '');
  const [spec, setSpec] = useState<FieldSpec>(() =>
    initial
      ? FieldSpec.parse(cleanSpec(initial))
      : startType && startType !== 'ai'
        ? initialSpec(startType, sourceSchema, tableId)
        : FieldSpec.parse({ type: 'text' }),
  );
  const { schema, error: linkedError } = useLinkedFieldSchema(sourceSchema, spec);
  const [attempted, setAttempted] = useState(false);
  const formRef = useRef<HTMLFormElement>(null);
  useEffect(() => {
    // Focus after the modal portal is attached; an input can mount while it is still detached.
    formRef.current?.querySelector<HTMLInputElement>('input')?.focus();
  }, []);
  const taken = existingNames.map(normalized);
  if (mode === 'edit' && initial) {
    const ownIndex = taken.indexOf(normalized(initial.name));
    if (ownIndex !== -1) taken.splice(ownIndex, 1);
  }
  const nameError = !name.trim()
    ? t({ id: 'field.dialog.nameRequired', message: 'Enter a name.' })
    : taken.includes(normalized(name))
      ? t({ id: 'field.dialog.nameTaken', message: 'Another field already has this name.' })
      : undefined;
  const hasDuplicateChoices =
    (spec.type === 'singleSelect' || spec.type === 'multipleSelect') &&
    !spec.options.source &&
    duplicateChoiceNames(spec.options.choices).size > 0;
  const formula =
    spec.type === 'formula'
      ? checkFormula(
          spec.options.expression,
          schema ? [...schema.fieldById.values()] : [],
          initial?.id,
          schema?.tables,
          tableId,
          schema?.namedFunctions,
        )
      : undefined;
  // AI fields and the fields of synced and joined tables take no default.
  const parentTable = schema?.tableById.get(tableId ?? '');
  const noDefault = ai !== null || Boolean(parentTable?.source || parentTable?.joined);
  const invalidOptions =
    !FieldSpec.safeParse(cleanSpec(spec)).success ||
    (!noDefault && defaultIssue(cleanSpec(spec)) !== null) ||
    (ai !== null && aiPromptProblem(ai.prompt, tableFields, initial?.id) !== null) ||
    Boolean(formula && 'error' in formula) ||
    (spec.type === 'button' &&
      spec.options.action.kind === 'openUrl' &&
      buttonTemplateProblem(
        spec.options.action.urlTemplate,
        schema?.fields.get(tableId ?? '') ?? [],
        initial?.id,
      ) !== null) ||
    (spec.type === 'rollup' &&
      !rollupFunctions(schema?.fieldById.get(spec.options.targetFieldId)).includes(spec.options.fn));
  const live = readsSourceLive(schema?.tableById.get(tableId ?? '')?.source);
  const typeChanged = mode === 'edit' && initial !== undefined && needsFieldConversion(initial, spec);
  const preview = typeChanged ? conversion : null;

  function changeSpec(next: FieldSpec) {
    setSpec(next);
    if (
      mode === 'edit' &&
      initial &&
      (needsFieldConversion(initial, next) || needsFieldConversion(initial, spec))
    ) {
      const valid = FieldSpec.safeParse(cleanSpec(next));
      if (
        valid.success &&
        !(
          (next.type === 'singleSelect' || next.type === 'multipleSelect') &&
          !next.options.source &&
          duplicateChoiceNames(next.options.choices).size
        )
      )
        onTypeChange?.(valid.data);
    }
  }

  function chooseType(type: FieldType, keepAi = false) {
    if (!keepAi) setAi(null);
    if (type === spec.type || (isPrimary && !(PRIMARY_FIELD_TYPES as readonly FieldType[]).includes(type))) {
      if (!keepAi && ai) suggestName(i18n._(fieldTypeInfo(type).name));
      return;
    }
    const initialized = relatedTypes(spec.type, type)
      ? ({ type, options: spec.options } as FieldSpec)
      : mode === 'edit' && initial?.type === type
        ? FieldSpec.parse(cleanSpec(initial))
        : initialSpec(type, schema, tableId, initial?.id);
    const next = keptDefault(initialized, fieldDefault(spec) ?? fieldDefault(initialized));
    changeSpec(next);
    if (!keepAi) suggestName(i18n._(fieldTypeInfo(type).name));
  }

  /** Makes the field an AI field, writing text unless its type is already one a model can write. */
  function chooseAi() {
    if (ai) return;
    if (!isAiOutputType(spec.type)) chooseType('text', true);
    setAi({ prompt: '', tier: 'fast', trigger: 'referencedChange' });
    suggestName(i18n._(AI_FIELD_INFO.name));
  }

  /** The name, or the name with the first number that makes it one no other field has. */
  function freeName(base: string): string {
    const names = existingNames.map(normalized);
    let suggestion = base;
    let suffix = 2;
    while (names.includes(normalized(suggestion))) {
      const name = base;
      const number = suffix++;
      suggestion = t({ id: 'field.dialog.numberedName', message: `${name} ${number}` });
    }
    return suggestion;
  }

  function suggestName(base: string) {
    if (mode === 'create' && !nameTyped) setName(freeName(base));
  }

  const total = preview?.total ?? 0;
  const emptied = preview?.emptied ?? 0;
  const count = preview?.newChoices.length ?? 0;
  const examples =
    preview?.samples
      .map((sample) => (typeof sample === 'string' ? sample : (JSON.stringify(sample) ?? String(sample))))
      .join(', ') ?? '';
  return (
    <Modal
      isOpen
      isDismissable={!isSaving}
      isKeyboardDismissDisabled={isSaving}
      onOpenChange={(open) => {
        if (!open && !isSaving) onCancel();
      }}
      className="rio-field-dialog"
    >
      <Dialog hideCloseButton>
        <HelpDialogTitle moduleId="fields" section="adding-and-editing-fields" anchorId="field.editor">
          {mode === 'create'
            ? t({ id: 'field.dialog.createTitle', message: 'New field' })
            : t({ id: 'field.dialog.editTitle', message: 'Edit field' })}
        </HelpDialogTitle>
        <form
          ref={formRef}
          className="rio-field-dialog__form"
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            setAttempted(true);
            if (isSaving || nameError || hasDuplicateChoices || invalidOptions || preview?.tooManyChoices)
              return;
            const saved =
              spec.type === 'formula' && formula && 'ast' in formula
                ? {
                    ...spec,
                    options: { ...spec.options, expression: formula.expression, resultType: formula.type },
                  }
                : spec;
            const result = FieldSpec.safeParse(cleanSpec(relationalSpec(saved, schema)));
            if (result.success)
              onSubmit({
                name: name.trim(),
                description,
                spec: noDefault ? withDefault(result.data, undefined) : result.data,
                ...(ai && isAiOutputType(result.data.type)
                  ? { ai: { ...ai, prompt: ai.prompt.trim() } }
                  : initial?.ai
                    ? { ai: null }
                    : {}),
              });
          }}
        >
          <DialogBody>
            {linkedError && <p role="alert">{message(linkedError)}</p>}
            <div className="rio-field-dialog__fields">
              <TextField
                {...anchor('field.name')}
                label={t({ id: 'field.dialog.name', message: 'Name' })}
                value={name}
                autoFocus
                maxLength={LIMITS.nameLength}
                isRequired
                validationBehavior="aria"
                isInvalid={Boolean(nameError) && (attempted || nameTyped)}
                errorMessage={nameError}
                onChange={(next) => {
                  setNameTyped(true);
                  setName(next);
                }}
              />
              <FieldTypePicker
                value={ai ? 'ai' : spec.type}
                onChange={(type) => (type === 'ai' ? chooseAi() : chooseType(type))}
                offerAi={!isPrimary && !initial?.source && !live}
                kept={initial?.ai ? 'ai' : initial?.type}
                aiNote={aiUnavailable && !initial?.ai ? message(aiUnavailable) : undefined}
                allowed={
                  initial?.source
                    ? [initial.type]
                    : live
                      ? (isPrimary ? PRIMARY_FIELD_TYPES : FIELD_TYPES).filter(liveAllowsType)
                      : isPrimary
                        ? PRIMARY_FIELD_TYPES
                        : undefined
                }
                disabled={Boolean(initial?.source)}
              />
              {live && !initial?.source && (
                <p>
                  {t({
                    id: 'synced.live.fieldTypes',
                    message:
                      'This table reads its source live.  Links, lookups, rollups, counts, and formulas need every record at hand, so it can’t have them.',
                  })}
                </p>
              )}
              {initial &&
                parentTable?.joined &&
                (() => {
                  const mapping = parentTable.joined.fields.find((item) => item.outputFieldId === initial.id);
                  const names = (mapping ? joinedSources(mapping) : [])
                    .flatMap((source) => {
                      const field = schema?.fieldById.get(source.fieldId);
                      const table = schema?.tableById.get(source.tableId);
                      return field && table
                        ? [t({ id: 'joined.mapping.sourceLabel', message: `${table.name} ${field.name}` })]
                        : [];
                    })
                    .join(', ');
                  return names ? (
                    <p>{t({ id: 'joined.mapping.header', message: `Mapped from ${names}` })}</p>
                  ) : null;
                })()}
              {initial?.source && (
                <p>
                  {t({
                    id: 'synced.field.noConvert',
                    message: 'Source fields keep the type their source gives them.',
                  })}
                </p>
              )}
              {preview ? (
                <Banner tone={preview.emptied || preview.tooManyChoices ? 'warning' : 'info'}>
                  <p>
                    {t({
                      id: 'field.convert.total',
                      message: plural(total, { one: '# value checked.', other: '# values checked.' }),
                    })}
                  </p>
                  {preview.dropped !== undefined && (
                    <p>
                      {t({
                        id: 'field.convert.dropped',
                        message: plural(preview.dropped, {
                          one: '# selection will be dropped.',
                          other: '# selections will be dropped.',
                        }),
                      })}
                    </p>
                  )}
                  {preview.orphaned !== undefined && (
                    <p>
                      {t({
                        id: 'field.convert.orphaned',
                        message: plural(preview.orphaned, {
                          one: '# selection will keep its ID without an available label.',
                          other: '# selections will keep their IDs without an available label.',
                        }),
                      })}
                    </p>
                  )}
                  {preview.tooManyChoices ? (
                    <p>
                      {t({
                        id: 'field.convert.tooManyChoices',
                        message: 'There are more than 1,000 different values, too many to make options from.',
                      })}
                    </p>
                  ) : null}
                  {preview.emptied > 0 ? (
                    <p>
                      {t({
                        id: 'field.convert.emptied',
                        message: plural(emptied, {
                          one: '# value can’t be converted and will be cleared.',
                          other: '# values can’t be converted and will be cleared.',
                        }),
                      })}
                    </p>
                  ) : !preview.tooManyChoices ? (
                    <p>{t({ id: 'field.convert.none', message: 'Every value converts.' })}</p>
                  ) : null}
                  {examples ? (
                    <p>{t({ id: 'field.convert.examples', message: `For example: ${examples}` })}</p>
                  ) : null}
                  {preview.newChoices.length ? (
                    <p>
                      {t({
                        id: 'field.convert.newChoices',
                        message: plural(count, { one: 'Adds # option.', other: 'Adds # options.' }),
                      })}
                    </p>
                  ) : null}
                </Banner>
              ) : null}
              {ai && isAiOutputType(spec.type) ? (
                <AiFieldOptions
                  value={ai}
                  outputType={spec.type}
                  fields={tableFields}
                  fieldId={initial?.id}
                  unavailable={aiUnavailable}
                  onChange={setAi}
                  onOutputType={(type) => chooseType(type, true)}
                />
              ) : null}
              <FieldOptionsForm
                type={spec.type}
                schema={schema}
                tableId={tableId}
                fieldId={initial?.id}
                options={spec.options}
                onChange={(options) => changeSpec({ ...spec, options } as FieldSpec)}
                noDefault={noDefault}
              />
              <Disclosure defaultExpanded={Boolean(initial?.description)}>
                {initial?.description ? (
                  <DisclosureTrigger>
                    {t({ id: 'field.dialog.description', message: 'Description' })}
                  </DisclosureTrigger>
                ) : (
                  <Button
                    slot="trigger"
                    icon={faPlus}
                    aria-label={t({ id: 'field.dialog.addDescription', message: 'Add description' })}
                  />
                )}
                <DisclosurePanel>
                  <TextArea
                    label={t({ id: 'field.dialog.description', message: 'Description' })}
                    value={description}
                    onChange={setDescription}
                    maxLength={LIMITS.descriptionLength}
                  />
                </DisclosurePanel>
              </Disclosure>
              {duplicates && (
                <div>
                  <ul>
                    {duplicates.values.map((value, index) => (
                      <li key={index}>{value}</li>
                    ))}
                  </ul>
                  <a href={duplicates.href}>
                    {t({ id: 'field.validation.dedupe', message: 'Review duplicates' })}
                  </a>
                </div>
              )}
              {error ? <Banner tone="danger">{error}</Banner> : null}
            </div>
          </DialogBody>
          <DialogFooter>
            {mode === 'edit' && onDuplicate && (
              <Button type="button" isDisabled={isSaving} onPress={onDuplicate}>
                {t({ id: 'duplicate.field.title', message: 'Duplicate field' })}
              </Button>
            )}
            <Button type="button" isDisabled={isSaving} onPress={onCancel}>
              {t({ id: 'field.dialog.cancel', message: 'Cancel' })}
            </Button>
            <Button
              {...anchor('field.create')}
              type="submit"
              variant="primary"
              isDisabled={
                isSaving || hasDuplicateChoices || invalidOptions || Boolean(preview?.tooManyChoices)
              }
              isPending={isSaving}
            >
              {mode === 'create'
                ? t({ id: 'field.dialog.create', message: 'Create field' })
                : t({ id: 'field.dialog.save', message: 'Save' })}
            </Button>
          </DialogFooter>
        </form>
      </Dialog>
    </Modal>
  );
}
