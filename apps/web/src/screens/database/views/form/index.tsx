import { faPlus } from '@fortawesome/free-solid-svg-icons';
import { PaymentPageSettings } from '../../../../features/payments/PaymentPageSettings';
import { useEffect, useId, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import { useLingui } from '@lingui/react/macro';
import {
  isComputedType,
  newId,
  roleAllows,
  visibleFormQuestions,
  withDefaults,
  type CellValue,
  type FieldMeta,
  type FormQuestion,
} from '@riosoma/contracts';
import { Button, SortableItem, SortableList } from '@riosoma/ui';
import { ApiError } from '../../../../api';
import type { SessionEvent } from '../../../../data/types';
import { useServerMessage } from '../../../../messages/useServerMessage';
import type { ViewComponentProps } from '../types';
import { followsValues } from '../../joins/matched';
import { FormDesign, QuestionDesign } from './FormDesign';
import { PublicFormShare } from './PublicFormShare';
import { QuestionEditor } from './QuestionEditor';
import { startingAnswers } from '../../../../fields/formDefaults';
import './form.css';
import { HelpButton } from '../../../../docs/HelpButton';
import { anchor } from '../../../../demos/anchors';

function writable(field: FieldMeta | undefined): field is FieldMeta {
  // Links that follow matching values change only with the values, so a form can't set them.
  return field !== undefined && !isComputedType(field.type) && !followsValues(field);
}

function empty(value: CellValue | undefined) {
  return (
    value == null ||
    (typeof value === 'string' && value.trim() === '') ||
    (Array.isArray(value) && value.length === 0)
  );
}

export function FormView(props: ViewComponentProps) {
  return <FormPage key={`${props.session.databaseId}:${props.view.id}`} {...props} />;
}

function FormPage({ session, view, table, fields, format, canEdit, readOnly, onConfig }: ViewComponentProps) {
  const { t } = useLingui();
  const message = useServerMessage();
  const id = useId();
  const config = view.config.form;
  const [editing, setEditing] = useState(false);
  canEdit = canEdit && !readOnly && !view.config.locked;
  const canSubmit = !readOnly && roleAllows(session.role(), 'editRecords') && !table.source && !table.joined;
  const designing = canEdit && editing;
  const starting = () =>
    startingAnswers(config.questions.map(({ fieldId }) => fields.find((field) => field.id === fieldId)));
  const [answers, setAnswers] = useState<Record<string, CellValue>>(starting);
  const currentAnswers = useRef(answers);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState('');
  const [pending, setPending] = useState(false);
  const inFlight = useRef(false);
  const [uploading, setUploading] = useState<ReadonlySet<string>>(new Set());
  const [submitted, setSubmitted] = useState(false);
  const [revision, setRevision] = useState(0);
  const form = useRef<HTMLFormElement>(null);
  const thanks = useRef<HTMLDivElement>(null);
  const unsubscribe = useRef<(() => void) | undefined>(undefined);
  const fieldById = new Map(
    fields.filter((field) => field.tableId === table.id).map((field) => [field.id, field]),
  );
  // A question on a field locked to other people is left out, as the server leaves it out.
  const locks = session.getSchema().access.fields;
  const available = config.questions.filter(
    (question) =>
      writable(fieldById.get(question.fieldId)) && locks.get(question.fieldId)?.editable !== false,
  );
  function effective(values: Record<string, CellValue>) {
    return withDefaults(
      fields,
      values,
      values,
      { now: new Date(), userId: session.userId || null, timeZone: format.timeZone },
      true,
    );
  }
  const visible = visibleFormQuestions(available, effective(answers));

  useEffect(() => () => unsubscribe.current?.(), []);
  useEffect(() => {
    if (submitted) thanks.current?.focus();
  }, [submitted]);

  function answer(fieldId: string, value: CellValue) {
    if (!canSubmit || inFlight.current) return;
    currentAnswers.current = { ...starting(), ...currentAnswers.current, [fieldId]: value };
    const shown = new Set(
      visibleFormQuestions(available, effective(currentAnswers.current)).map((question) => question.fieldId),
    );
    for (const question of available)
      if (!shown.has(question.fieldId)) delete currentAnswers.current[question.fieldId];
    setAnswers(currentAnswers.current);
    setErrors((previous) => ({ ...previous, [fieldId]: '' }));
  }

  function saveQuestion(fieldId: string, patch: Partial<FormQuestion>) {
    onConfig({
      form: {
        ...config,
        questions: config.questions.map((question) =>
          question.fieldId === fieldId ? { ...question, ...patch } : question,
        ),
      },
    });
  }

  function orderedQuestions(fieldId: string, to: number) {
    const from = config.questions.findIndex((question) => question.fieldId === fieldId);
    const questions = [...config.questions];
    const [question] = questions.splice(from, 1);
    if (question) questions.splice(to, 0, question);
    return questions;
  }

  function canMove(fieldId: string, to: number) {
    const questions = orderedQuestions(fieldId, to);
    return questions.every(
      (question, index) =>
        !question.showIf ||
        questions.slice(0, index).some((earlier) => earlier.fieldId === question.showIf?.fieldId),
    );
  }

  function move(fieldId: string, to: number) {
    if (!canMove(fieldId, to)) {
      setError(
        t({ id: 'form.conditionOrder', message: 'Keep each question after the answer it depends on.' }),
      );
      return;
    }
    const questions = orderedQuestions(fieldId, to);
    onConfig({ form: { ...config, questions } });
  }

  function focusQuestion(fieldId: string) {
    document.getElementById(`${id}-${fieldId}`)?.focus();
  }

  function showError(key: string, params?: Record<string, string | number | boolean>) {
    const fieldId = params?.fieldId;
    if (
      key === 'data.form.required' &&
      typeof fieldId === 'string' &&
      available.some((question) => question.fieldId === fieldId)
    ) {
      setErrors({ [fieldId]: t({ id: 'form.requiredMissing', message: 'Answer this question.' }) });
      focusQuestion(fieldId);
    } else setError(message(key, params));
  }

  async function submit() {
    if (!canSubmit || inFlight.current || uploading.size || designing) return;
    // The record editors commit on blur. Flush that commit before reading answers or validity.
    flushSync(() => {
      if (document.activeElement instanceof HTMLElement && form.current?.contains(document.activeElement))
        document.activeElement.blur();
    });
    const invalid = form.current?.querySelector<HTMLElement>('[aria-invalid="true"]:not([role="group"])');
    if (invalid) {
      invalid.focus();
      return;
    }
    const defaulted = withDefaults(
      fields,
      currentAnswers.current,
      currentAnswers.current,
      {
        now: new Date(),
        userId: session.userId || null,
        timeZone: format.timeZone,
      },
      true,
    );
    const missing = Object.fromEntries(
      visibleFormQuestions(available, defaulted)
        .filter((question) => question.required && empty(defaulted[question.fieldId]))
        .map((question) => [
          question.fieldId,
          t({ id: 'form.requiredMissing', message: 'Answer this question.' }),
        ]),
    );
    setErrors(missing);
    setError('');
    const firstMissing = Object.keys(missing)[0];
    if (firstMissing) {
      focusQuestion(firstMissing);
      return;
    }
    const values = Object.fromEntries(
      visibleFormQuestions(available, defaulted)
        .filter((question) => !empty(currentAnswers.current[question.fieldId]))
        .map((question) => [question.fieldId, currentAnswers.current[question.fieldId]!]),
    );
    inFlight.current = true;
    setPending(true);
    const refusals: Extract<SessionEvent, { kind: 'rejected' }>[] = [];
    unsubscribe.current = session.subscribeEvents((event) => {
      if (event.kind === 'rejected') refusals.push(event);
    });
    try {
      const result = await session.run([
        {
          kind: 'record.create',
          tableId: table.id,
          formViewId: view.id,
          records: [{ id: newId('record'), values }],
        },
      ]).done;
      if (result.rejected) {
        const refusal = refusals.find((item) => item.messageKey === 'data.form.required') ?? refusals.at(-1);
        if (refusal?.fields) {
          setErrors(
            Object.fromEntries(
              Object.entries(refusal.fields).map(([id, key]) => [
                id,
                refusal.issues?.find((issue) => issue.fieldId === id)?.message || message(key),
              ]),
            ),
          );
          const first = Object.keys(refusal.fields)[0];
          if (first) focusQuestion(first);
        }
        showError(refusal?.messageKey ?? 'errors.internal', refusal?.params);
      } else setSubmitted(true);
    } catch (reason) {
      showError(
        reason instanceof ApiError
          ? reason.info.messageKey
          : reason instanceof Error
            ? reason.message
            : 'errors.internal',
        reason instanceof ApiError ? reason.info.params : undefined,
      );
    } finally {
      unsubscribe.current?.();
      unsubscribe.current = undefined;
      inFlight.current = false;
      setPending(false);
    }
  }

  return (
    <div
      className="rio-form-view"
      data-designing={designing || undefined}
      tabIndex={!canSubmit && !designing ? 0 : undefined}
    >
      {canEdit && (
        <div className="rio-form-view__toolbar" {...anchor('view.settings.form')}>
          <Button
            aria-pressed={designing}
            isDisabled={pending || uploading.size > 0}
            onPress={() => setEditing(!editing)}
          >
            {designing
              ? t({ id: 'form.done', message: 'Done editing' })
              : t({ id: 'form.edit', message: 'Edit form' })}
          </Button>
          <HelpButton subject={view.name} moduleId="forms" section="designing-the-form" />
        </div>
      )}
      <div className="rio-form-view__layout">
        <form
          ref={form}
          className="rio-form-view__page"
          noValidate
          aria-label={config.title || view.name}
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          {designing ? (
            <>
              <PaymentPageSettings kind="form" targetId={view.id} fields={fields} />
              <FormDesign config={config} onChange={(patch) => onConfig({ form: { ...config, ...patch } })} />
            </>
          ) : (
            <header>
              <h1>{config.title || view.name}</h1>
              {config.description && <p className="rio-form-view__description">{config.description}</p>}
            </header>
          )}
          {submitted && !designing ? (
            <div ref={thanks} tabIndex={-1} className="rio-form-view__thanks" role="status">
              <p>
                {config.thankYou || t({ id: 'form.thanks', message: 'Thanks!  Your answer was recorded.' })}
              </p>
              {config.allowAnother && (
                <Button
                  onPress={() => {
                    currentAnswers.current = starting();
                    setAnswers(currentAnswers.current);
                    setErrors({});
                    setError('');
                    setRevision(revision + 1);
                    setSubmitted(false);
                    requestAnimationFrame(() =>
                      form.current?.querySelector<HTMLElement>('input, textarea, button')?.focus(),
                    );
                  }}
                >
                  {t({ id: 'form.another', message: 'Submit another' })}
                </Button>
              )}
            </div>
          ) : (
            <>
              {(designing ? config.questions : visible).length === 0 && (
                <p>{t({ id: 'form.noQuestions', message: 'Add fields to ask about.' })}</p>
              )}
              <SortableList
                items={(designing ? config.questions : visible).map((question) => {
                  const name = question.label || fieldById.get(question.fieldId)?.name || question.fieldId;
                  return {
                    id: question.fieldId,
                    name,
                    handleLabel: t({ id: 'form.reorder', message: `Reorder ${name}` }),
                  };
                })}
                disabledReason={
                  !designing
                    ? t({ id: 'form.reorderDisabled', message: 'Edit the form to move its fields.' })
                    : undefined
                }
                onMove={(from, to) => move(config.questions[from]!.fieldId, to)}
                canDrop={(fieldId, target) => canMove(fieldId, target.index)}
                dropReason={(fieldId, target) =>
                  canMove(fieldId, target.index)
                    ? undefined
                    : t({
                        id: 'form.conditionOrder',
                        message: 'Keep each question after the answer it depends on.',
                      })
                }
              >
                {(designing ? config.questions : visible).map((question, index) => {
                  const field = fieldById.get(question.fieldId);
                  const name = question.label || field?.name || question.fieldId;
                  const questionId = `${id}-${question.fieldId}`;
                  return (
                    <SortableItem
                      key={question.fieldId}
                      id={question.fieldId}
                      className="rio-form-view__question"
                      renderWrapper={(props, children) => (
                        <section
                          {...props}
                          id={questionId}
                          tabIndex={-1}
                          role="group"
                          aria-labelledby={`${questionId}-label`}
                          aria-describedby={`${questionId}-help ${questionId}-required ${questionId}-validation`}
                          aria-invalid={Boolean(errors[question.fieldId])}
                        >
                          {children}
                        </section>
                      )}
                    >
                      <>
                        <div className="rio-form-view__question-heading">
                          <span id={`${questionId}-label`}>{name}</span>
                          <span id={`${questionId}-required`} className="rio-form-view__required">
                            {question.required ? t({ id: 'form.required', message: 'Required' }) : ''}
                          </span>
                        </div>
                        <div id={`${questionId}-help`} className="rio-form-view__help">
                          {question.help}
                        </div>
                        {designing ? (
                          <QuestionDesign
                            question={question}
                            name={name}
                            index={index}
                            count={config.questions.length}
                            earlierFields={config.questions.slice(0, index).flatMap((item) => {
                              const earlier = fieldById.get(item.fieldId);
                              return earlier ? [{ ...earlier, name: item.label || earlier.name }] : [];
                            })}
                            format={format}
                            onChange={(patch) => saveQuestion(question.fieldId, patch)}
                            onRemove={() =>
                              onConfig({
                                form: {
                                  ...config,
                                  questions: config.questions
                                    .filter((item) => item.fieldId !== question.fieldId)
                                    .map((item) =>
                                      item.showIf?.fieldId === question.fieldId
                                        ? { ...item, showIf: null }
                                        : item,
                                    ),
                                },
                              })
                            }
                            onMove={(to) => move(question.fieldId, to)}
                          />
                        ) : (
                          writable(field) && (
                            <fieldset className="rio-form-view__editor">
                              <QuestionEditor
                                disabled={pending || !canSubmit}
                                values={answers}
                                key={`${revision}:${field.type}`}
                                field={{ ...field, name }}
                                value={answers[field.id] ?? null}
                                format={format}
                                session={session}
                                labelId={`${questionId}-label`}
                                onChange={answer}
                                onUploading={(busy) =>
                                  setUploading((previous) => {
                                    const next = new Set(previous);
                                    if (busy) next.add(field.id);
                                    else next.delete(field.id);
                                    return next;
                                  })
                                }
                              />
                            </fieldset>
                          )
                        )}
                        {designing && !writable(field) && (
                          <p className="rio-form-view__error">
                            {t({
                              id: 'form.unavailable',
                              message: 'This field can’t be used in a form any more.',
                            })}
                          </p>
                        )}
                        <div
                          id={`${questionId}-validation`}
                          className="rio-form-view__error"
                          aria-live="polite"
                        >
                          {errors[question.fieldId]}
                        </div>
                      </>
                    </SortableItem>
                  );
                })}
              </SortableList>
              <div className="rio-form-view__error" role="alert">
                {error}
              </div>
              {!(table.source || table.joined) && (
                <Button
                  type="submit"
                  // Commit the editor after release so clearing its error cannot move this press target.
                  preventFocusOnPress
                  variant="primary"
                  isDisabled={!canSubmit || designing || uploading.size > 0}
                  isPending={pending}
                  className="rio-form-view__submit"
                >
                  {config.submitLabel || t({ id: 'form.submit', message: 'Submit' })}
                </Button>
              )}
            </>
          )}
        </form>
        {designing && (
          <aside className="rio-form-view__fields" aria-labelledby={`${id}-fields`}>
            <h2 id={`${id}-fields`}>{t({ id: 'form.fields', message: 'Fields' })}</h2>
            {fields
              .filter((field) => field.tableId === table.id && writable(field))
              .map((field) => {
                const name = field.name;
                return (
                  <Button
                    key={field.id}
                    isDisabled={config.questions.some((question) => question.fieldId === field.id)}
                    onPress={() =>
                      onConfig({
                        form: {
                          ...config,
                          questions: [
                            ...config.questions,
                            { fieldId: field.id, required: false, label: '', help: '' },
                          ],
                        },
                      })
                    }
                    aria-label={t({ id: 'form.addQuestion', message: `Add ${name}` })}
                    icon={faPlus}
                  />
                );
              })}
          </aside>
        )}
      </div>
    </div>
  );
}

/**
 * The form's own settings live beside its questions, so creators edit them in context.  This
 * holds sharing by link, for people who can change the database's views.  A synced table takes
 * records only from its source, so its forms can't be shared.
 */
export function FormSettings({ view, table, fields, canEdit, onConfig }: ViewComponentProps) {
  if (!canEdit || table.source || table.joined) return null;
  return (
    <PublicFormShare
      viewId={view.id}
      questions={view.config.form.questions}
      fields={fields.filter((field) => field.tableId === table.id)}
      theme={view.config.form.theme ?? null}
      // A locked view keeps its settings, its public page's theme among them.
      {...(view.config.locked
        ? {}
        : { onTheme: (theme) => onConfig({ form: { ...view.config.form, theme } }) })}
    />
  );
}
