import { useSettingsSection } from '../screens/settings/SettingsDraft';
import { msg } from '@lingui/core/macro';
import { Setting, defineSettingsPage } from '../screens/settings/Setting';

import { Trans, useLingui } from '@lingui/react/macro';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import {
  LEVELS,
  levelRank,
  levelsFor,
  type Level,
  type OrgSettings,
  type SessionInfo,
} from '@riosoma/contracts';
import { Form, FormActions, Heading, ListBoxItem, Radio, RadioGroup, Select, toast } from '@riosoma/ui';
import { api } from '../api';
import { appliedSettings, sessionQuery, useSession } from '../session';
import { organizationRole } from '../screens/settings/units/access';
import { ErrorBanner } from '../shell/ErrorBanner';
import { errorInfo } from '../screens/setup/useSetup';
import { useDraftPreferences } from '../screens/settings/useDraftPreferences';
import { LEVEL_NAMES, LEVEL_SUMMARIES } from './words';
import './levels.css';

const settingsPage = defineSettingsPage({
  area: 'personal',
  section: 'preferences',
  page: 'levels',
  label: msg({ id: 'settings.nav.levels', message: 'Experience level' }),
  roles: ['personal'],
  keywords: msg({
    id: 'settings.search.keywords.levels',
    message: 'experience level simple standard advanced developer guests',
  }),
});

/** The choice that follows the organization's default rather than naming a level */
const FOLLOW = 'default';

function isLevel(value: unknown): value is Level {
  return (LEVELS as readonly unknown[]).includes(value);
}

/**
 * Choosing how much of Riosoma to see.  The choice saves as it's made and follows the person to
 * every device, and following the organization's default again clears it.  Owners and admins with
 * the People role also choose where members start and how far up guests can go.
 */
export function LevelSettings() {
  const { t, i18n } = useLingui();
  const session = useSession();
  const save = useDraftPreferences();
  if (!session) return null;
  const { level, highest, start, chosen } = levelsFor(
    session.membership.kind,
    appliedSettings(session) ?? {},
    save.preferences.level,
  );
  // A guest never sees a level the organization doesn't offer them.
  const choices = LEVELS.filter((choice) => levelRank(choice) <= levelRank(highest));
  const startName = i18n._(LEVEL_NAMES[start]);
  return (
    <Setting
      page={settingsPage}
      id="overview"
      label={msg({ id: 'settings.nav.levels', message: 'Experience level' })}
    >
      {
        <div className="rio-level-settings">
          <div data-anchor="settings.levels.level">
            <Setting
              page={settingsPage}
              id="levels"
              label={msg({ id: 'levels.settings.label', message: 'How much to show' })}
            >
              <RadioGroup
                label={t({ id: 'levels.settings.label', message: 'How much to show' })}
                value={chosen ? level : FOLLOW}
                onChange={(value) => {
                  // Following the default clears the choice, so a later change to the default applies.
                  if (value === FOLLOW) {
                    if (chosen) save.mutate({ level: null });
                  } else if (isLevel(value) && (!chosen || value !== level)) save.mutate({ level: value });
                }}
              >
                <Radio
                  value={FOLLOW}
                  description={t({
                    id: 'levels.settings.defaultSummary',
                    message: `Currently ${startName}.  Follows any change the organization makes.`,
                  })}
                >
                  {t({ id: 'levels.settings.default', message: 'Use the organization default' })}
                </Radio>
                {choices.map((choice) => (
                  <Radio key={choice} value={choice} description={i18n._(LEVEL_SUMMARIES[choice])}>
                    {i18n._(LEVEL_NAMES[choice])}
                  </Radio>
                ))}
              </RadioGroup>
            </Setting>
          </div>
          {save.isError ? <ErrorBanner error={errorInfo(save.error)} /> : null}
          {organizationRole(session, 'people') ? <OrganizationLevels session={session} /> : null}
        </div>
      }
    </Setting>
  );
}

/** Where members start, and the highest level guests can choose, for the whole organization. */
function OrganizationLevels({ session }: { session: SessionInfo }) {
  const { t, i18n } = useLingui();
  const queryClient = useQueryClient();
  const saved = {
    defaultLevel: session.org.settings.defaultLevel ?? 'standard',
    guestLevel: session.org.settings.guestLevel ?? 'advanced',
  };
  const [draft, setDraft] = useState<typeof saved | null>(null);
  const choice = draft ?? saved;
  const changed = choice.defaultLevel !== saved.defaultLevel || choice.guestLevel !== saved.guestLevel;
  const store = useMutation({
    mutationFn: (body: typeof saved) => api<OrgSettings>('/api/admin/levels', { method: 'PUT', body }),
    onSuccess: (settings) => {
      queryClient.setQueryData(sessionQuery.queryKey, (old: SessionInfo | null | undefined) =>
        old ? { ...old, org: { ...old.org, settings } } : old,
      );
      // What applies to the admin, where their unit sets its own levels, comes from the server.
      if (session.effectiveSettings) void queryClient.invalidateQueries({ queryKey: sessionQuery.queryKey });
      setDraft(null);
      toast.show({
        tone: 'success',
        title: t({ id: 'levels.org.saved', message: 'Saved the organization’s levels' }),
      });
    },
  });
  const pageDraft = useSettingsSection({
    dirty: changed,
    stored: saved,
    discard: () => setDraft(null),
    save: () => store.mutateAsync(choice),
  });
  const options = LEVELS.map((level) => (
    <ListBoxItem key={level} id={level} textValue={i18n._(LEVEL_NAMES[level])}>
      {i18n._(LEVEL_NAMES[level])}
    </ListBoxItem>
  ));
  return (
    <section className="rio-level-settings__org" aria-labelledby="levels-org-title">
      <Heading level={2} id="levels-org-title">
        <Trans id="levels.org.title">For the organization</Trans>
      </Heading>
      <p>
        <Trans id="levels.org.body">
          {'People who haven’t chosen a level follow the default.  Guests start at Simple.'}
        </Trans>
      </p>
      <Form
        onSubmit={(event) => {
          event.preventDefault();
          void pageDraft.save?.();
        }}
      >
        <Setting
          page={settingsPage}
          id="default"
          label={msg({ id: 'levels.org.default', message: 'Default level for members' })}
          roles={['organization-people']}
        >
          <Select
            label={t({ id: 'levels.org.default', message: 'Default level for members' })}
            selectedKey={choice.defaultLevel}
            onSelectionChange={(key) => {
              if (isLevel(key)) setDraft({ ...choice, defaultLevel: key });
            }}
          >
            {options}
          </Select>
        </Setting>
        <Setting
          page={settingsPage}
          id="guests"
          label={msg({ id: 'levels.org.guests', message: 'Highest level for guests' })}
          roles={['organization-people']}
        >
          <Select
            label={t({ id: 'levels.org.guests', message: 'Highest level for guests' })}
            selectedKey={choice.guestLevel}
            onSelectionChange={(key) => {
              if (isLevel(key)) setDraft({ ...choice, guestLevel: key });
            }}
          >
            {options}
          </Select>
        </Setting>
        <ErrorBanner error={errorInfo(store.error)} />
        <FormActions></FormActions>
      </Form>
    </section>
  );
}
