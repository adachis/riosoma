import { faCircleQuestion, faPlay, faStop, faXmark } from '@fortawesome/free-solid-svg-icons';
import { plural } from '@lingui/core/macro';
import { useLingui } from '@lingui/react/macro';
import {
  LIMITS,
  roleAllows,
  type ScriptButtonContext,
  type ScriptMeta,
  type ScriptServerMessage,
} from '@riosoma/contracts';
import { Banner, Button, Dialog, Drawer, TextArea } from '@riosoma/ui';
import { useNavigate } from '@tanstack/react-router';
import { useCallback, useEffect, useId, useReducer, useRef, useState } from 'react';
import { useSaveState } from '../../../data/hooks';
import type { DatabaseSession, SchemaState } from '../../../data/types';
import { reportError, undoToast } from '../../../grid/view/actions';
import { SERVER_MESSAGES } from '../../../messages/server';
import { serverMessage } from '../../../messages/useServerMessage';
import { usePhone } from '../../../shell/useMediaQuery';
import { ScriptField } from '../automations/ScriptField';
import { ScriptMarkdown } from './ScriptMarkdown';
import { ScriptPromptCard } from './ScriptPromptCard';
import {
  IDLE,
  reduceRun,
  startScriptRun,
  type RunEntry,
  type RunState,
  type ScriptRunHandle,
  type ScriptSocketFactory,
} from './runner';
import './scripts.css';

export interface ScriptPanelProps {
  session: DatabaseSession;
  schema: SchemaState;
  script: ScriptMeta;
  onClose(): void;
  autoRun?: boolean;
  button?: ScriptButtonContext;
  /** Opens a run's socket.  Tests supply their own. */
  connect?: ScriptSocketFactory;
}

const SAVE_DELAY_MS = 800;

/**
 * Keeps what's typed in the code and description, and saves it a moment after typing stops, as
 * `script.update` commands that undo like any schema change.  `flush` saves at once, and resolves
 * once the server has answered, so a run always runs what's on the screen.
 */
function useScriptDraft(session: DatabaseSession, script: ScriptMeta) {
  const [source, setSource] = useState(script.source);
  const [description, setDescription] = useState(script.description);
  const latest = useRef({ source: script.source, description: script.description });
  const dirty = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const saving = useRef<Promise<{ applied: number; rejected: number }> | null>(null);
  // Changes from elsewhere, such as an undo or another person, show while nothing typed here waits.
  useEffect(() => {
    if (dirty.current) return;
    latest.current = { source: script.source, description: script.description };
    setSource(script.source);
    setDescription(script.description);
  }, [script.source, script.description]);
  const flush = useCallback(() => {
    clearTimeout(timer.current);
    timer.current = undefined;
    if (dirty.current) {
      dirty.current = false;
      const handle = session.run([
        {
          kind: 'script.update',
          scriptId: script.id,
          source: latest.current.source,
          description: latest.current.description,
        },
      ]);
      saving.current = handle.done;
    }
    return saving.current ?? Promise.resolve({ applied: 0, rejected: 0 });
  }, [session, script.id]);
  const change = (next: Partial<{ source: string; description: string }>) => {
    latest.current = { ...latest.current, ...next };
    if (next.source !== undefined) setSource(next.source);
    if (next.description !== undefined) setDescription(next.description);
    dirty.current = true;
    clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      try {
        void flush();
      } catch (error) {
        reportError(error);
      }
    }, SAVE_DELAY_MS);
  };
  // Closing the panel saves what's there.
  useEffect(
    () => () => {
      try {
        void flush();
      } catch {
        // A session that closed first has nothing left to save to.
      }
    },
    [flush],
  );
  return { source, description, change, flush };
}

/**
 * The script panel: one saved script, its code for people who can change the schema, and its
 * runs.  A run happens on the server, as the person running it, and what the script logs and shows
 * appears here as it happens.  When the script asks something, the question waits here, with a way
 * to stop the script instead.  A run's writes undo together, as one step named for the script.
 */
export function ScriptPanel({
  session,
  schema,
  script,
  onClose,
  connect,
  autoRun = false,
  button,
}: ScriptPanelProps) {
  const { t } = useLingui();
  const phone = usePhone();
  const heading = useId();
  const canChange = roleAllows(session.role(), 'editSchema');
  const canRun = roleAllows(session.role(), 'editRecords');
  const offline = useSaveState(session).status === 'offline';
  const draft = useScriptDraft(session, script);
  const [run, dispatch] = useReducer(reduceRun, IDLE);
  const [starting, setStarting] = useState(false);
  const handle = useRef<ScriptRunHandle | null>(null);
  const navigate = useNavigate();
  // A run names its undo step for the script as it's called when the run ends.
  const name = useRef(script.name);
  useEffect(() => {
    name.current = script.name;
  }, [script.name]);
  // Closing the panel stops its run.
  useEffect(() => () => handle.current?.close(), []);

  const start = async () => {
    if (handle.current) return;
    setStarting(true);
    try {
      const saved = await draft.flush();
      if (saved.rejected) return;
    } catch (error) {
      reportError(error);
      return;
    } finally {
      setStarting(false);
    }
    let groupId: string | null = null;
    let writes = 0;
    let adopted = false;
    // Everything the run wrote becomes one step of the person's undo history, however it ended.
    const adopt = () => {
      if (adopted || !groupId || !writes) return;
      adopted = true;
      session.adoptAction?.(groupId, { kind: 'script.run', name: name.current, count: writes });
      const script = name.current;
      undoToast(
        session,
        t({
          id: 'scripts.run.wrote',
          message: plural(writes, {
            one: `${script} changed # record`,
            other: `${script} changed # records`,
          }),
        }),
      );
    };
    dispatch({ type: 'reset' });
    handle.current = startScriptRun(
      script.id,
      (message: ScriptServerMessage | { type: 'lost' }) => {
        if (message.type === 'started') groupId = message.groupId;
        if (message.type === 'wrote' || message.type === 'finished') writes = message.writes;
        if (message.type === 'finished' || message.type === 'refused' || message.type === 'lost') {
          handle.current = null;
          adopt();
        }
        dispatch(message);
      },
      { socket: connect, button },
    );
  };

  const automatic = useRef(false);
  const startRef = useRef(start);
  useEffect(() => {
    startRef.current = start;
  });
  useEffect(() => {
    if (autoRun && !automatic.current) {
      automatic.current = true;
      void startRef.current();
    }
  }, [autoRun]);

  const running = run.status === 'starting' || run.status === 'running' || run.status === 'waiting';
  const body = (
    <div className="rio-script-panel__inner">
      <header className="rio-script-panel__header">
        <h2 id={heading}>{script.name}</h2>
        <Button
          variant="quiet"
          size="sm"
          icon={faCircleQuestion}
          aria-label={t({ id: 'scripts.help', message: 'How scripts work' })}
          onPress={() => {
            void navigate({
              to: '.',
              search: (prev: Record<string, unknown>) => ({ ...prev, help: 'scripts' }),
            });
          }}
        />
        <Button
          variant="quiet"
          size="sm"
          icon={faXmark}
          aria-label={t({ id: 'scripts.close', message: 'Close script' })}
          onPress={onClose}
        />
      </header>
      {canChange ? (
        <>
          <TextArea
            label={t({ id: 'scripts.description', message: 'Description' })}
            value={draft.description}
            maxLength={LIMITS.descriptionLength}
            rows={2}
            onChange={(description) => draft.change({ description })}
          />
          <ScriptField
            value={draft.source}
            readOnly={false}
            errorLine={run.error?.line}
            onChange={(source) => draft.change({ source })}
          />
        </>
      ) : script.description ? (
        <p className="rio-script-panel__description">{script.description}</p>
      ) : null}
      {canRun ? (
        <div className="rio-script-panel__controls">
          {running ? (
            <Button variant="danger" icon={faStop} onPress={() => handle.current?.cancel()}>
              {t({ id: 'scripts.stop', message: 'Stop' })}
            </Button>
          ) : (
            <Button
              variant="primary"
              icon={faPlay}
              isPending={starting}
              isDisabled={offline || (canChange && !draft.source.trim())}
              onPress={() => void start()}
            >
              {t({ id: 'scripts.run', message: 'Run' })}
            </Button>
          )}
          <RunStatusLine run={run} />
        </div>
      ) : (
        <p className="rio-script-panel__note">
          {t({ id: 'scripts.cannotRun', message: 'People who can edit records run scripts.' })}
        </p>
      )}
      {canRun && offline ? (
        <p className="rio-script-panel__note">
          {t({
            id: 'scripts.offline',
            message: 'Scripts run on the server, so running one waits until you’re back online.',
          })}
        </p>
      ) : null}
      {run.error && (run.status === 'failed' || run.status === 'canceled') ? <RunError run={run} /> : null}
      {run.prompt ? (
        <ScriptPromptCard
          key={run.prompt.promptId}
          session={session}
          schema={schema}
          prompt={run.prompt.prompt}
          onAnswer={(value) => {
            const promptId = run.prompt!.promptId;
            dispatch({ type: 'answered' });
            handle.current?.answer(promptId, value);
          }}
          onStop={() => handle.current?.cancel()}
        />
      ) : null}
      <RunOutput entries={run.entries} />
    </div>
  );
  return phone ? (
    <Drawer
      isOpen
      isDismissable={!running}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      className="rio-script-panel__sheet"
    >
      <Dialog hideCloseButton aria-labelledby={heading} className="rio-script-panel__dialog">
        {body}
      </Dialog>
    </Drawer>
  ) : (
    <aside className="rio-script-panel" aria-labelledby={heading}>
      {body}
    </aside>
  );
}

function RunStatusLine({ run }: { run: RunState }) {
  const { t, i18n } = useLingui();
  const ms = (run.ms ?? 0).toLocaleString(i18n.locale);
  const writes = run.writes;
  const text =
    run.status === 'starting'
      ? t({ id: 'scripts.status.starting', message: 'Starting…' })
      : run.status === 'running'
        ? t({ id: 'scripts.status.running', message: 'Running…' })
        : run.status === 'waiting'
          ? t({ id: 'scripts.status.waiting', message: 'Waiting for your answer' })
          : run.status === 'succeeded'
            ? t({ id: 'scripts.status.succeeded', message: `Finished in ${ms} ms` })
            : run.status === 'canceled'
              ? t({ id: 'scripts.status.canceled', message: 'Stopped' })
              : run.status === 'failed'
                ? t({ id: 'scripts.status.failed', message: 'Didn’t finish' })
                : '';
  return (
    <p className="rio-script-panel__status" role="status">
      {text}
      {writes && run.status !== 'idle'
        ? ` · ${t({
            id: 'scripts.status.writes',
            message: plural(writes, { one: 'Changed # record', other: 'Changed # records' }),
          })}`
        : ''}
    </p>
  );
}

function RunError({ run }: { run: RunState }) {
  const { t, i18n } = useLingui();
  const error = run.error!;
  // A refusal the script didn't catch arrives as its message key.
  const detail =
    error.detail && SERVER_MESSAGES[error.detail] ? serverMessage(i18n, error.detail) : error.detail;
  const line = error.line;
  const column = error.column;
  return (
    <Banner
      tone={run.status === 'canceled' ? 'info' : 'danger'}
      title={serverMessage(i18n, error.messageKey)}
    >
      {detail ? <p>{detail}</p> : null}
      {line !== undefined && column !== undefined ? (
        <p>{t({ id: 'scripts.error.position', message: `Line ${line}, column ${column}` })}</p>
      ) : null}
    </Banner>
  );
}

function RunOutput({ entries }: { entries: readonly RunEntry[] }) {
  const { t } = useLingui();
  const levels = {
    log: '',
    info: '',
    warn: t({ id: 'scripts.output.warning', message: 'Warning' }),
    error: t({ id: 'scripts.output.error', message: 'Error' }),
  };
  return (
    <section className="rio-script-output" aria-label={t({ id: 'scripts.output', message: 'Output' })}>
      {entries.length ? (
        <div role="log" aria-live="polite">
          <ol role="list" className="rio-script-output__list">
            {entries.map((entry) => (
              <li
                key={entry.id}
                data-kind={entry.kind}
                data-level={entry.kind === 'log' ? entry.level : undefined}
              >
                {entry.kind === 'log' ? (
                  <pre>
                    {levels[entry.level] ? (
                      <span className="rio-script-output__level">{levels[entry.level]} </span>
                    ) : null}
                    {entry.text}
                  </pre>
                ) : entry.kind === 'text' ? (
                  <p className="rio-script-output__text">{entry.text}</p>
                ) : entry.kind === 'markdown' ? (
                  <ScriptMarkdown text={entry.text} />
                ) : (
                  <div className="rio-script-output__table">
                    <table>
                      <thead>
                        <tr>
                          {entry.columns.map((column, index) => (
                            <th key={index} scope="col">
                              {column || t({ id: 'scripts.output.value', message: 'Value' })}
                            </th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {entry.rows.map((row, index) => (
                          <tr key={index}>
                            {row.map((cell, cellIndex) => (
                              <td key={cellIndex}>{cell}</td>
                            ))}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </li>
            ))}
          </ol>
        </div>
      ) : (
        <p className="rio-script-panel__note">
          {t({
            id: 'scripts.output.empty',
            message: 'What the script logs and shows appears here as it runs.',
          })}
        </p>
      )}
    </section>
  );
}
