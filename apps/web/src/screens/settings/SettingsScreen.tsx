import { canManageSources, canManageSso, canManageSignInPolicy, canManageIntegrations } from './access';
import { LazyBoundary, lazyFeature } from '../../shell/lazy';

import { ownsServer, runsServer } from '../../features/updates/api';
import { canOpenUnits } from './units/access';

import { Trans, useLingui } from '@lingui/react/macro';
import { useQuery } from '@tanstack/react-query';
import { Link, useLocation, useNavigate } from '@tanstack/react-router';
import { useEffect, useRef } from 'react';
import type { SessionInfo } from '@riosoma/contracts';
import { HAS_LANGUAGE_CHOICE } from '@riosoma/i18n';
import { Heading, toast } from '@riosoma/ui';
import { canUseTokens, useSession } from '../../session';
import { canManagePeople } from '../../session';

import { tokensQuery } from './tokens/query';

import { canManageAi } from '../../features/ai/access';

import { isOrgAdmin } from '../../features/archives/api';

import { canReadFeedback, countFeedback, feedbackCountKey } from '../../features/feedback/api';

import { useLevel } from '../../levels/context';
import './SettingsScreen.css';

import { organizationRole } from './units/access';
import { SettingsSearch } from './SettingsSearch';
import { settingHref, visibleSettings } from './registry';
import { resolveSettingsPath } from './paths';
import { useSettingTarget } from './useSettingTarget';
import { SettingsDraftPage } from './SettingsDraft';
import { HelpButton } from '../../docs/HelpButton';
import { settingsHelp } from '../../docs/settings-help';
import { anchor } from '../../demos/anchors';

const PersonalLibrary = lazyFeature(() =>
  import('../../features/ai/Libraries').then((module) => ({ default: module.PersonalLibrary })),
);
const GovernanceSettings = lazyFeature(() =>
  import('./governance/GovernanceSettings').then((module) => ({ default: module.GovernanceSettings })),
);
const PublicSharingSettings = lazyFeature(() =>
  import('../../features/public-sharing/PublicSharingSettings').then((module) => ({
    default: module.PublicSharingSettings,
  })),
);
const PersonalMemories = lazyFeature(() =>
  import('../../features/ai/Knowledge').then((module) => ({ default: module.PersonalMemories })),
);
const CredentialSettings = lazyFeature(() =>
  import('./security/CredentialSettings').then((module) => ({ default: module.CredentialSettings })),
);
const FileSettings = lazyFeature(() =>
  import('./FileSettings').then((module) => ({ default: module.FileSettings })),
);
const DriversSettings = lazyFeature(() =>
  import('./sources/DriversSettings').then((module) => ({ default: module.DriversSettings })),
);
const UpdateSettings = lazyFeature(() =>
  import('../../features/updates/UpdateSettings').then((module) => ({ default: module.UpdateSettings })),
);
const TelemetrySettings = lazyFeature(() =>
  import('../../features/telemetry/TelemetrySettings').then((module) => ({
    default: module.TelemetrySettings,
  })),
);
const UnitSettings = lazyFeature(() =>
  import('./units/UnitSettings').then((module) => ({ default: module.UnitSettings })),
);
const OAuthGrants = lazyFeature(() =>
  import('./oauth/OAuthGrants').then((module) => ({ default: module.OAuthGrants })),
);
const McpSettings = lazyFeature(() =>
  import('./mcp/McpSettings').then((module) => ({ default: module.McpSettings })),
);
const OAuthApps = lazyFeature(() =>
  import('./oauth/OAuthApps').then((module) => ({ default: module.OAuthApps })),
);
const CustomDomainsSettings = lazyFeature(() =>
  import('./CustomDomainsSettings').then((module) => ({ default: module.CustomDomainsSettings })),
);
const PeopleSettings = lazyFeature(() =>
  import('./people/PeopleSettings').then((module) => ({ default: module.PeopleSettings })),
);
const TokenSettings = lazyFeature(() =>
  import('./tokens/TokenSettings').then((module) => ({ default: module.TokenSettings })),
);
const AiSettings = lazyFeature(() =>
  import('../../features/ai/AiSettings').then((module) => ({ default: module.AiSettings })),
);
const RioSettings = lazyFeature(() =>
  import('./RioSettings').then((module) => ({ default: module.RioSettings })),
);
const SourcesSettings = lazyFeature(() =>
  import('./sources/SourcesSettings').then((module) => ({ default: module.SourcesSettings })),
);
const SsoSettings = lazyFeature(() =>
  import('./sso/SsoSettings').then((module) => ({ default: module.SsoSettings })),
);
const ScimSettings = lazyFeature(() =>
  import('./scim/ScimSettings').then((module) => ({ default: module.ScimSettings })),
);
const NotificationSettings = lazyFeature(() =>
  import('../../features/notifications/NotificationSettings').then((module) => ({
    default: module.NotificationSettings,
  })),
);
const ReportSettings = lazyFeature(() =>
  import('../../features/reports/ReportSettings').then((module) => ({ default: module.ReportSettings })),
);
const CalendarFeedSettings = lazyFeature(() =>
  import('../../features/calendar-feeds/CalendarFeedSettings').then((module) => ({
    default: module.CalendarFeedSettings,
  })),
);
const SecuritySettings = lazyFeature(() =>
  import('./security/SecuritySettings').then((module) => ({ default: module.SecuritySettings })),
);
const SignInPolicySettings = lazyFeature(() =>
  import('./security/SignInPolicySettings').then((module) => ({ default: module.SignInPolicySettings })),
);
const AppearanceSettings = lazyFeature(() =>
  import('./AppearanceSettings').then((module) => ({ default: module.AppearanceSettings })),
);
const SnapshotSettings = lazyFeature(() =>
  import('../../features/archives/SnapshotSettings').then((module) => ({ default: module.SnapshotSettings })),
);
const OrganizationArchives = lazyFeature(() =>
  import('../../features/archives/OrganizationArchives').then((module) => ({
    default: module.OrganizationArchives,
  })),
);
const LanguageSettings = lazyFeature(() =>
  import('./LanguageSettings').then((module) => ({ default: module.LanguageSettings })),
);
const ConnectedAccounts = lazyFeature(() =>
  import('./connections/ConnectedAccounts').then((module) => ({ default: module.ConnectedAccounts })),
);
const IntegrationsSettings = lazyFeature(() =>
  import('./connections/IntegrationsSettings').then((module) => ({ default: module.IntegrationsSettings })),
);
const CelebrationSettings = lazyFeature(() =>
  import('../../features/celebrations/CelebrationSettings').then((module) => ({
    default: module.CelebrationSettings,
  })),
);
const FeedbackInbox = lazyFeature(() =>
  import('../../features/feedback/FeedbackInbox').then((module) => ({ default: module.FeedbackInbox })),
);
const SentFeedback = lazyFeature(() =>
  import('../../features/feedback/SentFeedback').then((module) => ({ default: module.SentFeedback })),
);
const LevelSettings = lazyFeature(() =>
  import('../../levels/LevelSettings').then((module) => ({ default: module.LevelSettings })),
);
const AuditSettings = lazyFeature(() =>
  import('./audit/AuditSettings').then((module) => ({ default: module.AuditSettings })),
);

const OrganizationAppearanceSettings = lazyFeature(() =>
  import('./OrganizationAppearanceSettings').then((module) => ({
    default: module.OrganizationAppearanceSettings,
  })),
);

const ProfileSettings = lazyFeature(() =>
  import('./profile/ProfileSettings').then((module) => ({ default: module.ProfileSettings })),
);

const SECTIONS = [
  'organization-appearance',
  'profile',
  'rio',
  'knowledge',
  'memories',
  'appearance',
  'language',
  'levels',
  'celebrations',
  'notifications',
  'reports',
  'my-feedback',
  'security',
  'connected-accounts',
  'connected-apps',
  'oauth-apps',
  'mcp',
  'tokens',
  'people',
  'audit',
  'org-units',
  'sso',
  'scim',
  'sign-in-policy',
  'classification',
  'retention',
  'credential-vaults',
  'files',
  'calendar-feeds',
  'public-sharing',
  'sources',
  'source-drivers',
  'snapshots',
  'export-and-import',
  'feedback',
  'integrations',
  'custom-domains',
  'ai',
  'updates',
  'telemetry',
] as const;
type Section = (typeof SECTIONS)[number];
const SECTION_COMPONENTS = {
  'organization-appearance': OrganizationAppearanceSettings,
  profile: ProfileSettings,
  rio: RioSettings,
  classification: GovernanceSettings,
  retention: GovernanceSettings,
  audit: AuditSettings,
  updates: UpdateSettings,
  telemetry: TelemetrySettings,
  'org-units': UnitSettings,
  'connected-apps': OAuthGrants,
  'oauth-apps': OAuthApps,
  mcp: McpSettings,
  knowledge: PersonalLibrary,
  memories: PersonalMemories,
  ai: AiSettings,
  people: PeopleSettings,
  sso: SsoSettings,
  scim: ScimSettings,
  security: SecuritySettings,
  'credential-vaults': CredentialSettings,
  files: FileSettings,
  'sign-in-policy': SignInPolicySettings,
  'public-sharing': PublicSharingSettings,
  'calendar-feeds': CalendarFeedSettings,
  'connected-accounts': ConnectedAccounts,
  'custom-domains': CustomDomainsSettings,
  integrations: IntegrationsSettings,
  tokens: TokenSettings,
  'source-drivers': DriversSettings,
  sources: SourcesSettings,
  snapshots: SnapshotSettings,
  'export-and-import': OrganizationArchives,
  feedback: FeedbackInbox,
  'my-feedback': SentFeedback,
  notifications: NotificationSettings,
  reports: ReportSettings,
  appearance: AppearanceSettings,
  celebrations: CelebrationSettings,
  levels: LevelSettings,
  language: LanguageSettings,
};

/** Who sees each section: the administrators' sections go to owners and that area's admins. */
const ALLOWED: Record<Section, (session: SessionInfo | null) => boolean> = {
  'organization-appearance': (session) => organizationRole(session, 'people'),
  profile: () => true,
  rio: () => true,
  knowledge: () => true,
  memories: () => true,
  appearance: () => true,
  language: () => HAS_LANGUAGE_CHOICE,
  levels: () => true,
  celebrations: () => true,
  notifications: () => true,
  reports: () => true,
  'my-feedback': () => true,
  security: () => true,
  'connected-accounts': () => true,
  'connected-apps': canUseTokens,
  'oauth-apps': canManageIntegrations,
  mcp: canManageIntegrations,
  tokens: canUseTokens,
  people: canManagePeople,
  audit: (session) => organizationRole(session, 'audit'),
  // Until the first unit exists, units show nowhere: its owner and People admins find the way in
  // through the palette.
  'org-units': (session) => Boolean(session?.hasUnits) && canOpenUnits(session),
  sso: canManageSso,
  scim: canManageSso,
  'sign-in-policy': canManageSignInPolicy,
  classification: canManageSso,
  retention: canManageSso,
  'credential-vaults': canManageSignInPolicy,
  files: canManageSignInPolicy,
  'calendar-feeds': canManageSso,
  'public-sharing': canManageSso,
  sources: canManageSources,
  'source-drivers': canManageSources,
  snapshots: isOrgAdmin,
  'export-and-import': (session) => session?.membership.kind === 'owner',
  feedback: canReadFeedback,
  integrations: canManageIntegrations,
  'custom-domains': canManageIntegrations,
  ai: (session) =>
    canManageAi(session) ||
    Boolean(session?.membership.unitAdminGrants?.some((grant) => grant.roles.includes('ai'))),
  // The server checks that these belong to the organization that set it up.
  updates: runsServer,
  telemetry: ownsServer,
};

/** How often the count beside the feedback inbox looks for news while settings are open */
const COUNT_EVERY_MS = 60_000;

export function SettingsScreen() {
  const { t } = useLingui();
  const session = useSession();
  const { offers, tidies } = useLevel();
  const location = useLocation();
  const navigate = useNavigate();
  const body = useRef<HTMLElement>(null);
  const repaired = useRef('');
  const settingsAddress = /^\/(?:settings|admin)(\/|$)/.test(location.pathname);
  const resolved = resolveSettingsPath(location.pathname, visibleSettings(session));
  const parts = location.pathname.split('/').filter(Boolean);
  const canonical = visibleSettings(session).find(
    (setting) =>
      setting.area === (parts[0] === 'admin' ? 'admin' : 'personal') &&
      setting.section === parts[1] &&
      setting.page === parts[2],
  );
  const requested =
    canonical?.page ??
    (parts[0] === 'settings' && SECTIONS.includes(parts[1] as Section) ? parts[1] : parts[2]);
  // The original screen supplies its access explanation while the repaired route loads.
  const denied =
    !(requested === 'language' && !HAS_LANGUAGE_CHOICE) &&
    SECTIONS.includes(requested as Section) &&
    !ALLOWED[requested as Section](session);
  const section = denied ? requested! : (resolved.page ?? 'appearance');
  const missing = () => {
    if (!resolved.target || repaired.current === location.href) return;
    repaired.current = location.href;
    toast.show({
      tone: 'info',
      title: t({
        id: 'database.linkFixed',
        message: 'That link pointed to something that no longer exists, so here’s the closest match.',
      }),
    });
    const { area, section: group, page } = resolved.target;
    void navigate({
      to: settingHref({ area, section: group, page }),
      replace: true,
      search: (previous) => previous,
    });
  };
  useSettingTarget(body, resolved.target, missing);
  useEffect(() => {
    // A departing screen can remain mounted while the database loads.  Repairs belong only to settings addresses.
    if (!settingsAddress || !session || !resolved.repair || repaired.current === location.href) return;
    repaired.current = location.href;
    toast.show({
      tone: 'info',
      title: t({
        id: 'database.linkFixed',
        message: 'That link pointed to something that no longer exists, so here’s the closest match.',
      }),
    });
    void navigate({ to: resolved.repair, replace: true, search: (previous) => previous });
  }, [settingsAddress, session, resolved.repair, location.href, navigate, t]);
  // A level tidies the personal sections that belong to a higher one, but someone with tokens
  // keeps the tokens section, a link to a section still opens it, and it stays listed while it's
  // open.  Admin sections are never tidied.
  const tokens = useQuery({ ...tokensQuery, enabled: canUseTokens(session) && tidies('developerSettings') });
  const held = { tokens: tokens.data?.length ?? 0 };
  const sections = SECTIONS.filter(
    (item) => ALLOWED[item](session) && (item === section || offers('settings', item, held)),
  );
  const inbox = canReadFeedback(session);
  const count = useQuery({
    queryKey: feedbackCountKey,
    queryFn: ({ signal }) => countFeedback(signal),
    enabled: inbox,
    refetchInterval: COUNT_EVERY_MS,
  });
  const waiting = inbox ? (count.data?.new ?? 0) : 0;
  const current: Section = (SECTIONS as readonly string[]).includes(section)
    ? (section as Section)
    : 'appearance';
  const labels: Record<Section, string> = {
    'organization-appearance': t({ id: 'branding.settings.title', message: 'Organization appearance' }),
    rio: t({ id: 'settings.rio.title', message: 'Rio' }),
    knowledge: t({ id: 'libraries.personal', message: 'Personal knowledge' }),
    memories: t({ id: 'knowledge.myMemories', message: 'My memories' }),
    ai: t({ id: 'settings.nav.ai', message: 'AI' }),
    profile: t({ id: 'settings.nav.profile', message: 'Profile' }),
    appearance: t({ id: 'settings.nav.appearance', message: 'Appearance' }),
    language: t({ id: 'settings.nav.language', message: 'Language' }),
    levels: t({ id: 'settings.nav.levels', message: 'Experience level' }),
    celebrations: t({ id: 'settings.nav.celebrations', message: 'Celebrations and sounds' }),
    notifications: t({ id: 'notifications.settings.title', message: 'Notifications' }),
    reports: t({ id: 'reports.title', message: 'Scheduled reports' }),
    people: t({ id: 'settings.nav.people', message: 'People' }),
    audit: t({ id: 'settings.nav.audit', message: 'Audit' }),
    'org-units': t({ id: 'settings.nav.orgUnits', message: 'Organizational units' }),
    sso: t({ id: 'settings.nav.sso', message: 'Single sign-on' }),
    scim: t({ id: 'scim.title', message: 'Provisioning' }),
    security: t({ id: 'mfa.nav.security', message: 'Sign-in and security' }),
    classification: t({ id: 'governance.classification', message: 'Data classification' }),
    retention: t({ id: 'governance.retention', message: 'Retention' }),
    'credential-vaults': t({ id: 'credentials.title', message: 'Where credentials live' }),
    files: t({ id: 'files.settings.title', message: 'File uploads' }),
    'sign-in-policy': t({ id: 'mfa.nav.policy', message: 'Sign-in policy' }),
    'public-sharing': t({ id: 'publicSharing.title', message: 'Public sharing' }),
    'calendar-feeds': t({ id: 'calendarFeeds.settings.title', message: 'Calendar feeds' }),
    tokens: t({ id: 'settings.nav.tokens', message: 'Personal access tokens' }),
    'source-drivers': t({ id: 'sources.drivers.title', message: 'Drivers' }),
    sources: t({ id: 'settings.nav.sources', message: 'Data sources' }),
    snapshots: t({ id: 'settings.nav.snapshots', message: 'Snapshots' }),
    'export-and-import': t({ id: 'organizationArchive.title', message: 'Export and import' }),
    feedback: t({ id: 'settings.nav.feedback', message: 'Feedback' }),
    'my-feedback': t({ id: 'settings.nav.myFeedback', message: 'Feedback you sent' }),
    'connected-accounts': t({ id: 'settings.nav.connectedAccounts', message: 'Connected accounts' }),
    'connected-apps': t({ id: 'oauth.connectedApps', message: 'Connected apps' }),
    mcp: t({ id: 'mcp.settings.title', message: 'MCP' }),
    'oauth-apps': t({ id: 'oauth.apps', message: 'OAuth apps' }),
    'custom-domains': t({ id: 'customDomains.title', message: 'Custom domains' }),
    integrations: t({ id: 'settings.nav.integrations', message: 'Integrations' }),
    updates: t({ id: 'updates.title', message: 'Updates' }),
    telemetry: t({ id: 'telemetry.title', message: 'Usage counts' }),
  };

  return (
    <SettingsDraftPage page={current}>
      <div className="rio-settings">
        <SettingsSearch />
        <nav
          className="rio-settings__nav"
          aria-label={t({ id: 'settings.nav', message: 'Settings sections' })}
        >
          <Heading level={2}>
            <Trans id="shell.nav.settings">Settings</Trans>
          </Heading>
          <ul>
            {sections.map((s) => (
              <li key={s}>
                <Link
                  to="/settings/$section"
                  params={{ section: s }}
                  search={(previous) => ({ returnTo: previous.returnTo })}
                  className="rio-settings__link"
                  onMouseEnter={() => SECTION_COMPONENTS[s].preload()}
                  onFocus={() => SECTION_COMPONENTS[s].preload()}
                >
                  {labels[s]}
                  {s === 'feedback' && waiting > 0 ? (
                    <span className="rio-feedback-inbox__badge">
                      {waiting}
                      <span className="rio-visually-hidden">
                        {' '}
                        <Trans id="settings.nav.feedback.new">new</Trans>
                      </span>
                    </span>
                  ) : null}
                </Link>
              </li>
            ))}
          </ul>
        </nav>
        <section
          ref={body}
          className="rio-settings__body rio-settings__content"
          aria-labelledby="settings-title"
        >
          <div
            className="rio-help-heading"
            {...(settingsHelp[current] ? anchor(settingsHelp[current].anchorId) : {})}
          >
            <Heading level={1} id="settings-title">
              {current === 'people' ? t({ id: 'people.title', message: 'People' }) : labels[current]}
            </Heading>
            {settingsHelp[current] && (
              <HelpButton
                subject={labels[current]}
                moduleId={settingsHelp[current].id}
                section={settingsHelp[current].section}
              />
            )}
          </div>
          <LazyBoundary key={current}>
            {current === 'organization-appearance' ? (
              <OrganizationAppearanceSettings />
            ) : current === 'audit' ? (
              <AuditSettings />
            ) : current === 'updates' ? (
              <UpdateSettings />
            ) : current === 'telemetry' ? (
              <TelemetrySettings />
            ) : current === 'org-units' ? (
              <UnitSettings />
            ) : current === 'connected-apps' ? (
              <OAuthGrants />
            ) : current === 'mcp' ? (
              <McpSettings />
            ) : current === 'oauth-apps' ? (
              <OAuthApps />
            ) : current === 'knowledge' ? (
              <PersonalLibrary />
            ) : current === 'memories' ? (
              <PersonalMemories />
            ) : current === 'rio' ? (
              <RioSettings />
            ) : current === 'ai' ? (
              <AiSettings />
            ) : current === 'people' ? (
              <PeopleSettings />
            ) : current === 'sso' ? (
              <SsoSettings />
            ) : current === 'scim' ? (
              <ScimSettings />
            ) : current === 'security' ? (
              <SecuritySettings />
            ) : current === 'classification' || current === 'retention' ? (
              <GovernanceSettings mode={current} />
            ) : current === 'credential-vaults' ? (
              <CredentialSettings />
            ) : current === 'files' ? (
              <FileSettings />
            ) : current === 'sign-in-policy' ? (
              <SignInPolicySettings />
            ) : current === 'public-sharing' ? (
              <PublicSharingSettings />
            ) : current === 'calendar-feeds' ? (
              <CalendarFeedSettings />
            ) : current === 'connected-accounts' ? (
              <ConnectedAccounts />
            ) : current === 'custom-domains' ? (
              <CustomDomainsSettings />
            ) : current === 'integrations' ? (
              <IntegrationsSettings />
            ) : current === 'tokens' ? (
              <TokenSettings />
            ) : current === 'source-drivers' ? (
              <DriversSettings />
            ) : current === 'sources' ? (
              <SourcesSettings />
            ) : current === 'snapshots' ? (
              <SnapshotSettings />
            ) : current === 'export-and-import' ? (
              <OrganizationArchives />
            ) : current === 'feedback' ? (
              <FeedbackInbox />
            ) : current === 'my-feedback' ? (
              <SentFeedback />
            ) : current === 'notifications' ? (
              <NotificationSettings />
            ) : current === 'reports' ? (
              <ReportSettings />
            ) : current === 'profile' ? (
              <ProfileSettings />
            ) : current === 'appearance' ? (
              <AppearanceSettings />
            ) : current === 'celebrations' ? (
              <CelebrationSettings />
            ) : current === 'levels' ? (
              <LevelSettings />
            ) : (
              <LanguageSettings />
            )}
          </LazyBoundary>
        </section>
      </div>
    </SettingsDraftPage>
  );
}
