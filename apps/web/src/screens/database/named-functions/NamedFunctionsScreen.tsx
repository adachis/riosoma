import { faPlus, faTrashCan } from '@fortawesome/free-solid-svg-icons';
import { useEffect, useState } from 'react';
import { Trans, useLingui } from '@lingui/react/macro';
import {
  FieldOptions,
  newId,
  roleAllows,
  type NamedFunctionInput,
  type NamedFunctionMeta,
} from '@riosoma/contracts';
import { prepareNamedFunctions } from '@riosoma/formula';
import { Button, ConfirmDialog, TextArea, TextField, Tooltip, TooltipTrigger } from '@riosoma/ui';
import type { CommandInput, DatabaseSession, SchemaState } from '../../../data/types';
import { useServerMessage } from '../../../messages/useServerMessage';
import { ErrorBanner } from '../../../shell/ErrorBanner';
import { errorInfo } from '../../setup/useSetup';
import { anchor } from '../../../demos/anchors';
import { FormulaEditor } from '../fields/FormulaEditor';
import { callersOf, registryFor, testFunction } from './model';
import './named-functions.css';

export function NamedFunctionsScreen({
  session,
  schema,
  functionId,
  onOpen,
}: {
  session: DatabaseSession;
  schema: SchemaState;
  functionId?: string;
  onOpen(id?: string): void;
}) {
  const { t } = useLingui();
  const definitions = schema.namedFunctions ?? [];
  const selected = definitions.find((item) => item.id === functionId);
  const editable = roleAllows(session.role(), 'editRecords');
  const [deleting, setDeleting] = useState<NamedFunctionMeta | null>(null);
  const [error, setError] = useState<ReturnType<typeof errorInfo>>(null);
  const [pending, setPending] = useState(false);
  useEffect(
    () =>
      session.subscribeEvents((event) => {
        if (event.kind === 'rejected' && event.handled)
          setError({ key: event.messageKey, params: event.params });
      }),
    [session],
  );
  const title = t({ id: 'namedFunctions.title', message: 'Named functions' });
  useEffect(() => {
    const previous = document.title;
    const database = schema.database.name;
    document.title = t({ id: 'namedFunctions.pageTitle', message: `${title} – ${database}` });
    return () => {
      document.title = previous;
    };
  }, [title, schema.database.name, t]);
  async function run(command: CommandInput, next: () => void) {
    setError(null);
    setPending(true);
    try {
      const outcome = await session.run([command], { handlesRefusal: true }).done;
      if (outcome.rejected) return false;
      next();
      return true;
    } catch (failure) {
      setError(errorInfo(failure));
      return false;
    } finally {
      setPending(false);
    }
  }
  const used = deleting
    ? callersOf(deleting, definitions, [...schema.fieldById.values()], schema.tables)
    : null;
  const name = deleting?.name ?? '';
  const callers = [...(used?.fields ?? []), ...(used?.functions ?? [])].join(', ');
  return (
    <section className="rio-named-functions" aria-label={title}>
      <header>
        <h2>{title}</h2>
        {editable && (
          <Button
            {...anchor('namedFunctions.create')}
            icon={faPlus}
            aria-label={t({ id: 'namedFunctions.create', message: 'Create function' })}
            isDisabled={pending}
            onPress={() => {
              setError(null);
              onOpen('new');
            }}
          />
        )}
      </header>
      <p>
        <Trans id="namedFunctions.intro">
          Reuse a formula throughout this database. Pass field values as arguments.
        </Trans>
      </p>
      <ErrorBanner error={error} />
      <div className="rio-named-functions__layout">
        <nav aria-label={t({ id: 'namedFunctions.list', message: 'Functions' })}>
          {definitions.length === 0 && (
            <p>
              <Trans id="namedFunctions.empty">No named functions yet.</Trans>
            </p>
          )}
          <ul>
            {definitions.map((item) => (
              <li key={item.id}>
                <TooltipTrigger>
                  <Button
                    variant="quiet"
                    aria-label={`${item.name}(${item.parameters.join(', ')})`}
                    aria-current={item.id === functionId ? 'page' : undefined}
                    onPress={() => {
                      setError(null);
                      onOpen(item.id);
                    }}
                  >
                    {item.name}({item.parameters.join(', ')})
                  </Button>
                  <Tooltip>
                    {item.name}({item.parameters.join(', ')})
                  </Tooltip>
                </TooltipTrigger>
                <p>{item.description}</p>
              </li>
            ))}
          </ul>
        </nav>
        {selected || (functionId === 'new' && editable) ? (
          <FunctionForm
            key={`${selected?.id ?? 'new'}:${editable ? '' : selected?.revision}`}
            definition={selected}
            definitions={definitions}
            readOnly={!editable}
            pending={pending}
            onCancel={() => onOpen()}
            onDelete={() => {
              setError(null);
              setDeleting(selected!);
            }}
            onSave={(input, revision) =>
              run(
                selected
                  ? {
                      kind: 'namedFunction.update',
                      functionId: selected.id,
                      revision: revision ?? selected.revision,
                      definition: input,
                    }
                  : { kind: 'namedFunction.create', functionId: newId('namedFunction'), definition: input },
                () => onOpen(),
              )
            }
          />
        ) : functionId ? (
          <p role="status">
            <Trans id="namedFunctions.missing">
              This function is unavailable. Choose a function from the list.
            </Trans>
          </p>
        ) : null}
      </div>
      {deleting && (
        <ConfirmDialog
          isOpen
          tone="danger"
          title={t({ id: 'namedFunctions.delete.title', message: `Delete ${name}?` })}
          message={
            <>
              <p>
                {callers
                  ? t({
                      id: 'namedFunctions.delete.used',
                      message: `These formulas call ${name}: ${callers}. Formula fields will show errors. Update calling functions before deleting.`,
                    })
                  : t({ id: 'namedFunctions.delete.unused', message: `Delete ${name} from this database?` })}
              </p>
              <ErrorBanner error={error} />
            </>
          }
          confirmLabel={t({ id: 'namedFunctions.delete', message: 'Delete function' })}
          onOpenChange={(open) => {
            if (!open) setDeleting(null);
          }}
          onConfirm={async () => {
            if (
              !(await run(
                {
                  kind: 'namedFunction.delete',
                  functionId: deleting.id,
                  revision: deleting.revision,
                  confirmUsed: true,
                },
                () => {
                  setDeleting(null);
                  onOpen();
                },
              ))
            )
              throw new Error('errors.conflict');
          }}
        />
      )}
    </section>
  );
}

function FunctionForm({
  definition,
  definitions,
  readOnly,
  pending,
  onSave,
  onDelete,
  onCancel,
}: {
  definition?: NamedFunctionMeta;
  definitions: readonly NamedFunctionMeta[];
  readOnly: boolean;
  pending: boolean;
  onSave(input: NamedFunctionInput, revision?: number): Promise<boolean>;
  onDelete(): void;
  onCancel(): void;
}) {
  const { t } = useLingui();
  const message = useServerMessage();
  const [revision] = useState(definition?.revision);
  const [name, setName] = useState(definition?.name ?? '');
  const [parameters, setParameters] = useState(definition?.parameters.join(', ') ?? '');
  const [body, setBody] = useState(definition?.body ?? '');
  const [description, setDescription] = useState(definition?.description ?? '');
  const [samples, setSamples] = useState<Record<string, string>>({});
  const [tested, setTested] = useState<{ signature: string; result: ReturnType<typeof testFunction> } | null>(
    null,
  );
  const input = {
    name,
    parameters: parameters.trim() ? parameters.split(',').map((item) => item.trim()) : [],
    body,
    description,
  };
  const prepared = prepareNamedFunctions(registryFor(definitions, input, definition?.id));
  const valid = !('error' in prepared);
  const signature = JSON.stringify({ input, samples, definitions });
  const result = tested?.signature === signature ? tested.result : null;
  return (
    <form
      className="rio-named-functions__form"
      onSubmit={(event) => {
        event.preventDefault();
        if (valid && !readOnly && !pending) void onSave(input, revision);
      }}
    >
      <TextField
        label={t({ id: 'namedFunctions.name', message: 'Function name' })}
        value={name}
        onChange={setName}
        isRequired
        maxLength={64}
        isReadOnly={readOnly}
      />
      <TextField
        label={t({ id: 'namedFunctions.parameters', message: 'Parameters (comma separated)' })}
        value={parameters}
        onChange={setParameters}
        isReadOnly={readOnly}
      />
      <TextArea
        label={t({ id: 'namedFunctions.description', message: 'Description' })}
        value={description}
        onChange={setDescription}
        maxLength={10000}
        isReadOnly={readOnly}
      />
      <FormulaEditor
        options={FieldOptions.formula.parse({ expression: body })}
        fields={[]}
        isReadOnly={readOnly}
        bodyDefinition={input}
        namedFunctions={definitions.filter((item) => item.id !== definition?.id)}
        onChange={(options) => {
          if (!readOnly) setBody(options.expression);
        }}
      />
      <fieldset className="rio-named-functions__test">
        <legend>
          <Trans id="namedFunctions.test.title">Test function</Trans>
        </legend>
        <p>
          <Trans id="namedFunctions.test.hint">
            Enter a formula expression for each argument. Put text in quotes or use BLANK(). Tests do not
            change records.
          </Trans>
        </p>
        {input.parameters.map((parameter, index) => (
          <TextField
            key={`${parameter}-${index}`}
            label={t({ id: 'namedFunctions.test.argument', message: `Sample argument: ${parameter}` })}
            value={samples[parameter] ?? ''}
            onChange={(value) => setSamples((current) => ({ ...current, [parameter]: value }))}
          />
        ))}
        <Button
          {...anchor('namedFunctions.test')}
          isDisabled={!valid || input.parameters.some((parameter) => !samples[parameter]?.trim())}
          onPress={() =>
            setTested({
              signature,
              result: testFunction(
                input,
                definitions,
                definition?.id,
                input.parameters.map((parameter) => samples[parameter] ?? ''),
                Intl.DateTimeFormat().resolvedOptions().timeZone,
              ),
            })
          }
        >
          <Trans id="namedFunctions.test.run">Run test</Trans>
        </Button>
        <div role="status" aria-live="polite">
          {result &&
            ('error' in result
              ? message(result.error.messageKey, result.error.params)
              : t({ id: 'namedFunctions.test.result', message: `Result: ${JSON.stringify(result.value)}` }))}
        </div>
      </fieldset>
      <div className="rio-named-functions__actions">
        {!readOnly && (
          <Button type="submit" variant="primary" isDisabled={!valid || pending}>
            <Trans id="namedFunctions.save">Save function</Trans>
          </Button>
        )}
        <Button onPress={onCancel}>
          <Trans id="namedFunctions.cancel">Cancel</Trans>
        </Button>
        {definition && !readOnly && (
          <Button
            variant="danger"
            isDisabled={pending}
            onPress={onDelete}
            aria-label={t({ id: 'namedFunctions.delete', message: 'Delete function' })}
            icon={faTrashCan}
          />
        )}
      </div>
    </form>
  );
}
