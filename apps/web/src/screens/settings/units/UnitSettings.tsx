import { faPlus, faTrashCan } from '@fortawesome/free-solid-svg-icons';
import { useSettingsLeaveGuard } from '../SettingsDraft';
import { msg } from '@lingui/core/macro';
import { Setting, defineSettingsPage } from '../Setting';

import { useDropPreview } from '../../../data/drop-preview';
import { Trans, useLingui } from '@lingui/react/macro';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { useLocation, useRouter } from '@tanstack/react-router';
import { newId, UNIT_ADMIN_ROLES, UNIT_TREE_DEPTH, type OrgUnit } from '@riosoma/contracts';
import {
  Modal,
  Dialog,
  Button,
  ConfirmDialog,
  Form,
  FormActions,
  Heading,
  ListBoxItem,
  Select,
  Spinner,
  SortableTree,
  SortableItem,
  SortableDropZone,
  type SortableNode,
  type SortableLocation,
  Text,
  TextField,
  toast,
} from '@riosoma/ui';
import { useServerMessage } from '../../../messages/useServerMessage';
import { api, ApiError } from '../../../api';
import { useSession } from '../../../session';
import { ErrorBanner } from '../../../shell/ErrorBanner';
import { errorInfo } from '../../setup/useSetup';
import { canOpenUnits, organizationRole, ordered, reachOf, reaches, rolesAt, subtree } from './access';
import { OrganizationPolicyPanel, UnitPolicyPanel } from './PolicyPanels';
import { UnitAuditPanel } from './UnitAuditPanel';
import { unitsQuery } from './UnitFilter';
import { UnitMappingPanel } from './UnitMappingPanel';
import { UnitPeoplePanel, UnitSecurityPanel } from './UnitPeoplePanel';
import { OAuthGrants } from '../oauth/OAuthGrants';
import './units.css';

const settingsPage = defineSettingsPage({
  area: 'admin',
  section: 'organization',
  page: 'org-units',
  label: msg({ id: 'settings.nav.orgUnits', message: 'Organizational units' }),
  roles: ['units'],
  keywords: msg({
    id: 'settings.search.keywords.org-units',
    message: 'organizational units departments policies defaults',
  }),
});

const ORGANIZATION = 'organization';

/**
 * Organizational units: the tree, and for the selected unit its policy, its people, and its
 * admins.  Owners and People admins make the first unit here, and until they do, nothing else
 * about units shows anywhere.
 */
export function UnitSettings() {
  const session = useSession();
  if (!canOpenUnits(session)) return <ErrorBanner error={{ key: 'errors.adminOnly' }} />;
  return (
    <Setting
      page={settingsPage}
      id="overview"
      label={msg({ id: 'settings.nav.orgUnits', message: 'Organizational units' })}
    >
      {<Units />}
    </Setting>
  );
}

function Units() {
  const requestLeave = useSettingsLeaveGuard();
  const { t } = useLingui();
  const session = useSession();
  const cache = useQueryClient();
  const tree = useQuery(unitsQuery);
  const location = useLocation();
  const router = useRouter({ warn: false });
  const [pickedId, selectUnit] = useState<string | null>(() =>
    new URLSearchParams(window.location.hash.slice(1)).get('unit'),
  );
  useEffect(() => {
    const read = () => selectUnit(new URLSearchParams(window.location.hash.slice(1)).get('unit'));
    window.addEventListener('hashchange', read);
    window.addEventListener('popstate', read);
    return () => {
      window.removeEventListener('hashchange', read);
      window.removeEventListener('popstate', read);
    };
  }, []);
  const setSelectedId = (id: string | null) => {
    const address = new URL(window.location.href);
    address.hash = id ? new URLSearchParams({ unit: id }).toString() : '';
    const href = `${address.pathname}${address.search}${address.hash}`;
    if (router) router.history.push(href);
    else {
      window.history.pushState(window.history.state, '', href);
      selectUnit(id);
    }
  };
  const [pickedEditing, setEditing] = useState<OrgUnit | 'new' | null>();
  const [deleting, setDeleting] = useState<OrgUnit | null>(null);
  const units = tree.data ?? [];
  const linkedSetting = location.pathname.startsWith('/admin/organization/org-units/');
  const editingLink = linkedSetting && ['name', 'parent'].includes(location.pathname.split('/').at(-1)!);
  const peopleLink = linkedSetting && location.pathname.endsWith('/unit-people');
  const selectedHash = router
    ? new URLSearchParams(new URL(location.href, window.location.href).hash.slice(1)).get('unit')
    : pickedId;
  const selectedId =
    selectedHash ??
    (linkedSetting
      ? (units.find(
          (unit) =>
            rolesAt(session, units, unit.id, editingLink || peopleLink ? ['people'] : UNIT_ADMIN_ROLES)
              .length > 0,
        )?.id ?? null)
      : null);
  const people = reachOf(session, units, 'people');
  const selected = units.find((unit) => unit.id === selectedId) ?? null;
  const editing =
    pickedEditing === undefined && editingLink && (people === null || people.units.size)
      ? selected && reaches(people, selected.id)
        ? selected
        : 'new'
      : (pickedEditing ?? null);
  const refresh = async () => {
    await cache.invalidateQueries({ queryKey: ['org'] });
    await cache.invalidateQueries({ queryKey: ['session'] });
  };
  const remove = useMutation({
    mutationFn: (unit: OrgUnit) =>
      api<void>(`/api/org/units/${encodeURIComponent(unit.id)}`, { method: 'DELETE' }),
    onSuccess: async () => {
      setSelectedId(null);
      await refresh();
      toast.show({ tone: 'success', title: t({ id: 'orgUnits.deleted', message: 'Deleted the unit' }) });
    },
  });
  const message = useServerMessage();
  const check = useDropPreview();
  const move = useMutation({
    mutationFn: ({
      unitId,
      parentId,
      undoOf,
    }: {
      unitId: string;
      parentId: string | null;
      undoOf?: string;
    }) =>
      api<{ id: string }>(`/api/org/units/${encodeURIComponent(unitId)}/move`, {
        method: 'POST',
        body: { id: newId('command'), parentId, undoOf },
      }),
    onSuccess: async (result, input) => {
      await refresh();
      toast.show({
        title: t({ id: 'orgUnits.moved', message: 'Moved the unit' }),
        tone: 'success',
        action: {
          label: t({ id: 'common.undo', message: 'Undo' }),
          onPress: () => move.mutate({ ...input, undoOf: result.id }),
        },
      });
    },
  });
  const nodes = (parentId: string | null): SortableNode<{ name: string }>[] =>
    units
      .filter(
        (unit) => (units.some((parent) => parent.id === unit.parentId) ? unit.parentId : null) === parentId,
      )
      .map((unit) => ({ id: unit.id, data: { name: unit.name }, children: nodes(unit.id) }));
  const dropReason = (unitId: string, target: SortableLocation) => {
    if (!reaches(people, unitId, true) || !reaches(people, target.parentId))
      return t({ id: 'orgUnits.moveDenied', message: 'You need permission to manage both units.' });
    if (units.find((unit) => unit.id === unitId)?.parentId === target.parentId)
      return t({
        id: 'orgUnits.alphabetical',
        message: 'Units are listed alphabetically.  Drop on a unit to change the parent.',
      });
    const key = JSON.stringify([unitId, target.parentId]);
    const preview = check(
      tree.data,
      key,
      () =>
        api(`/api/org/units/${encodeURIComponent(unitId)}/move`, {
          method: 'POST',
          body: { id: newId('command'), parentId: target.parentId, preview: true },
        }),
      (error) =>
        error instanceof ApiError
          ? message(error.info.messageKey, error.info.params)
          : message('errors.offline'),
    );
    return preview.pending ? undefined : preview.reason;
  };
  if (tree.isPending) return <Spinner />;
  const organizationAudit = organizationRole(session, 'audit');
  const anyAudit =
    organizationAudit ||
    Boolean(session?.membership.unitAdminGrants?.some((grant) => grant.roles.includes('audit')));
  const organizationAdmin = UNIT_ADMIN_ROLES.some((role) => organizationRole(session, role));
  // The organization's Integrations admins see every connection under OAuth apps.
  const unitIntegrations =
    !organizationRole(session, 'integrations') &&
    Boolean(session?.membership.unitAdminGrants?.some((grant) => grant.roles.includes('integrations')));
  const selectedRoles = selected ? rolesAt(session, units, selected.id, UNIT_ADMIN_ROLES) : [];
  return (
    <div className="rio-units">
      <Text variant="muted">
        <Trans id="orgUnits.intro">
          {
            'Units are departments, schools, or regions inside the organization, up to eight levels deep.  Each person is in one unit or in none, and a unit can have admins of its own and settings of its own, within the limits the organization sets.'
          }
        </Trans>
      </Text>
      <ErrorBanner error={errorInfo(tree.error ?? move.error)} />
      <section className="rio-units__panel" aria-labelledby="unit-tree">
        <Heading level={2} id="unit-tree">
          <Trans id="orgUnits.tree.title">Units</Trans>
        </Heading>
        {units.length ? (
          <SortableTree
            items={nodes(null)}
            maxDepth={UNIT_TREE_DEPTH}
            anchorDisabledItems={false}
            dropReason={dropReason}
            disabledReason={
              move.isPending
                ? t({ id: 'home.arrange.saving', message: 'Wait for the current change to finish.' })
                : undefined
            }
            onMove={(unitId, target) => move.mutate({ unitId, parentId: target.parentId })}
          >
            <ul className="rio-units__tree">
              {ordered(units).map(({ unit, depth }) => {
                const name = unit.name;
                return (
                  <SortableItem
                    id={unit.id}
                    key={unit.id}
                    className="rio-units__row"
                    renderWrapper={(props, children) => (
                      <li
                        {...props}
                        data-selected={unit.id === selectedId}
                        style={{ paddingInlineStart: `calc(${depth} * var(--rio-space-6))` }}
                      >
                        {children}
                      </li>
                    )}
                  >
                    <>
                      <Button
                        variant="quiet"
                        className="rio-units__grow"
                        aria-pressed={unit.id === selectedId}
                        onPress={() => {
                          void requestLeave().then((accepted) => {
                            if (accepted) setSelectedId(unit.id === selectedId ? null : unit.id);
                          });
                        }}
                      >
                        <span className="rio-units__name" title={unit.name}>
                          {unit.name}
                        </span>
                      </Button>
                      {reaches(people, unit.id, true) ? (
                        <>
                          <Button
                            size="sm"
                            variant="quiet"
                            className="rio-units__edit"
                            aria-label={t({ id: 'orgUnits.editNamed', message: `Rename or move ${name}` })}
                            onPress={() => setEditing(unit)}
                          >
                            <Trans id="orgUnits.edit">Rename or move</Trans>
                          </Button>
                          <Button
                            size="sm"
                            variant="quiet"
                            aria-label={t({ id: 'orgUnits.deleteNamed', message: `Delete ${name}` })}
                            onPress={() => setDeleting(unit)}
                            icon={faTrashCan}
                          />
                        </>
                      ) : null}
                    </>
                  </SortableItem>
                );
              })}
            </ul>
            <SortableDropZone />
          </SortableTree>
        ) : (
          <Text>
            <Trans id="orgUnits.tree.none">
              {
                'There are no units yet.  Nothing about units shows anywhere else until you make the first one.'
              }
            </Trans>
          </Text>
        )}
        {people === null || people.units.size ? (
          <Button
            icon={faPlus}
            aria-label={t({ id: 'orgUnits.create', message: 'Make a unit' })}
            onPress={() => setEditing('new')}
          />
        ) : null}
        {editing ? (
          <Modal
            isOpen
            onOpenChange={(open) => {
              if (!open) setEditing(null);
            }}
          >
            <Dialog>
              <UnitForm
                key={editing === 'new' ? 'new' : editing.id}
                units={units}
                unit={editing === 'new' ? null : editing}
                parentId={editing === 'new' ? (selected?.id ?? null) : null}
                onDone={async (unit) => {
                  setEditing(null);
                  if (unit) {
                    setSelectedId(unit.id);
                    await refresh();
                  }
                }}
              />
            </Dialog>
          </Modal>
        ) : null}
      </section>
      {selected ? (
        <div className="rio-units__selected">
          <Heading level={2}>{selected.name}</Heading>
          {selectedRoles.length ? (
            <UnitPolicyPanel key={`policy-${selected.id}`} unit={selected} tree={units} />
          ) : (
            <Text variant="muted">
              <Trans id="orgUnits.outside">None of your admin roles reach this unit.</Trans>
            </Text>
          )}
          {selectedRoles.includes('people') ? (
            <UnitPeoplePanel key={`people-${selected.id}`} unit={selected} tree={units} />
          ) : null}
          {selectedRoles.includes('security') ? <UnitSecurityPanel unit={selected} /> : null}
        </div>
      ) : null}
      {units.length && organizationAdmin ? <OrganizationPolicyPanel /> : null}
      {units.length && organizationRole(session, 'security') && organizationRole(session, 'people') ? (
        <UnitMappingPanel tree={units} />
      ) : null}
      {units.length && anyAudit ? <UnitAuditPanel tree={units} /> : null}
      {units.length && unitIntegrations ? (
        <section className="rio-units__panel" aria-labelledby="unit-connections">
          <Heading level={2} id="unit-connections">
            <Trans id="orgUnits.connections.title">Apps connected by people in your units</Trans>
          </Heading>
          <OAuthGrants admin />
        </section>
      ) : null}
      {deleting ? (
        <ConfirmDialog
          isOpen
          title={t({ id: 'orgUnits.delete.title', message: 'Delete this unit?' })}
          message={t({
            id: 'orgUnits.delete.message',
            message:
              'Its people and the units below it move up to the unit above, or to the organization.  Its admins stop being admins, and its own settings go with it.',
          })}
          confirmLabel={t({ id: 'orgUnits.delete.confirm', message: 'Delete unit' })}
          tone="danger"
          onOpenChange={(open) => {
            if (!open) setDeleting(null);
          }}
          onConfirm={() => remove.mutateAsync(deleting)}
        />
      ) : null}
      <ErrorBanner error={errorInfo(remove.error)} />
    </div>
  );
}

/** Making a unit, or renaming or moving one, within the units the People role reaches */
function UnitForm({
  units,
  unit,
  parentId,
  onDone,
}: {
  units: readonly OrgUnit[];
  unit: OrgUnit | null;
  parentId: string | null;
  onDone: (unit: OrgUnit | null) => void;
}) {
  const { t } = useLingui();
  const session = useSession();
  const people = reachOf(session, units, 'people');
  const [name, setName] = useState(unit?.name ?? '');
  const [parent, setParent] = useState<string | null>(
    unit ? unit.parentId : parentId && reaches(people, parentId) ? parentId : null,
  );
  const save = useMutation({
    mutationFn: () =>
      unit
        ? api<OrgUnit>(`/api/org/units/${encodeURIComponent(unit.id)}`, {
            method: 'PUT',
            body: { name: name.trim(), parentId: parent },
          })
        : api<OrgUnit>('/api/org/units', { body: { name: name.trim(), parentId: parent } }),
    onSuccess: (saved) => onDone(saved),
  });
  // A unit can't sit below itself, and the tree stops at eight levels.
  const own = unit ? subtree(units, unit.id) : new Set<string>();
  const depths = new Map(ordered(units).map(({ unit: item, depth }) => [item.id, depth]));
  const parents = ordered(units).filter(
    ({ unit: item, depth }) => !own.has(item.id) && reaches(people, item.id) && depth + 1 < UNIT_TREE_DEPTH,
  );
  const topLevel = people === null;
  const choice = parent ?? ORGANIZATION;
  const organizationName = session?.org.name ?? '';
  return (
    <Form
      className="rio-units__form"
      onSubmit={(event) => {
        event.preventDefault();
        if (name.trim() && !save.isPending) save.mutate();
      }}
    >
      <Heading level={3} slot="title">
        {unit
          ? t({ id: 'orgUnits.edit', message: 'Rename or move' })
          : t({ id: 'orgUnits.create', message: 'Make a unit' })}
      </Heading>
      <Setting
        page={settingsPage}
        id="name"
        label={msg({ id: 'orgUnits.name', message: 'Name' })}
        roles={['people']}
      >
        <TextField
          label={t({ id: 'orgUnits.name', message: 'Name' })}
          value={name}
          onChange={setName}
          isRequired
        />
      </Setting>
      <Setting
        page={settingsPage}
        id="parent"
        label={msg({ id: 'orgUnits.parent', message: 'Inside' })}
        roles={['people']}
      >
        <Select
          label={t({ id: 'orgUnits.parent', message: 'Inside' })}
          selectedKey={choice}
          onSelectionChange={(key) => setParent(key === ORGANIZATION ? null : String(key))}
        >
          {[
            ...(topLevel || !unit?.parentId
              ? [
                  <ListBoxItem
                    key={ORGANIZATION}
                    id={ORGANIZATION}
                    textValue={organizationName}
                    isDisabled={!topLevel}
                  >
                    {organizationName}
                  </ListBoxItem>,
                ]
              : []),
            ...parents.map(({ unit: item }) => (
              <ListBoxItem key={item.id} id={item.id} textValue={item.name}>
                {`${' '.repeat((depths.get(item.id) ?? 0) + 1)}${item.name}`}
              </ListBoxItem>
            )),
          ]}
        </Select>
      </Setting>
      <ErrorBanner error={errorInfo(save.error)} />
      <FormActions>
        <Button variant="quiet" onPress={() => onDone(null)}>
          <Trans id="orgUnits.cancel">Cancel</Trans>
        </Button>
        <Button
          type="submit"
          variant="primary"
          isDisabled={!name.trim() || (!topLevel && parent === null)}
          isPending={save.isPending}
        >
          <Trans id="orgUnits.save">Save</Trans>
        </Button>
      </FormActions>
    </Form>
  );
}
