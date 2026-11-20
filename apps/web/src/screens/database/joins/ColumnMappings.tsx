import {
  faArrowDown,
  faArrowUp,
  faCheck,
  faCodeBranch,
  faPlus,
  faXmark,
} from '@fortawesome/free-solid-svg-icons';
import { useState } from 'react';
import { useLingui } from '@lingui/react/macro';
import { useQuery } from '@tanstack/react-query';
import {
  mappedFieldSpec,
  type ColumnSuggestions,
  type ColumnSuggestionsRequest,
  type JoinedSource,
} from '@riosoma/contracts';
import { Banner, Button, ListBoxItem, Select, TextField } from '@riosoma/ui';
import { api } from '../../../api';
import { useSchema, type DatabaseSession } from '../../../data';

export interface MappingDraft {
  sources: JoinedSource[];
  name: string;
}

export function ColumnMappings({
  session,
  input,
  mappings,
  onChange,
  onInclude,
  showTitle = true,
}: {
  session: DatabaseSession;
  input: ColumnSuggestionsRequest;
  mappings: MappingDraft[];
  onChange(value: MappingDraft[]): void;
  onInclude(ids: string[]): void;
  showTitle?: boolean;
}) {
  const { t } = useLingui();
  const schema = useSchema(session)!;
  const [first, setFirst] = useState('');
  const [second, setSecond] = useState('');
  const [rejected, setRejected] = useState<string[]>([]);
  const [problem, setProblem] = useState(false);
  const ready = input.steps.every((step) => step.tableId && step.leftFieldId && step.rightFieldId);
  const proposals = useQuery({
    queryKey: ['column-suggestions', session.databaseId, input],
    enabled: ready,
    queryFn: ({ signal }) =>
      api<ColumnSuggestions>(`/api/databases/${session.databaseId}/column-suggestions`, {
        method: 'POST',
        body: input,
        signal,
      }),
    retry: false,
  });
  const inputs = [input.baseTableId, ...input.steps.map((step) => step.tableId)];
  const fields = inputs
    .flatMap((id) => schema.fields.get(id) ?? [])
    .filter((field) => !['button', 'changeLog'].includes(field.type));
  const label = (source: JoinedSource) => {
    const table = schema.tableById.get(source.tableId)?.name ?? '';
    const field = schema.fieldById.get(source.fieldId)?.name ?? '';
    return t({ id: 'joined.fieldLabel', message: `${table} ${field}` });
  };
  const key = (sources: JoinedSource[]) => sources.map((source) => source.fieldId).join('|');
  const accept = (sources: JoinedSource[], current = mappings): MappingDraft[] => {
    const overlapping = current.filter((item) =>
      item.sources.some((source) => sources.some((next) => next.fieldId === source.fieldId)),
    );
    const ordered = [
      ...new Map(
        [...overlapping.flatMap((item) => item.sources), ...sources].map((source) => [
          source.fieldId,
          source,
        ]),
      ).values(),
    ];
    if (!mappedFieldSpec(ordered.map((source) => schema.fieldById.get(source.fieldId)!))) {
      setProblem(true);
      return current;
    }
    setProblem(false);
    onInclude(ordered.map((source) => source.fieldId));
    return [
      ...current.filter((item) => !overlapping.includes(item)),
      {
        sources: ordered,
        name: overlapping[0]?.name ?? schema.fieldById.get(ordered[0]!.fieldId)!.name,
      },
    ];
  };
  const suggestions = (proposals.data?.suggestions ?? []).filter(
    (item) =>
      !rejected.includes(key(item.sources)) &&
      !mappings.some((mapping) =>
        item.sources.every((source) => mapping.sources.some((own) => own.fieldId === source.fieldId)),
      ),
  );
  return (
    <fieldset
      className="rio-joined-step"
      aria-label={
        showTitle ? undefined : t({ id: 'joined.mapping.title', message: 'Map corresponding columns' })
      }
    >
      {showTitle && (
        <legend>{t({ id: 'joined.mapping.title', message: 'Map corresponding columns' })}</legend>
      )}
      <p>
        {t({
          id: 'joined.mapping.help',
          message:
            'One output column uses the first source with a value.  The first table comes first by default.',
        })}
      </p>
      {proposals.isFetching && (
        <p role="status">{t({ id: 'joined.mapping.profiling', message: 'Comparing joined values…' })}</p>
      )}
      {proposals.isError && (
        <Banner tone="info">
          {t({
            id: 'joined.mapping.unavailable',
            message: 'Column suggestions are unavailable.  You can add a mapping below.',
          })}
        </Banner>
      )}
      {problem && (
        <Banner tone="warning">
          {t({
            id: 'joined.mapping.lossy',
            message:
              'These sources cannot share a column without losing information.  Choose compatible types or keep them separate.',
          })}
        </Banner>
      )}
      {suggestions.length > 0 && (
        <Button
          onPress={() => {
            let next = mappings;
            let refused = false;
            for (const proposal of suggestions) {
              const previous = next;
              next = accept(proposal.sources, next);
              refused ||= next === previous;
            }
            setProblem(refused);
            onChange(next);
          }}
        >
          {t({ id: 'joined.mapping.acceptAll', message: 'Accept all mappings' })}
        </Button>
      )}
      {suggestions.map((proposal) => {
        const name = proposal.sources.map(label).join(', ');
        const percent = proposal.reason.params?.percent ?? 100;
        const confidence = Math.round(proposal.confidence * 100);
        const reason =
          proposal.reason.messageKey === 'joined.mapping.keys'
            ? t({ id: 'joined.mapping.keys', message: 'Key columns for this join.' })
            : proposal.reason.messageKey === 'joined.mapping.complementary'
              ? t({
                  id: 'joined.mapping.complementary',
                  message: 'Matching names and complementary values across unmatched full-join rows.',
                })
              : t({
                  id: 'joined.mapping.agreement',
                  message: `Same values in ${percent}% of matching rows.`,
                });
        return (
          <div className="rio-mapping-proposal" key={key(proposal.sources)}>
            <div>
              <strong>{name}</strong>
              <p>
                {reason} {t({ id: 'joined.mapping.confidence', message: `${confidence}% confidence` })}
              </p>
            </div>
            <Button
              icon={faCheck}
              aria-label={t({ id: 'joined.mapping.accept', message: `Accept mapping for ${name}` })}
              onPress={() => onChange(accept(proposal.sources))}
            />
            <Button
              icon={faXmark}
              aria-label={t({ id: 'joined.mapping.reject', message: `Reject mapping for ${name}` })}
              onPress={() => setRejected((current) => [...current, key(proposal.sources)])}
            />
          </div>
        );
      })}
      {mappings.map((mapping, index) => (
        <fieldset className="rio-joined-step" key={key(mapping.sources)}>
          <legend>{mapping.name}</legend>
          <TextField
            label={t({ id: 'joined.mapping.outputName', message: 'Output column name' })}
            value={mapping.name}
            onChange={(name) =>
              onChange(mappings.map((item, at) => (at === index ? { ...item, name } : item)))
            }
          />
          <ol className="rio-mapping-sources">
            {mapping.sources.map((source, at) => (
              <li key={source.fieldId}>
                <span>{label(source)}</span>
                <Button
                  icon={faArrowUp}
                  isDisabled={at === 0}
                  aria-label={t({ id: 'joined.mapping.up', message: `Move ${label(source)} up` })}
                  onPress={() => {
                    const sources = [...mapping.sources];
                    [sources[at - 1], sources[at]] = [sources[at]!, sources[at - 1]!];
                    onChange(mappings.map((item, own) => (own === index ? { ...item, sources } : item)));
                  }}
                />
                <Button
                  icon={faArrowDown}
                  isDisabled={at === mapping.sources.length - 1}
                  aria-label={t({ id: 'joined.mapping.down', message: `Move ${label(source)} down` })}
                  onPress={() => {
                    const sources = [...mapping.sources];
                    [sources[at], sources[at + 1]] = [sources[at + 1]!, sources[at]!];
                    onChange(mappings.map((item, own) => (own === index ? { ...item, sources } : item)));
                  }}
                />
              </li>
            ))}
          </ol>
          <Button
            icon={faCodeBranch}
            aria-label={t({
              id: 'joined.mapping.split',
              message: `Split ${mapping.name} into separate columns`,
            })}
            onPress={() => onChange(mappings.filter((_, at) => at !== index))}
          />
        </fieldset>
      ))}
      <Select
        label={t({ id: 'joined.mapping.firstColumn', message: 'First column to map' })}
        selectedKey={first || null}
        onSelectionChange={(id) => {
          setFirst(String(id));
          setSecond('');
        }}
      >
        {fields.map((field) => (
          <ListBoxItem id={field.id} key={field.id}>
            {label({ tableId: field.tableId, fieldId: field.id })}
          </ListBoxItem>
        ))}
      </Select>
      <Select
        label={t({ id: 'joined.mapping.secondColumn', message: 'Second column to map' })}
        selectedKey={second || null}
        onSelectionChange={(id) => setSecond(String(id))}
      >
        {fields
          .filter((field) => field.tableId !== schema.fieldById.get(first)?.tableId)
          .map((field) => (
            <ListBoxItem id={field.id} key={field.id}>
              {label({ tableId: field.tableId, fieldId: field.id })}
            </ListBoxItem>
          ))}
      </Select>
      <Button
        icon={faPlus}
        aria-label={t({ id: 'joined.mapping.add', message: 'Add column mapping' })}
        isDisabled={!first || !second}
        onPress={() => {
          onChange(
            accept(
              [first, second].map((id) => ({ tableId: schema.fieldById.get(id)!.tableId, fieldId: id })),
            ),
          );
          setFirst('');
          setSecond('');
        }}
      />
    </fieldset>
  );
}
