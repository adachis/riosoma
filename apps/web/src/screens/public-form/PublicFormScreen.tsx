import { PaymentNotice } from '../../features/payments/PaymentNotice';
import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react';
import { flushSync } from 'react-dom';
import { useLingui } from '@lingui/react/macro';
import { useQuery } from '@tanstack/react-query';
import { useParams } from '@tanstack/react-router';
import { I18nProvider as LocaleProvider } from 'react-aria-components';
import {
  FieldSpec,
  PublicFormId,
  withDefaults,
  visibleFormQuestions,
  type CellValue,
  type FieldMeta,
  type PublicForm,
  type PublicQuestion,
  type PublicSubmitted,
  type TextConflict,
} from '@riosoma/contracts';
import { DEFAULT_THEME, type ThemeChoice } from '@riosoma/tokens';
import { Button, Spinner, TextArea, TextField } from '@riosoma/ui';
import { api, ApiError } from '../../api';
import type { FormatContext } from '../../grid/format';
import { useServerMessage } from '../../messages/useServerMessage';
import { useTheme } from '../../shell/useAppliedTheme';
import { AnswerEditor } from '../database/views/form/AnswerEditor';
import { startingAnswers } from '../../fields/formDefaults';
import { TextConflictDialog } from '../../fields/TextConflictDialog.lazy';
import '../database/record/RecordCard.css';
import './public-form.css';

/**
 * The server refuses a ticket in its first 2 seconds, since only a script answers that fast.  A
 * quick person's submission waits out the rest instead of failing.
 */
const TICKET_MIN_AGE_MS = 2_100;

/** A form shared by link, at `/f/:formId`: anyone can answer it, signed in or not. */
export function PublicFormScreen() {
  const { formId } = useParams({ from: '/f/$formId' });
  return <PublicFormPage formId={formId} />;
}

export function PublicFormEditScreen() {
  const { formId } = useParams({ from: '/f/$formId/edit' });
  // The fragment stays out of HTTP requests, server logs, and referrer headers.
  const token = window.location.hash.slice(1);
  return <PublicFormPage formId={formId} editToken={token} />;
}

export function PublicFormPage({ formId, editToken }: { formId: string; editToken?: string }) {
  const { t } = useLingui();
  const message = useServerMessage();
  const known = PublicFormId.safeParse(formId).success;
  const form = useQuery({
    queryKey: ['public', 'forms', formId, editToken ?? null],
    queryFn: () =>
      api<PublicForm>(
        `/api/public/forms/${encodeURIComponent(formId)}${editToken !== undefined ? '/edit-session' : ''}`,
        editToken !== undefined ? { body: { token: editToken } } : undefined,
      ),
    enabled: known,
    // The ticket rides with the definition, so a quiet refetch mustn't swap it mid-answer.
    staleTime: Infinity,
  });
  // A form that stopped, or is paused while its sharer is suspended, reads as unavailable.
  const missing =
    !known ||
    (form.error instanceof ApiError &&
      (form.error.info.code === 'not_found' || form.error.info.code === 'gone'));
  const theme: ThemeChoice | null = form.data
    ? form.data.theme
      ? { theme: form.data.theme.id, scheme: form.data.theme.scheme }
      : DEFAULT_THEME
    : missing || form.isError
      ? DEFAULT_THEME
      : null;
  useTheme(theme);

  if (missing) return <Unavailable />;
  if (form.isError)
    return (
      <PublicLayout>
        <div className="rio-public-form__page rio-public-form__notice" role="alert">
          <p>
            {form.error instanceof ApiError
              ? message(form.error.info.messageKey, form.error.info.params)
              : message('errors.internal')}
          </p>
          <Button onPress={() => void form.refetch()}>
            {t({ id: 'boot.error.retry', message: 'Try again' })}
          </Button>
        </div>
      </PublicLayout>
    );
  if (!form.data)
    return (
      <PublicLayout>
        <div className="rio-public-form__page rio-public-form__notice">
          <Spinner />
        </div>
      </PublicLayout>
    );
  return (
    <Answering
      key={`${formId}:${form.data.edit?.session ?? ''}`}
      form={form.data}
      loadedAt={form.dataUpdatedAt}
    />
  );
}

/** The frame every public page sits in: a centered column, with a line saying where it's made. */
export function PublicLayout({ children }: { children: ReactNode }) {
  const { t } = useLingui();
  return (
    <main className="rio-public-form">
      {children}
      <footer className="rio-public-form__footer">
        {t({ id: 'forms.public.poweredBy', message: 'Made with Riosoma' })}
      </footer>
    </main>
  );
}

function Unavailable({ focus = false }: { focus?: boolean }) {
  const { t } = useLingui();
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    if (focus) heading.current?.focus();
  }, [focus]);
  return (
    <PublicLayout>
      <div className="rio-public-form__page rio-public-form__notice">
        <h1 ref={heading} tabIndex={-1}>
          {t({ id: 'forms.public.unavailable', message: 'This form isn’t available.' })}
        </h1>
        <p>
          {t({
            id: 'forms.public.unavailableHelp',
            message: 'It may have been unshared or deleted.  Check the link with whoever sent it.',
          })}
        </p>
      </div>
    </PublicLayout>
  );
}

/** A question's field, rebuilt from what the public form says about it. */
export function questionField(question: PublicQuestion): FieldMeta | null {
  const spec = FieldSpec.safeParse({ type: question.type, options: question.options });
  if (!spec.success) return null;
  return {
    ...spec.data,
    id: question.fieldId,
    tableId: '',
    name: question.label,
    description: '',
    position: 0,
    createdAt: '',
    updatedAt: '',
  };
}

function empty(value: CellValue | undefined): boolean {
  return (
    value == null ||
    (typeof value === 'string' && value.trim() === '') ||
    (Array.isArray(value) && value.length === 0)
  );
}

function Answering({ form, loadedAt }: { form: PublicForm; loadedAt: number }) {
  const { t, i18n } = useLingui();
  const message = useServerMessage();
  const id = useId();
  const [answers, setAnswers] = useState<Record<string, CellValue>>(
    () => form.edit?.values ?? startingAnswers(form.questions.map(questionField)),
  );
  const [confirmationEmail, setConfirmationEmail] = useState('');
  const current = useRef(answers);
  const [baseValues, setBaseValues] = useState<Record<string, string | null>>(() =>
    Object.fromEntries(
      form.questions
        .filter((question) => question.type === 'longText' || question.type === 'json')
        .map((question) => [
          question.fieldId,
          typeof form.edit?.values[question.fieldId] === 'string'
            ? (form.edit.values[question.fieldId] as string)
            : null,
        ]),
    ),
  );
  const [conflicts, setConflicts] = useState<TextConflict[]>([]);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState('');
  const [pending, setPending] = useState(false);
  const inFlight = useRef(false);
  const [done, setDone] = useState<PublicSubmitted | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  const [revision, setRevision] = useState(0);
  const page = useRef<HTMLFormElement>(null);
  const thanks = useRef<HTMLDivElement>(null);
  const trap = useRef<HTMLInputElement>(null);
  const locale = i18n.locale || 'en-US';
  const format = useMemo<FormatContext>(
    () => ({
      locale,
      timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      collaborators: new Map(),
    }),
    [locale],
  );
  const questions = useMemo(
    () =>
      form.questions.flatMap((question) => {
        const field = questionField(question);
        return field ? [{ question, field }] : [];
      }),
    [form.questions],
  );
  const required = t({ id: 'form.requiredMissing', message: 'Answer this question.' });
  // The answers a payment was priced by show as they are, and the server refuses a change to one.
  const locked = useMemo(() => new Set(form.edit?.locked ?? []), [form.edit]);
  const lockedHelp = t({
    id: 'forms.edit.priceLocked',
    message: 'This answer set the price, so it can’t be changed.',
  });
  function effective(values: Record<string, CellValue>) {
    if (form.edit) return values;
    return withDefaults(
      questions.map(({ field }) => field),
      values,
      values,
      { now: new Date(), userId: null, timeZone: format.timeZone },
      true,
    );
  }
  const visibleIds = new Set(
    visibleFormQuestions(form.questions, effective(answers)).map((question) => question.fieldId),
  );
  const shownQuestions = questions.filter(({ question }) => visibleIds.has(question.fieldId));
  const editDate = done?.editLink
    ? new Intl.DateTimeFormat(locale, { dateStyle: 'long' }).format(new Date(done.editLink.expiresAt))
    : '';

  useEffect(() => {
    const previous = document.title;
    if (form.title) document.title = form.title;
    return () => {
      document.title = previous;
    };
  }, [form.title]);
  useEffect(() => {
    if (done) thanks.current?.focus();
  }, [done]);

  function answer(fieldId: string, value: CellValue) {
    if (inFlight.current || locked.has(fieldId)) return;
    current.current = {
      ...(!form.edit ? startingAnswers(questions.map(({ field }) => field)) : {}),
      ...current.current,
      [fieldId]: value,
    };
    // An empty edit checkbox displays unchecked, and must also be a usable false answer.
    if (form.edit)
      for (const { field } of questions)
        if (field.type === 'checkbox' && current.current[field.id] == null) current.current[field.id] = false;
    const shown = new Set(
      visibleFormQuestions(form.questions, effective(current.current)).map((question) => question.fieldId),
    );
    for (const question of form.questions)
      if (!shown.has(question.fieldId)) delete current.current[question.fieldId];
    setAnswers(current.current);
    setErrors((previous) => ({ ...previous, [fieldId]: '' }));
  }

  function focusQuestion(fieldId: string) {
    document.getElementById(`${id}-${fieldId}`)?.focus();
  }

  async function submit() {
    if (inFlight.current) return;
    // Editors commit on blur, so commit the one in use before reading answers.
    flushSync(() => {
      if (document.activeElement instanceof HTMLElement && page.current?.contains(document.activeElement))
        document.activeElement.blur();
    });
    const invalid = page.current?.querySelector<HTMLElement>('[aria-invalid="true"]:not([role="group"])');
    if (invalid) {
      invalid.focus();
      return;
    }
    const defaulted = form.edit
      ? current.current
      : withDefaults(
          questions.map(({ field }) => field),
          current.current,
          current.current,
          {
            now: new Date(),
            userId: null,
            timeZone: format.timeZone,
          },
          true,
        );
    const activeIds = new Set(
      visibleFormQuestions(form.questions, defaulted).map((question) => question.fieldId),
    );
    const activeQuestions = questions.filter(({ question }) => activeIds.has(question.fieldId));
    const missing = Object.fromEntries(
      activeQuestions
        .filter(({ question }) => question.required && empty(defaulted[question.fieldId]))
        .map(({ question }) => [question.fieldId, required]),
    );
    setErrors(missing);
    setError('');
    const firstMissing = Object.keys(missing)[0];
    if (firstMissing) {
      focusQuestion(firstMissing);
      return;
    }
    const values = Object.fromEntries(
      activeQuestions
        .filter(({ question }) => form.edit || !empty(current.current[question.fieldId]))
        .map(({ question }) => [question.fieldId, current.current[question.fieldId] ?? null]),
    );
    inFlight.current = true;
    setPending(true);
    try {
      const wait = form.edit ? 0 : loadedAt + TICKET_MIN_AGE_MS - Date.now();
      if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
      const result = await api<PublicSubmitted>(
        `/api/public/forms/${encodeURIComponent(form.formId)}/${form.edit ? 'edits' : 'submissions'}`,
        {
          body: form.edit
            ? {
                session: form.edit.session,
                values,
                ...(Object.keys(baseValues).length ? { baseValues } : {}),
              }
            : {
                ticket: form.ticket,
                values,
                website: trap.current?.value ?? '',
                timeZone: format.timeZone,
                ...(form.editEmailAvailable && confirmationEmail.trim()
                  ? { confirmationEmail: confirmationEmail.trim() }
                  : {}),
              },
        },
      );
      if (result.checkoutUrl && !result.editLink) {
        window.location.assign(result.checkoutUrl);
        return;
      }
      setDone(result);
    } catch (reason) {
      const info = reason instanceof ApiError ? reason.info : null;
      if (info?.code === 'not_found' || info?.code === 'gone') {
        setUnavailable(true);
        return;
      }
      if (info?.conflicts?.length) {
        setConflicts(info.conflicts);
        return;
      }
      if (info?.fields) {
        setErrors(
          Object.fromEntries(
            Object.entries(info.fields).map(([id, key]) => [
              id,
              info.issues?.find((issue) => issue.fieldId === id)?.message || message(key),
            ]),
          ),
        );
        const first = Object.keys(info.fields)[0];
        if (first) focusQuestion(first);
      }
      const fieldId = info?.params?.fieldId;
      if (
        info?.messageKey === 'data.form.required' &&
        typeof fieldId === 'string' &&
        questions.some(({ question }) => question.fieldId === fieldId)
      ) {
        setErrors({ [fieldId]: required });
        focusQuestion(fieldId);
      } else setError(message(info?.messageKey ?? 'errors.internal', info?.params));
    } finally {
      inFlight.current = false;
      setPending(false);
    }
  }

  function another() {
    current.current = startingAnswers(questions.map(({ field }) => field));
    setAnswers(current.current);
    setErrors({});
    setError('');
    setRevision((value) => value + 1);
    setDone(null);
    requestAnimationFrame(() =>
      page.current
        ?.querySelector<HTMLElement>('input:not([tabindex="-1"]), textarea, [role="spinbutton"]')
        ?.focus(),
    );
  }

  const conflict = conflicts[0];
  const conflictField = questions.find((item) => item.field.id === conflict?.fieldId)?.field;
  function chooseConflict(next: string | null) {
    if (!conflict) return;
    current.current = { ...current.current, [conflict.fieldId]: next };
    setAnswers(current.current);
    setBaseValues((values) => ({ ...values, [conflict.fieldId]: conflict.theirs }));
    setConflicts((items) => items.slice(1));
    if (conflicts.length === 1) requestAnimationFrame(() => page.current?.requestSubmit());
  }

  if (unavailable) return <Unavailable focus />;

  return (
    <PublicLayout>
      <LocaleProvider locale={locale}>
        {conflict && conflictField && (
          <TextConflictDialog
            key={`${conflict.fieldId}:${conflict.updatedAt}`}
            field={conflictField}
            conflict={conflict}
            pending={pending}
            onClose={() => setConflicts([])}
            onChoose={chooseConflict}
          />
        )}
        <form
          ref={page}
          className="rio-public-form__page"
          noValidate
          aria-labelledby={`${id}-title`}
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <header>
            <h1 id={`${id}-title`}>{form.title}</h1>
            {form.description && <p className="rio-public-form__description">{form.description}</p>}
          </header>
          {Boolean(form.files?.length) && (
            <section aria-label={t({ id: 'publicSharing.formFiles', message: 'Supporting files' })}>
              <h2>{t({ id: 'publicSharing.formFiles', message: 'Supporting files' })}</h2>
              <ul>
                {form.files?.map((file) => (
                  <li key={file.id}>
                    <a href={file.url} target="_blank" rel="noopener noreferrer">
                      {file.name}
                    </a>
                  </li>
                ))}
              </ul>
            </section>
          )}
          <PaymentNotice payment={form.payment} />
          {done ? (
            <div ref={thanks} tabIndex={-1} className="rio-public-form__thanks" role="status">
              <p>
                {form.edit
                  ? t({ id: 'forms.edit.saved', message: 'Your response was updated.' })
                  : done.thankYou || t({ id: 'form.thanks', message: 'Thanks!  Your answer was recorded.' })}
              </p>
              {done.textMerges?.map((merge) => {
                const name = merge.name ?? t({ id: 'textEdit.someone', message: 'Someone else' });
                return (
                  <div key={merge.fieldId}>
                    <p role="status">{t({ id: 'textEdit.merged', message: `Merged with ${name}'s edit` })}</p>
                    <TextArea
                      label={questions.find((item) => item.field.id === merge.fieldId)?.question.label}
                      value={merge.value ?? ''}
                      isReadOnly
                      rows={6}
                    />
                  </div>
                );
              })}
              {done.editLink && (
                <>
                  <a className="rio-public-form__edit-link" href={done.editLink.path}>
                    {t({ id: 'forms.edit.open', message: 'Edit your response' })}
                  </a>
                  <p>
                    {t({
                      id: 'forms.edit.linkHelp',
                      message: `Keep this link private.  It expires on ${editDate}.`,
                    })}
                  </p>
                </>
              )}
              {done.checkoutUrl && (
                <Button variant="primary" onPress={() => window.location.assign(done.checkoutUrl!)}>
                  {t({ id: 'forms.edit.continuePayment', message: 'Continue to payment' })}
                </Button>
              )}
              {done.allowAnother && (
                <Button onPress={another}>
                  {t({ id: 'forms.public.submitAnother', message: 'Submit another response' })}
                </Button>
              )}
            </div>
          ) : (
            <>
              {form.edit && (
                <p>
                  {t({
                    id: 'forms.edit.sessionHelp',
                    message:
                      'You’re editing your response.  Save within 15 minutes, or reopen your edit link.',
                  })}
                </p>
              )}
              {shownQuestions.map(({ question, field }) => {
                const questionId = `${id}-${question.fieldId}`;
                return (
                  <section
                    key={question.fieldId}
                    id={questionId}
                    tabIndex={-1}
                    role="group"
                    aria-labelledby={`${questionId}-label`}
                    aria-describedby={`${questionId}-help ${questionId}-required ${questionId}-validation`}
                    aria-invalid={Boolean(errors[question.fieldId])}
                    className="rio-public-form__question"
                  >
                    <div className="rio-public-form__question-heading">
                      <span id={`${questionId}-label`}>{question.label}</span>
                      <span id={`${questionId}-required`} className="rio-public-form__required">
                        {question.required ? t({ id: 'form.required', message: 'Required' }) : ''}
                      </span>
                    </div>
                    <div id={`${questionId}-help`} className="rio-public-form__help">
                      {locked.has(question.fieldId)
                        ? [question.help, lockedHelp].filter(Boolean).join('\n')
                        : question.help}
                    </div>
                    <fieldset
                      disabled={pending || locked.has(question.fieldId)}
                      className="rio-public-form__editor"
                    >
                      <AnswerEditor
                        values={answers}
                        key={`${revision}:${field.type}`}
                        field={field}
                        value={answers[field.id] ?? null}
                        format={format}
                        labelId={`${questionId}-label`}
                        onChange={answer}
                      />
                    </fieldset>
                    <div
                      id={`${questionId}-validation`}
                      className="rio-public-form__error"
                      aria-live="polite"
                    >
                      {errors[question.fieldId]}
                    </div>
                  </section>
                );
              })}
              {/* People never see or reach this field.  Scripts that fill in every input give themselves away. */}
              <div className="rio-public-form__trap" aria-hidden="true">
                <input
                  ref={trap}
                  type="text"
                  name="website"
                  tabIndex={-1}
                  autoComplete="off"
                  defaultValue=""
                />
              </div>
              <div className="rio-public-form__error" role="alert">
                {error}
              </div>
              {form.editEmailAvailable && (
                <TextField
                  label={t({ id: 'forms.edit.emailLabel', message: 'Email me my edit link (optional)' })}
                  type="email"
                  value={confirmationEmail}
                  onChange={setConfirmationEmail}
                  isDisabled={pending}
                />
              )}
              <Button
                type="submit"
                // Commit the editor after release so clearing its error cannot move this press target.
                preventFocusOnPress
                variant="primary"
                isPending={pending}
                className="rio-public-form__submit"
              >
                {form.edit
                  ? t({ id: 'forms.edit.save', message: 'Save response' })
                  : form.submitLabel || t({ id: 'form.submit', message: 'Submit' })}
              </Button>
            </>
          )}
        </form>
      </LocaleProvider>
    </PublicLayout>
  );
}
