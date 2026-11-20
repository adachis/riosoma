import { useState } from 'react';
import { Trans } from '@lingui/react/macro';
import type { SourceColumn, SourceConnection, SourceSecrets } from '@riosoma/contracts';
import { Button } from '@riosoma/ui';
import { api } from '../../../api';

export function GraphQlSuggestions({
  sourceId,
  connection,
  secrets,
  disabled,
}: {
  sourceId?: string;
  connection: SourceConnection | null;
  secrets: SourceSecrets;
  disabled: boolean;
}) {
  const [fields, setFields] = useState<SourceColumn[]>([]);
  const [pending, setPending] = useState(false);
  const [failed, setFailed] = useState(false);
  async function load() {
    setPending(true);
    setFailed(false);
    setFields([]);
    try {
      const result = await api<SourceColumn[]>(
        sourceId
          ? `/api/sources/${encodeURIComponent(sourceId)}/graphql-suggestions`
          : '/api/sources/graphql-suggestions',
        { body: sourceId ? {} : { connection, secrets } },
      );
      setFields(result);
    } catch {
      setFailed(true);
    } finally {
      setPending(false);
    }
  }
  return (
    <section>
      <Button onPress={() => void load()} isDisabled={disabled || pending}>
        <Trans id="sources.graphql.suggest">Suggest fields</Trans>
      </Button>
      <div role="status" aria-live="polite">
        {pending ? <Trans id="sources.graphql.suggest.loading">Loading fields…</Trans> : null}
        {failed ? (
          <Trans id="sources.graphql.suggest.failed">
            Check the connection and introspection permissions to load field suggestions.
          </Trans>
        ) : null}
      </div>
      {fields.length ? (
        <ul>
          {fields.map((field) => (
            <li key={field.name}>
              <code>{field.name}</code> <span>{field.sourceType}</span>
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}
