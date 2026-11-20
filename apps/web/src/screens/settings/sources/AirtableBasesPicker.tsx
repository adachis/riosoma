import { useEffect, useRef, useState } from 'react';
import { Trans, useLingui } from '@lingui/react/macro';
import type { AirtableSourceBase } from '@riosoma/contracts';
import {
  Banner,
  Button,
  Checkbox,
  CheckboxGroup,
  Heading,
  SearchField,
  FilterableList,
  normalizeFilter,
  Text,
} from '@riosoma/ui';
import { ApiError } from '../../../api';
import { useServerMessage } from '../../../messages/useServerMessage';
import './sources.css';

/** Reads the bases a token sees, in one listing. */
export type AirtableBasesLoader = (signal: AbortSignal) => Promise<AirtableSourceBase[]>;

/** A short list of bases fits the compact checkbox layout */
const COMPACT_LIMIT = 8;

export interface AirtableBasesPickerProps {
  /** The chosen bases' IDs, in the order they were chosen */
  chosen: readonly string[];
  onChange(bases: string[]): void;
  /** Lists the token's bases, or null while there's no token to list them with */
  load: AirtableBasesLoader | null;
  /** Why the bases can't be listed yet, when `load` is null */
  blocked?: string;
  /** Translated text for a server refusal of the chosen bases */
  errorMessage?: string;
  isDisabled?: boolean;
}

/**
 * The bases an Airtable source offers.  A token often reaches far more bases than anyone means to
 * sync, so an admin lists them once and checks the ones whose tables people may sync.  A chosen
 * base the listing doesn't name, like one a saved source chose before its token lost it, stays in
 * the list by its ID so it can be unchecked.
 */
export function AirtableBasesPicker({
  chosen,
  onChange,
  load,
  blocked,
  errorMessage,
  isDisabled,
}: AirtableBasesPickerProps) {
  const { t } = useLingui();
  const message = useServerMessage();
  // Each listing remembers the loader it came from, since a different token lists different bases,
  // and one made with an old token no longer counts.
  const [listing, setListing] = useState<{
    load: AirtableBasesLoader;
    pending: boolean;
    bases: AirtableSourceBase[] | null;
    failed: string | null;
  } | null>(null);
  const [search, setSearch] = useState('');
  const running = useRef<AbortController | null>(null);
  useEffect(() => () => running.current?.abort(), [load]);
  const current = listing && listing.load === load ? listing : null;
  const bases = current?.bases ?? null;

  async function list() {
    if (!load) return;
    running.current?.abort();
    const controller = new AbortController();
    running.current = controller;
    setListing({ load, pending: true, bases, failed: null });
    try {
      const found = await load(controller.signal);
      if (!controller.signal.aborted) setListing({ load, pending: false, bases: found, failed: null });
    } catch (error) {
      if (!controller.signal.aborted)
        setListing({
          load,
          pending: false,
          bases,
          failed: error instanceof ApiError ? error.info.messageKey : 'errors.internal',
        });
    }
  }

  const named = new Map((bases ?? []).map((base) => [base.id, base.name]));
  const options = [
    ...(bases ?? []),
    ...chosen.filter((id) => !named.has(id)).map((id) => ({ id, name: id })),
  ];
  const needle = normalizeFilter(search.trim());
  const shown = needle
    ? options.filter(
        (base) =>
          chosen.includes(base.id) ||
          normalizeFilter(base.name).includes(needle) ||
          base.id.toLocaleLowerCase().includes(needle),
      )
    : options;

  return (
    <section
      className="rio-sources__bases"
      aria-label={t({ id: 'sources.airtable.bases', message: 'Bases' })}
    >
      <Heading level={4}>
        <Trans id="sources.airtable.bases">Bases</Trans>
      </Heading>
      <Text variant="muted">
        <Trans id="sources.airtable.bases.hint">
          People can sync the tables of the bases you choose here, and no others.
        </Trans>
      </Text>
      <div className="rio-sources__bases-actions">
        <Button
          onPress={() => void list()}
          isPending={current?.pending ?? false}
          isDisabled={isDisabled || !load}
        >
          {bases ? (
            <Trans id="sources.airtable.bases.refresh">List the bases again</Trans>
          ) : (
            <Trans id="sources.airtable.bases.list">List the token’s bases</Trans>
          )}
        </Button>
        {load ? null : blocked ? <Text variant="muted">{blocked}</Text> : null}
      </div>
      {current?.failed ? <Banner tone="danger">{message(current.failed)}</Banner> : null}
      {bases && bases.length === 0 ? (
        <Text>
          {t({
            id: 'sources.airtable.bases.none',
            message:
              'The token can’t see any bases.  In Airtable’s builder hub, add the bases people should sync to the token.',
          })}
        </Text>
      ) : null}
      {options.length > COMPACT_LIMIT ? (
        <FilterableList
          listId="sources.airtable.bases"
          keepSelectedVisible
          label={t({ id: 'sources.airtable.bases.chosen', message: 'Bases to offer' })}
          description={
            chosen.length
              ? undefined
              : t({ id: 'sources.airtable.bases.required', message: 'Choose at least one base.' })
          }
          filterLabel={t({ id: 'sources.airtable.bases.search', message: 'Search bases' })}
          items={options}
          selectedKeys={chosen}
          selectionMode="multiple"
          onSelectionChange={(keys) => onChange([...keys].map(String))}
          isDisabled={isDisabled}
          isInvalid={Boolean(errorMessage)}
          errorMessage={errorMessage}
        />
      ) : options.length ? (
        <>
          <SearchField
            label={t({ id: 'sources.airtable.bases.search', message: 'Search bases' })}
            value={search}
            onChange={setSearch}
            isDisabled={isDisabled}
          />

          <CheckboxGroup
            label={t({ id: 'sources.airtable.bases.chosen', message: 'Bases to offer' })}
            description={
              chosen.length
                ? undefined
                : t({ id: 'sources.airtable.bases.required', message: 'Choose at least one base.' })
            }
            value={[...chosen]}
            // The order they were chosen in is kept, since the first one is the one a test reads.
            onChange={(value) => onChange([...new Set(value)])}
            isDisabled={isDisabled}
            isInvalid={Boolean(errorMessage)}
            errorMessage={errorMessage}
            className="rio-sources__bases-list"
          >
            {shown.map((base) => (
              <Checkbox key={base.id} value={base.id}>
                {base.name}
              </Checkbox>
            ))}
          </CheckboxGroup>
        </>
      ) : null}
    </section>
  );
}
