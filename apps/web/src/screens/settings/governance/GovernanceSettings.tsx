import { faXmark, faPlus } from '@fortawesome/free-solid-svg-icons';
import { useSettingsDraft, useSettingsSection } from '../SettingsDraft';
import { Trans, useLingui } from '@lingui/react/macro';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useLocation, useNavigate, useSearch } from '@tanstack/react-router';
import { useEffect, useRef, useState } from 'react';
import {
  AUDIT_RETENTION_FLOOR_DAYS,
  CHOICE_COLORS,
  CLASSIFICATION_LIMIT,
  ClassificationRules,
  newId,
  type ClassificationLabel,
  type ClassificationTarget,
  type GovernanceAction,
  type GovernanceResult,
  type GovernanceView,
  RetentionPolicy,
} from '@riosoma/contracts';
import { Button, Spinner, TextField } from '@riosoma/ui';
import { api, ApiError } from '../../../api';
import { useSession } from '../../../session';
import { ErrorBanner } from '../../../shell/ErrorBanner';
import { errorInfo } from '../../setup/useSetup';
import { colorNames } from '../../database/colors/labels';
import { canManageSso } from '../sso/SsoSettings';
import './governance.css';
import { msg } from '@lingui/core/macro';
import { Setting, SettingItem, defineSettingsPage, defineSettingItems } from '../Setting';
import { activateSetting } from '../useSettingTarget';

const classificationPage = defineSettingsPage({
  area: 'admin',
  section: 'security',
  page: 'classification',
  label: msg({ id: 'governance.classification', message: 'Data classification' }),
  roles: ['security'],
  keywords: msg({
    id: 'settings.search.keywords.classification',
    message: 'classification labels privacy public export sharing',
  }),
});
const retentionPage = defineSettingsPage({
  area: 'admin',
  section: 'security',
  page: 'retention',
  label: msg({ id: 'governance.retention', message: 'Retention' }),
  roles: ['security'],
  keywords: msg({
    id: 'settings.search.keywords.retention',
    message: 'retention purging trash history comments audit legal hold',
  }),
});
const classificationSettings = defineSettingItems(classificationPage, {
  scope: { label: msg({ id: 'governance.scope', message: 'Apply to' }) },
  labels: {
    label: msg({ id: 'governance.classification', message: 'Data classification' }),
    help: msg({
      id: 'governance.classificationHelp',
      message:
        'Labels inherit from the database to its tables and fields.  A specific label overrides the inherited label.',
    }),
  },
});
const retentionSettings = defineSettingItems(retentionPage, {
  scope: { label: msg({ id: 'governance.scope', message: 'Apply to' }) },
  trashDays: { label: msg({ id: 'governance.trashDays', message: 'Trash' }) },
  historyDays: { label: msg({ id: 'governance.historyDays', message: 'Record history' }) },
  deletedCommentsDays: {
    label: msg({ id: 'governance.deletedCommentsDays', message: 'Comments on deleted records' }),
  },
  automationRunsDays: { label: msg({ id: 'governance.automationRunsDays', message: 'Automation run logs' }) },
  routineRunsDays: { label: msg({ id: 'governance.routineRunsDays', message: 'Routine run logs' }) },
  auditDays: { label: msg({ id: 'governance.auditDays', message: 'Audit events' }) },
  legalHold: {
    label: msg({ id: 'governance.legalHold', message: 'Legal hold—stop all purging for this database' }),
  },
});

export function GovernanceSettings({ mode }: { mode: 'classification' | 'retention' }) {
  const session = useSession();
  if (!canManageSso(session)) return <ErrorBanner error={{ key: 'errors.adminOnly' }} />;
  return mode === 'classification' ? (
    <Setting page={classificationPage} id="overview" label={classificationPage.label}>
      <Settings mode={mode} />
    </Setting>
  ) : (
    <Setting page={retentionPage} id="overview" label={retentionPage.label}>
      <Settings mode={mode} />
    </Setting>
  );
}

function Settings({ mode }: { mode: 'classification' | 'retention' }) {
  const { t } = useLingui();
  const search = useSearch({ strict: false });
  const navigate = useNavigate();
  const location = useLocation();
  const databaseId = search.database;
  const client = useQueryClient();
  const key = ['governance', databaseId ?? null];
  const current = useQuery({
    queryKey: key,
    queryFn: ({ signal }) =>
      api<GovernanceView>(
        `/api/admin/governance${databaseId ? `?databaseId=${encodeURIComponent(databaseId)}` : ''}`,
        { signal },
      ),
  });
  const openedScope = useRef('');
  useEffect(() => {
    if (mode !== 'retention' || !current.data || !location.pathname.endsWith('/legalHold')) {
      openedScope.current = '';
      return;
    }
    const key = `${location.pathname}:${databaseId ?? ''}`;
    if (openedScope.current === key) return;
    openedScope.current = key;
    // Changing scope replaces the target's control, so return focus after the query finishes.
    activateSetting(location.pathname);
  }, [mode, databaseId, current.data, location.pathname]);
  const [undoOf, setUndoOf] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const chooseDatabase = (database: string) => {
    setUndoOf(null);
    setSaved(false);
    void navigate({
      to: location.pathname,
      search: (previous) => ({ ...previous, database: database || undefined }),
    });
  };
  const save = useMutation({
    mutationFn: async (action: GovernanceAction | string) => {
      const id = newId('command');
      const result = await api<GovernanceResult>('/api/admin/governance/commands', {
        method: 'POST',
        body:
          typeof action === 'string'
            ? { kind: 'governance.undo', id, undoOf: action }
            : { kind: 'governance.apply', id, action },
      });
      if (result.error) throw new ApiError(400, result.error);
      return id;
    },
    onSuccess: async (id) => {
      setUndoOf(id);
      setSaved(true);
      await client.invalidateQueries({ queryKey: ['governance'] });
    },
  });
  return (
    <div className="rio-governance">
      <SettingItem
        definition={mode === 'classification' ? classificationSettings.scope : retentionSettings.scope}
        as="label"
        className="rio-governance__control"
      >
        <Trans id="governance.scope">Apply to</Trans>
        <select value={databaseId ?? ''} onChange={(event) => chooseDatabase(event.target.value)}>
          <option value="">
            <Trans id="governance.organization">Organization</Trans>
          </option>
          {current.data?.databases.map((database) => (
            <option key={database.id} value={database.id}>
              {database.name}
            </option>
          ))}
        </select>
      </SettingItem>
      <ErrorBanner error={errorInfo(current.error ?? save.error)} />
      {current.isPending ? (
        <Spinner />
      ) : current.data ? (
        <>
          {mode === 'classification' ? (
            <>
              <p>
                {t({
                  id: 'governance.classificationHelp',
                  message:
                    'Labels inherit from the database to its tables and fields.  A specific label overrides the inherited label.',
                })}
              </p>
              <SettingItem definition={classificationSettings.labels}>
                {databaseId ? (
                  <Assignments view={current.data} pending={save.isPending} save={save.mutateAsync} />
                ) : (
                  <Labels
                    key="labels"
                    initial={current.data.labels}
                    pending={save.isPending}
                    save={save.mutateAsync}
                  />
                )}
              </SettingItem>
            </>
          ) : (
            <Retention
              key={databaseId ?? 'organization'}
              view={current.data}
              databaseId={databaseId}
              pending={save.isPending}
              save={save.mutateAsync}
              chooseDatabase={chooseDatabase}
            />
          )}
          {undoOf ? (
            <Button isDisabled={save.isPending} onPress={() => save.mutate(undoOf)}>
              <Trans id="governance.undo">Undo last change</Trans>
            </Button>
          ) : null}
          <p role="status">{saved ? t({ id: 'governance.saved', message: 'Saved the policy' }) : ''}</p>
        </>
      ) : null}
    </div>
  );
}

function Labels({
  initial,
  pending: _pending,
  save,
}: {
  initial: ClassificationLabel[];
  pending: boolean;
  save: (action: GovernanceAction) => Promise<unknown>;
}) {
  const { t, i18n } = useLingui();
  const [labels, setLabels] = useState(initial);
  const pageDraft = useSettingsSection({
    dirty: JSON.stringify(labels) !== JSON.stringify(initial),
    stored: initial,
    discard: () => setLabels(initial),
    save: () => save({ kind: 'classification.labels', labels }),
    validate: () =>
      labels.some((label) => !label.name.trim())
        ? t({ id: 'governance.labelRequired', message: 'Enter a name for each classification label.' })
        : null,
  });
  const ruleNames: Record<keyof ClassificationRules, string> = {
    noPublicLinks: t({ id: 'governance.noPublicLinks', message: 'No public links or embedding' }),
    noExport: t({ id: 'governance.noExport', message: 'No export or download' }),
    noProviders: t({ id: 'governance.noProviders', message: 'Never send to providers' }),
    noExternalSharing: t({
      id: 'governance.noExternalSharing',
      message: 'No sharing outside the organization',
    }),
    maskGuests: t({ id: 'governance.maskGuests', message: 'Mask for guests' }),
  };
  const update = (id: string, patch: Partial<ClassificationLabel>) =>
    setLabels(labels.map((label) => (label.id === id ? { ...label, ...patch } : label)));
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        void pageDraft.save?.();
      }}
    >
      <p>
        {t({
          id: 'governance.labelLimit',
          message:
            'Define up to 12 classification labels.  Remove a label from its databases, tables, and fields before deleting it.',
        })}
      </p>
      {labels.map((label, index) => (
        <fieldset key={label.id} className="rio-governance__label">
          <legend>{t({ id: 'governance.labelNumber', message: `Label ${index + 1}` })}</legend>
          <TextField
            label={t({ id: 'governance.labelName', message: 'Label name' })}
            value={label.name}
            isRequired
            isInvalid={!label.name.trim()}
            errorMessage={t({
              id: 'governance.labelRequired',
              message: 'Enter a name for each classification label.',
            })}
            maxLength={80}
            onChange={(name) => update(label.id, { name })}
          />
          <TextField
            label={t({ id: 'governance.description', message: 'Description' })}
            value={label.description}
            maxLength={1000}
            onChange={(description) => update(label.id, { description })}
          />
          <label className="rio-governance__control">
            <Trans id="governance.color">Color</Trans>
            <select
              value={label.color}
              onChange={(event) =>
                update(label.id, { color: event.target.value as ClassificationLabel['color'] })
              }
            >
              {CHOICE_COLORS.map((color) => (
                <option key={color} value={color}>
                  {i18n._(colorNames[color])}
                </option>
              ))}
            </select>
          </label>
          {(Object.keys(ruleNames) as Array<keyof ClassificationRules>).map((rule) => (
            <label key={rule} className="rio-governance__check">
              <input
                type="checkbox"
                checked={label.rules[rule]}
                onChange={(event) =>
                  update(label.id, { rules: { ...label.rules, [rule]: event.target.checked } })
                }
              />
              {ruleNames[rule]}
            </label>
          ))}
          <Button
            onPress={() => setLabels(labels.filter((item) => item.id !== label.id))}
            aria-label={t({ id: 'governance.removeLabel', message: 'Remove label' })}
            icon={faXmark}
          />
        </fieldset>
      ))}
      <div className="rio-governance__actions">
        <Button
          isDisabled={labels.length >= CLASSIFICATION_LIMIT}
          onPress={() =>
            setLabels([
              ...labels,
              {
                id: crypto.randomUUID(),
                name: '',
                description: '',
                color: 'blue',
                rules: ClassificationRules.parse({}),
              },
            ])
          }
          aria-label={t({ id: 'governance.addLabel', message: 'Add label' })}
          icon={faPlus}
        />
      </div>
    </form>
  );
}

function Assignments({
  view,
  pending,
  save,
}: {
  view: GovernanceView;
  pending: boolean;
  save: (action: GovernanceAction) => Promise<unknown>;
}) {
  const { t } = useLingui();
  const draft = useSettingsDraft(view.assignments, async (assignments) => {
    for (const assignment of assignments) {
      const stored = view.assignments.find(
        (item) => JSON.stringify(item.target) === JSON.stringify(assignment.target),
      );
      if (stored?.labelId !== assignment.labelId)
        await save({ kind: 'classification.assign', ...assignment });
    }
  });
  const name = (target: ClassificationTarget) =>
    view.names[
      target.kind === 'database'
        ? target.databaseId
        : target.kind === 'table'
          ? target.tableId
          : target.fieldId
    ];
  return (
    <div className="rio-governance__assignments">
      {draft.value.map(({ target, labelId }) => (
        <label key={JSON.stringify(target)} className="rio-governance__control">
          {target.kind === 'database'
            ? t({ id: 'governance.databaseLabel', message: `Database: ${name(target)}` })
            : target.kind === 'table'
              ? t({ id: 'governance.tableLabel', message: `Table: ${name(target)}` })
              : t({ id: 'governance.fieldLabel', message: `Field: ${name(target)}` })}
          <select
            value={labelId ?? ''}
            disabled={pending}
            onChange={(event) =>
              draft.setValue((current) =>
                current.map((item) =>
                  JSON.stringify(item.target) === JSON.stringify(target)
                    ? { ...item, labelId: event.target.value || null }
                    : item,
                ),
              )
            }
          >
            <option value="">
              {target.kind === 'database'
                ? t({ id: 'governance.unclassified', message: 'No label' })
                : t({ id: 'governance.inherit', message: 'Inherit' })}
            </option>
            {view.labels.map((label) => (
              <option key={label.id} value={label.id}>
                {label.name}
              </option>
            ))}
          </select>
        </label>
      ))}
    </div>
  );
}

function Retention({
  view,
  databaseId,
  pending: _pending,
  save,
  chooseDatabase,
}: {
  view: GovernanceView;
  databaseId?: string;
  pending: boolean;
  save: (action: GovernanceAction) => Promise<unknown>;
  chooseDatabase: (database: string) => void;
}) {
  const { t, i18n } = useLingui();
  const [policy, setPolicy] = useState(view.policy);
  const [legalHold, setLegalHold] = useState(view.legalHold);
  const pageDraft = useSettingsSection({
    dirty:
      JSON.stringify({ policy, legalHold }) !==
      JSON.stringify({ policy: view.policy, legalHold: view.legalHold }),
    stored: { policy: view.policy, legalHold: view.legalHold },
    discard: () => {
      setPolicy(view.policy);
      setLegalHold(view.legalHold);
    },
    validate: () =>
      RetentionPolicy.safeParse(policy).success
        ? null
        : t({
            id: 'governance.retention.invalid',
            message: 'Enter whole numbers of days within the allowed retention periods.',
          }),
    save: () => save({ kind: 'retention.set', databaseId: databaseId ?? null, policy, legalHold }),
  });
  const names = Object.fromEntries(
    Object.entries(retentionSettings)
      .filter(([key]) => key !== 'scope' && key !== 'legalHold')
      .map(([key, setting]) => [key, i18n._(setting.label)]),
  ) as Record<keyof RetentionPolicy, string>;
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        void pageDraft.save?.();
      }}
    >
      <p>
        {t({
          id: 'governance.retentionHelp',
          message:
            'Choose how long to keep each kind of data.  Expired data is removed in batches.  Removing history also removes its undo actions.',
        })}
      </p>
      <p>
        {t({
          id: 'governance.auditFloor',
          message: `Audit events must be kept for at least ${AUDIT_RETENTION_FLOOR_DAYS} days.  Database policies can only extend the organization’s audit window.`,
        })}
      </p>
      {(Object.keys(names) as Array<keyof RetentionPolicy>).map((key) => (
        <SettingItem
          key={key}
          definition={retentionSettings[key]}
          as="fieldset"
          className="rio-governance__label"
        >
          <legend>{names[key]}</legend>
          <label className="rio-governance__control">
            <Trans id="governance.keepFor">Keep for</Trans>
            <select
              value={policy[key] === undefined ? 'inherit' : policy[key] === null ? 'forever' : 'days'}
              onChange={(event) => {
                const next = { ...policy };
                if (event.target.value === 'inherit') delete next[key];
                else
                  next[key] =
                    event.target.value === 'forever'
                      ? null
                      : (view.effective[key] ?? (key === 'auditDays' ? AUDIT_RETENTION_FLOOR_DAYS : 30));
                setPolicy(next);
              }}
            >
              <option value="inherit">
                {databaseId
                  ? t({ id: 'governance.organizationDefault', message: 'Organization default' })
                  : t({ id: 'governance.default', message: 'Default' })}
              </option>
              <option value="forever">
                <Trans id="governance.forever">Forever</Trans>
              </option>
              <option value="days">
                <Trans id="governance.days">Days</Trans>
              </option>
            </select>
          </label>
          {typeof policy[key] === 'number' ? (
            <label className="rio-governance__control">
              <Trans id="governance.numberOfDays">Number of days</Trans>
              <input
                type="number"
                required
                min={key === 'auditDays' ? AUDIT_RETENTION_FLOOR_DAYS : 1}
                max={36500}
                value={policy[key] ?? ''}
                aria-invalid={!RetentionPolicy.shape[key].safeParse(policy[key]).success}
                onChange={(event) => setPolicy({ ...policy, [key]: event.target.valueAsNumber })}
              />
              {!RetentionPolicy.shape[key].safeParse(policy[key]).success && (
                <span role="alert">
                  {t({
                    id: 'governance.retention.invalid',
                    message: 'Enter whole numbers of days within the allowed retention periods.',
                  })}
                </span>
              )}
            </label>
          ) : null}
          <p>
            {view.effective[key] === null
              ? t({ id: 'governance.effectiveForever', message: 'Currently kept forever' })
              : t({
                  id: 'governance.effectiveDays',
                  message: `Currently kept for ${view.effective[key]} days`,
                })}
          </p>
        </SettingItem>
      ))}
      <SettingItem definition={retentionSettings.legalHold}>
        {databaseId ? (
          <label className="rio-governance__check">
            <input
              type="checkbox"
              checked={legalHold}
              onChange={(event) => setLegalHold(event.target.checked)}
            />
            <Trans id="governance.legalHold">Legal hold—stop all purging for this database</Trans>
          </label>
        ) : (
          <>
            <p>
              <Trans id="governance.legalHoldScopeHelp">Choose a database to set a legal hold.</Trans>
            </p>
            <label className="rio-governance__control">
              <Trans id="governance.legalHoldDatabase">Database for legal hold</Trans>
              <select
                value=""
                disabled={!view.databases.length}
                onChange={(event) => chooseDatabase(event.target.value)}
              >
                <option value="">
                  <Trans id="governance.chooseDatabase">Choose a database</Trans>
                </option>
                {view.databases.map((database) => (
                  <option key={database.id} value={database.id}>
                    {database.name}
                  </option>
                ))}
              </select>
            </label>
            {!view.databases.length ? (
              <p>
                <Trans id="governance.noLegalHoldDatabases">
                  No databases are available for a legal hold.
                </Trans>
              </p>
            ) : null}
          </>
        )}
      </SettingItem>
    </form>
  );
}
