import { faTrashCan } from '@fortawesome/free-solid-svg-icons';
import { plural } from '@lingui/core/macro';
import { useLingui } from '@lingui/react/macro';
import { SCRIPT_LIMITS, type ScriptPrompt } from '@riosoma/contracts';
import { Button, ComboBox, ListBoxItem, Select, TextField } from '@riosoma/ui';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useId, useState, type FormEvent } from 'react';
import type { DatabaseSession, SchemaState } from '../../../data/types';

export interface ScriptPromptCardProps {
  session: DatabaseSession;
  schema: SchemaState;
  prompt: ScriptPrompt;
  onAnswer(value: unknown): void;
  onStop(): void;
}

/**
 * What a paused script asks the person, with a way to answer and a way to stop the script instead.
 * The script's clock stands still until they do.
 */
export function ScriptPromptCard({ session, schema, prompt, onAnswer, onStop }: ScriptPromptCardProps) {
  const { t } = useLingui();
  const heading = useId();
  const stop = (
    <Button variant="quiet" onPress={onStop}>
      {t({ id: 'scripts.prompt.stop', message: 'Stop script' })}
    </Button>
  );
  const tableName = (tableId: string) => schema.tableById.get(tableId)?.name ?? '';
  return (
    <section className="rio-script-prompt" aria-labelledby={heading}>
      {prompt.kind === 'delete' ? (
        <>
          <h3 id={heading} className="rio-script-prompt__label">
            {t({
              id: 'scripts.prompt.delete',
              message: plural(prompt.count, {
                one: `Delete # record from ${tableName(prompt.tableId)}?`,
                other: `Delete # records from ${tableName(prompt.tableId)}?`,
              }),
            })}
          </h3>
          <p>
            {t({
              id: 'scripts.prompt.deleteBody',
              message: 'The script asks to delete them.  Undo takes back everything the run changed.',
            })}
          </p>
          <div className="rio-script-prompt__actions">
            <Button
              variant="danger"
              onPress={() => onAnswer(true)}
              aria-label={t({ id: 'scripts.prompt.deleteConfirm', message: 'Delete' })}
              icon={faTrashCan}
            />
            <Button onPress={() => onAnswer(false)}>
              {t({ id: 'scripts.prompt.deleteKeep', message: 'Don’t delete' })}
            </Button>
            {stop}
          </div>
        </>
      ) : (
        <>
          <h3 id={heading} className="rio-script-prompt__label">
            {prompt.label || t({ id: 'scripts.prompt.untitled', message: 'The script is waiting for you' })}
          </h3>
          {prompt.kind === 'text' ? (
            <TextAnswer onAnswer={onAnswer} stop={stop} />
          ) : prompt.kind === 'buttons' ? (
            <div className="rio-script-prompt__actions">
              {prompt.options.map((option, index) => (
                <Button
                  key={index}
                  variant={index === 0 ? 'primary' : 'secondary'}
                  onPress={() => onAnswer(index)}
                >
                  {option}
                </Button>
              ))}
              {stop}
            </div>
          ) : prompt.kind === 'table' ? (
            <TableAnswer schema={schema} onAnswer={onAnswer} stop={stop} />
          ) : (
            <RecordAnswer
              session={session}
              tableId={prompt.tableId}
              tableName={tableName(prompt.tableId)}
              onAnswer={onAnswer}
              stop={stop}
            />
          )}
        </>
      )}
    </section>
  );
}

function Continue({ disabled }: { disabled: boolean }) {
  const { t } = useLingui();
  return (
    <Button type="submit" variant="primary" isDisabled={disabled}>
      {t({ id: 'scripts.prompt.continue', message: 'Continue' })}
    </Button>
  );
}

function TextAnswer({ onAnswer, stop }: { onAnswer(value: string): void; stop: React.ReactNode }) {
  const { t } = useLingui();
  const [value, setValue] = useState('');
  return (
    <form
      className="rio-script-prompt__form"
      onSubmit={(event: FormEvent) => {
        event.preventDefault();
        onAnswer(value);
      }}
    >
      <TextField
        aria-label={t({ id: 'scripts.prompt.answer', message: 'Your answer' })}
        value={value}
        onChange={setValue}
        maxLength={SCRIPT_LIMITS.answerLength}
        autoFocus
      />
      <div className="rio-script-prompt__actions">
        <Continue disabled={false} />
        {stop}
      </div>
    </form>
  );
}

function TableAnswer({
  schema,
  onAnswer,
  stop,
}: {
  schema: SchemaState;
  onAnswer(value: string): void;
  stop: React.ReactNode;
}) {
  const { t } = useLingui();
  const [tableId, setTableId] = useState<string | null>(null);
  return (
    <form
      className="rio-script-prompt__form"
      onSubmit={(event: FormEvent) => {
        event.preventDefault();
        if (tableId) onAnswer(tableId);
      }}
    >
      <Select
        label={t({ id: 'scripts.prompt.table', message: 'Table' })}
        selectedKey={tableId}
        onSelectionChange={(key) => setTableId(key === null ? null : String(key))}
      >
        {schema.tables.map((table) => (
          <ListBoxItem key={table.id} id={table.id}>
            {table.name}
          </ListBoxItem>
        ))}
      </Select>
      <div className="rio-script-prompt__actions">
        <Continue disabled={!tableId} />
        {stop}
      </div>
    </form>
  );
}

function RecordAnswer({
  session,
  tableId,
  tableName,
  onAnswer,
  stop,
}: {
  session: DatabaseSession;
  tableId: string;
  tableName: string;
  onAnswer(value: string): void;
  stop: React.ReactNode;
}) {
  const { t } = useLingui();
  const [text, setText] = useState('');
  const [query, setQuery] = useState('');
  const [chosen, setChosen] = useState<{ id: string; name: string } | null>(null);
  // Searching waits for a pause in typing.
  useEffect(() => {
    const timer = setTimeout(() => setQuery(text), 250);
    return () => clearTimeout(timer);
  }, [text]);
  const found = useQuery({
    queryKey: ['scripts', 'records', tableId, query],
    queryFn: ({ signal }) => session.searchRecords(tableId, query, signal),
    staleTime: 30_000,
  });
  const items = [...(found.data ?? [])];
  if (chosen && !items.some((item) => item.id === chosen.id)) items.push(chosen);
  const unnamed = t({ id: 'scripts.prompt.unnamed', message: 'Unnamed record' });
  return (
    <form
      className="rio-script-prompt__form"
      onSubmit={(event: FormEvent) => {
        event.preventDefault();
        if (chosen) onAnswer(chosen.id);
      }}
    >
      <ComboBox
        label={t({ id: 'scripts.prompt.record', message: `Record in ${tableName}` })}
        selectedKey={chosen?.id ?? null}
        menuTrigger="focus"
        onInputChange={(input) => setText(input === chosen?.name ? '' : input)}
        onSelectionChange={(key) => setChosen(items.find((item) => item.id === key) ?? null)}
      >
        {items.map((item) => (
          <ListBoxItem key={item.id} id={item.id} textValue={item.name || unnamed}>
            {item.name || unnamed}
          </ListBoxItem>
        ))}
      </ComboBox>
      <div className="rio-script-prompt__actions">
        <Continue disabled={!chosen} />
        {stop}
      </div>
    </form>
  );
}
