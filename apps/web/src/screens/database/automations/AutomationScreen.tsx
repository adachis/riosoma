import { HelpButton } from '../../../docs/HelpButton';
import { flattenAutomationSteps } from '@riosoma/contracts';
import { faPlay, faRoute } from '@fortawesome/free-solid-svg-icons';
import { Trans, useLingui } from '@lingui/react/macro';
import { LIMITS, roleAllows } from '@riosoma/contracts';
import type { AutomationMeta, AutomationRun } from '@riosoma/contracts';
import {
  Banner,
  Button,
  ComboBox,
  ListBoxItem,
  Switch,
  Tab,
  TabList,
  TabPanel,
  Tabs,
  TextField,
} from '@riosoma/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useId, useRef, useState } from 'react';
import { api, ApiError } from '../../../api';
import type { DatabaseSession, SchemaState } from '../../../data/types';
import { reportError, undoAction } from '../../../grid/view/actions';
import { serverMessage, useServerMessage } from '../../../messages/useServerMessage';
import { AutomationFlow } from './AutomationFlow';
import { useAutomationDraft } from './draft';
import { triggerTableId } from './model';
import { RunHistory, RunSteps, RunSummary, runsKey } from './RunHistory';
import { SimulatorPanel, useSimulation } from './Simulator';
import { StepTestPanel } from './StepTestPanel';
import { DraftBar, Versions } from './Versions';
import { useCelebrations } from '../../../features/celebrations/useCelebrations';
import { ResponsiveToolbar } from '../../../components/ResponsiveToolbar';
import './automations.css';

const NEWEST = '#newest';

export interface AutomationScreenProps {
  session: DatabaseSession;
  schema: SchemaState;
  automation: AutomationMeta;
}

/**
 * One automation: its name, whether it's on, its flow of cards, a test run, its run history, and
 * its versions.  The cards edit the draft, which a badge marks until it's published, and tests run
 * what's on the cards.  People who can't change the schema see the published version without the
 * controls.
 */
export function AutomationScreen({ session, schema, automation }: AutomationScreenProps) {
  const { t, i18n } = useLingui();
  const message = useServerMessage();
  const client = useQueryClient();
  const canEdit = roleAllows(session.role(), 'editSchema');
  const { config, change, save, discard } = useAutomationDraft(session, automation);
  const [tab, setTab] = useState(() => {
    const hash = new URLSearchParams(window.location.hash.slice(1));
    const tab = hash.get('tab');
    return hash.get('automation') === automation.id && (tab === 'runs' || tab === 'versions') ? tab : 'edit';
  });
  const [testStepId, setTestStepId] = useState<string | null>(() => {
    const hash = new URLSearchParams(window.location.hash.slice(1));
    return hash.get('automation') === automation.id ? hash.get('test') : null;
  });
  const [stepRun, setStepRun] = useState<AutomationRun>();
  const testStep = flattenAutomationSteps(config.steps).find((step) => step.id === testStepId);
  const [picked, setPicked] = useState<{ id: string; name: string; tableId: string } | null>(null);
  const [simulating, setSimulating] = useState(false);
  const [simPicked, setSimPicked] = useState<{ id: string; name: string; tableId: string } | null>(null);
  const simulator = useSimulation(automation, config, save);
  const titleId = useId();
  const testId = useId();
  const testTable = triggerTableId(config.trigger, schema);
  // A record picked before the trigger moved to another table no longer applies.
  const testRecord = picked && picked.tableId === testTable ? picked : null;
  const simRecord = simPicked && simPicked.tableId === testTable ? simPicked : null;
  const runAs = automation.runAsId ? schema.collaborators.get(automation.runAsId)?.name : undefined;
  const note = t({
    id: 'automations.turnOnNote',
    message: 'When it’s on, it makes changes as you, with your permissions.',
  });

  const setEnabled = async (enabled: boolean) => {
    try {
      if (enabled) await save();
      session.run([{ kind: 'automation.update', automationId: automation.id, enabled }]);
    } catch (error) {
      reportError(error);
    }
  };

  // An automation that has never run can celebrate its first run that works.
  const { observe } = useCelebrations();
  const testButton = useRef<HTMLDivElement>(null);
  const neverRan = automation.lastRunAt === null;
  useEffect(() => {
    if (neverRan) observe('automationFirstRun', automation.id, false);
  }, [neverRan, automation.id, observe]);

  const test = useMutation({
    mutationFn: async (recordId: string | null): Promise<AutomationRun> => {
      await save();
      return api<AutomationRun>(`/api/automations/${automation.id}/test`, {
        method: 'POST',
        body: recordId ? { recordId } : {},
      });
    },
    onSuccess: (run) => {
      if (run.state === 'succeeded')
        observe('automationFirstRun', automation.id, true, { anchor: testButton.current });
    },
    onSettled: () => client.invalidateQueries({ queryKey: runsKey(automation.id) }),
  });

  const reason = automation.stoppedBecause ? serverMessage(i18n, automation.stoppedBecause) : '';
  const name = runAs ?? '';
  return (
    <div
      className="rio-automation-screen"
      onKeyDown={(event) => {
        const target = event.target;
        if (
          !canEdit ||
          event.defaultPrevented ||
          !(event.metaKey || event.ctrlKey) ||
          event.altKey ||
          (target instanceof Element && target.closest('input, textarea, [contenteditable="true"]'))
        )
          return;
        const key = event.key.toLowerCase();
        if (key !== 'z' && key !== 'y') return;
        event.preventDefault();
        void save()
          .then(() => undoAction(session, key === 'y' || event.shiftKey))
          .catch(reportError);
      }}
    >
      <div className="rio-automation-screen__inner">
        <div className="rio-automation-screen__header" data-anchor="automation.canvas">
          <h2 id={titleId} className="rio-automation-screen__title" data-hidden={canEdit || undefined}>
            {automation.name}
          </h2>
          {canEdit ? <NameField session={session} automation={automation} /> : null}
          <HelpButton subject={automation.name} moduleId="automations" section="moving-around-the-canvas" />
          <Switch
            className="rio-automation-screen__switch"
            isSelected={automation.enabled}
            isDisabled={!canEdit}
            onChange={setEnabled}
            description={
              automation.enabled && runAs
                ? t({ id: 'automations.runsAs', message: `Runs as ${name}` })
                : !automation.enabled && canEdit
                  ? note
                  : undefined
            }
          >
            {automation.enabled
              ? t({ id: 'automations.on', message: 'On' })
              : t({ id: 'automations.off', message: 'Off' })}
          </Switch>
          {canEdit ? (
            <div className="rio-automation-screen__test" ref={testButton}>
              {testTable ? (
                <TestRecordPicker
                  session={session}
                  tableId={testTable}
                  value={testRecord}
                  onChange={(record) => setPicked(record && { ...record, tableId: testTable })}
                />
              ) : null}
              <ResponsiveToolbar
                label={automation.name}
                items={[
                  {
                    id: 'test',
                    variant: 'secondary' as const,
                    priority: 100,
                    icon: faPlay,
                    pending: test.isPending,
                    label: t({ id: 'automations.test.whole', message: 'Test the whole automation' }),
                    onAction: () => test.mutate(testRecord?.id ?? null),
                  },
                  {
                    id: 'simulate',
                    variant: simulating ? 'primary' : 'secondary',
                    priority: 90,
                    icon: faRoute,
                    active: simulating,
                    label: t({ id: 'automations.simulate', message: 'Simulate' }),
                    onAction: () => {
                      setSimulating(true);
                      setTab('edit');
                    },
                  },
                ]}
              />
            </div>
          ) : null}
        </div>
        {canEdit ? (
          <DraftBar session={session} automation={automation} config={config} save={save} discard={discard} />
        ) : null}
        {automation.enabled &&
        automation.runAsId &&
        schema.collaborators.get(automation.runAsId)?.deactivated &&
        canEdit ? (
          <Banner tone="warning">
            <Trans id="people.automations.ownerNotice">
              {
                'This automation’s owner is deactivated.  Published runs keep their existing resource permissions.'
              }
            </Trans>
          </Banner>
        ) : null}
        {automation.stoppedBecause && !automation.enabled ? (
          <Banner
            tone="warning"
            title={t({ id: 'automations.stopped', message: `This automation stopped: ${reason}` })}
          >
            {canEdit ? (
              <div className="rio-automation-screen__restart">
                <p>{note}</p>
                <Button onPress={() => setEnabled(true)}>
                  {t({ id: 'automations.turnOn', message: 'Turn on' })}
                </Button>
              </div>
            ) : null}
          </Banner>
        ) : null}
        <div aria-live="polite" className="rio-automation-screen__live">
          {test.data ? <RunSummary run={test.data} /> : null}
        </div>
        {test.data || test.error ? (
          <section className="rio-automation-test" aria-labelledby={testId}>
            <h3 id={testId} className="rio-automation-test__title">
              {t({ id: 'automations.test', message: 'Test run' })}
            </h3>
            {test.error ? (
              <Banner tone="danger">
                {message(test.error instanceof ApiError ? test.error.info.messageKey : 'errors.internal')}
              </Banner>
            ) : test.data ? (
              <>
                <RunSummary run={test.data} />
                <RunSteps run={test.data} automation={automation} />
              </>
            ) : null}
          </section>
        ) : null}
        {simulating && canEdit ? (
          <SimulatorPanel
            schema={schema}
            config={config}
            simulator={simulator}
            recordPicker={
              testTable
                ? {
                    recordId: simRecord?.id ?? null,
                    element: (
                      <TestRecordPicker
                        session={session}
                        tableId={testTable}
                        value={simRecord}
                        label={t({ id: 'automations.simulate.record', message: 'Simulate with' })}
                        onChange={(record) => {
                          setSimPicked(record && { ...record, tableId: testTable });
                          simulator.reset();
                        }}
                      />
                    ),
                  }
                : null
            }
            onClose={() => {
              setSimulating(false);
              simulator.reset();
            }}
          />
        ) : null}
        <Tabs
          selectedKey={tab}
          onSelectionChange={(key) => {
            setTab(String(key));
            const hash = new URLSearchParams(window.location.hash.slice(1));
            if (hash.get('automation') !== automation.id) {
              hash.delete('run');
              hash.delete('step');
            }
            hash.set('tab', String(key));
            hash.set('automation', automation.id);
            window.history.replaceState(
              null,
              '',
              `${window.location.pathname}${window.location.search}#${hash}`,
            );
          }}
        >
          <TabList aria-labelledby={titleId}>
            <Tab id="edit">{t({ id: 'automations.edit', message: 'Edit' })}</Tab>
            <Tab id="runs">{t({ id: 'automations.runs', message: 'Runs' })}</Tab>
            <Tab id="versions">{t({ id: 'automations.versions', message: 'Versions' })}</Tab>
          </TabList>
          <TabPanel id="edit">
            <AutomationFlow
              session={session}
              schema={schema}
              automation={automation}
              config={config}
              readOnly={!canEdit}
              onChange={change}
              testRun={stepRun ?? test.data}
              simulation={simulating && simulator.view ? simulator.view : undefined}
              onTest={(id) => {
                setTestStepId(id);
                const hash = new URLSearchParams(window.location.hash.slice(1));
                hash.set('automation', automation.id);
                hash.set('step', id);
                hash.set('test', id);
                window.history.replaceState(
                  null,
                  '',
                  `${window.location.pathname}${window.location.search}#${hash}`,
                );
              }}
              stepTest={
                testStep && canEdit
                  ? {
                      stepId: testStep.id,
                      panel: (
                        <StepTestPanel
                          key={testStep.id}
                          automation={automation}
                          step={testStep}
                          schema={schema}
                          save={save}
                          onResult={setStepRun}
                        />
                      ),
                    }
                  : undefined
              }
            />
          </TabPanel>
          <TabPanel id="runs">
            <RunHistory
              session={session}
              automation={automation}
              canEdit={canEdit}
              canDiagnose={canEdit}
              schema={schema}
              save={save}
            />
          </TabPanel>
          <TabPanel id="versions">
            <Versions
              session={session}
              schema={schema}
              automation={automation}
              canEdit={canEdit}
              onRestored={() => setTab('edit')}
            />
          </TabPanel>
        </Tabs>
      </div>
    </div>
  );
}

function NameField({ session, automation }: { session: DatabaseSession; automation: AutomationMeta }) {
  const { t } = useLingui();
  const [value, setValue] = useState(automation.name);
  const [seen, setSeen] = useState(automation.name);
  if (seen !== automation.name) {
    setSeen(automation.name);
    setValue(automation.name);
  }
  const commit = () => {
    const name = value.trim();
    if (!name) {
      setValue(automation.name);
      return;
    }
    if (name === automation.name) return;
    try {
      session.run([{ kind: 'automation.update', automationId: automation.id, name }]);
    } catch (error) {
      reportError(error);
    }
  };
  return (
    <TextField
      className="rio-automation-screen__name"
      label={t({ id: 'automations.name', message: 'Name' })}
      value={value}
      maxLength={LIMITS.nameLength}
      onChange={setValue}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === 'Enter') commit();
        else if (event.key === 'Escape') setValue(automation.name);
      }}
    />
  );
}

/** A small search of the trigger's table, for testing with one record. */
function TestRecordPicker({
  session,
  tableId,
  value,
  label,
  onChange,
}: {
  session: DatabaseSession;
  tableId: string;
  value: { id: string; name: string } | null;
  label?: string;
  onChange(value: { id: string; name: string } | null): void;
}) {
  const { t } = useLingui();
  const [active, setActive] = useState(false);
  const [text, setText] = useState('');
  const [query, setQuery] = useState('');
  useEffect(() => {
    const timer = setTimeout(() => setQuery(text), 250);
    return () => clearTimeout(timer);
  }, [text]);
  const newest = t({ id: 'automations.test.newest', message: 'The newest matching record' });
  const records = useQuery({
    queryKey: ['automations', 'test-records', tableId, query],
    queryFn: ({ signal }) => session.searchRecords(tableId, query, signal),
    enabled: active,
    staleTime: 30_000,
  });
  const items = [{ id: NEWEST, name: newest }, ...(records.data ?? [])];
  if (value && !items.some((item) => item.id === value.id)) items.push(value);
  return (
    <ComboBox
      className="rio-automation-screen__record"
      label={label ?? t({ id: 'automations.test.record', message: 'Test with' })}
      selectedKey={value?.id ?? NEWEST}
      onOpenChange={(open) => {
        if (open) setActive(true);
      }}
      onFocus={() => setActive(true)}
      onInputChange={(input) => {
        // Showing the chosen record's name isn't a search.
        setText(input === (value?.name ?? newest) ? '' : input);
      }}
      onSelectionChange={(key) => {
        const item = items.find((entry) => entry.id === key);
        onChange(!item || item.id === NEWEST ? null : item);
      }}
    >
      {items.map((item) => (
        <ListBoxItem key={item.id} id={item.id} textValue={item.name}>
          {item.name}
        </ListBoxItem>
      ))}
    </ComboBox>
  );
}
