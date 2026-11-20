import { Trans, useLingui } from '@lingui/react/macro';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import type { OrgUnit, UnitAuditEntry } from '@riosoma/contracts';
import { Button, Disclosure, DisclosurePanel, DisclosureTrigger, Heading, Spinner, Text } from '@riosoma/ui';
import { api } from '../../../api';
import { ErrorBanner } from '../../../shell/ErrorBanner';
import { errorInfo } from '../../setup/useSetup';
import { auditLabels } from './labels';
import { membersQuery } from './UnitPeoplePanel';

const PAGE = 200;

/**
 * The audit entries about units.  An organization admin with the Audit role sees every one, and
 * a unit's Audit admin only those about the units their role reaches.
 */
export function UnitAuditPanel({ tree }: { tree: readonly OrgUnit[] }) {
  const { t, i18n } = useLingui();
  const members = useQuery(membersQuery);
  const entries = useInfiniteQuery({
    queryKey: ['org', 'unit-audit'],
    initialPageParam: null as string | null,
    queryFn: ({ pageParam, signal }) =>
      api<UnitAuditEntry[]>(
        `/api/org/unit-audit${pageParam ? `?before=${encodeURIComponent(pageParam)}` : ''}`,
        { signal },
      ),
    getNextPageParam: (last) => (last.length === PAGE ? (last[last.length - 1]?.id ?? null) : null),
  });
  const person = (id: string | null) => {
    if (!id) return t({ id: 'orgUnits.audit.provisioning', message: 'Provisioning' });
    const found = members.data?.find((member) => member.id === id);
    return found ? found.name || found.email : id;
  };
  const unitName = (id: unknown) =>
    typeof id === 'string' ? (tree.find((unit) => unit.id === id)?.name ?? id) : null;
  const rows = entries.data?.pages.flat() ?? [];
  return (
    <section className="rio-units__panel" aria-labelledby="unit-audit">
      <Heading level={2} id="unit-audit">
        <Trans id="orgUnits.audit.title">Unit activity</Trans>
      </Heading>
      {entries.isPending ? <Spinner /> : null}
      <ErrorBanner error={errorInfo(entries.error)} />
      {!entries.isPending && !rows.length ? (
        <Text variant="muted">
          <Trans id="orgUnits.audit.none">Nothing has happened in these units yet.</Trans>
        </Text>
      ) : null}
      <ul className="rio-units__list">
        {rows.map((entry) => {
          const label = auditLabels[entry.action];
          const what = label ? i18n._(label) : entry.action;
          const who = person(entry.actorId);
          const where = unitName(entry.metadata.unitId);
          const when = i18n.date(new Date(entry.at), { dateStyle: 'medium', timeStyle: 'short' });
          return (
            <li key={entry.id}>
              <Disclosure>
                <DisclosureTrigger>
                  {where
                    ? t({ id: 'orgUnits.audit.rowUnit', message: `${when}: ${what} in ${where}, by ${who}` })
                    : t({ id: 'orgUnits.audit.row', message: `${when}: ${what}, by ${who}` })}
                </DisclosureTrigger>
                <DisclosurePanel>
                  <pre className="rio-units__detail">{JSON.stringify(entry.metadata, null, 2)}</pre>
                </DisclosurePanel>
              </Disclosure>
            </li>
          );
        })}
      </ul>
      {entries.hasNextPage ? (
        <Button onPress={() => void entries.fetchNextPage()} isPending={entries.isFetchingNextPage}>
          <Trans id="orgUnits.audit.more">Show older activity</Trans>
        </Button>
      ) : null}
    </section>
  );
}
