import { msg } from '@lingui/core/macro';
import { Trans, useLingui } from '@lingui/react/macro';
import { useQuery } from '@tanstack/react-query';
import { useId, useLayoutEffect, useRef } from 'react';
import { AUTONOMY, Autonomy, effectiveAutonomy } from '@riosoma/contracts';
import { Radio, RadioGroup, Text } from '@riosoma/ui';
import { rioStatusQuery } from '../../features/rio/status';
import { Setting, defineSettingsPage } from './Setting';
import { useDraftPreferences } from './useDraftPreferences';

const settingsPage = defineSettingsPage({
  area: 'personal',
  section: 'ai',
  page: 'rio',
  label: msg({ id: 'settings.rio.title', message: 'Rio' }),
  roles: ['personal'],
  keywords: msg({
    id: 'settings.rio.keywords',
    message: 'Rio autonomy preview approval personal changes organization limit',
  }),
});

const choices = {
  ask: {
    label: msg({ id: 'settings.rio.ask', message: 'Always preview first' }),
    description: msg({
      id: 'settings.rio.ask.description',
      message: 'Review and approve every change before Rio makes it.',
    }),
  },
  previewBig: {
    label: msg({ id: 'settings.rio.previewBig', message: 'Preview big changes, do small ones right away' }),
    description: msg({
      id: 'settings.rio.previewBig.description',
      message: 'Rio can change up to 20 records right away.  Larger changes wait for your approval.',
    }),
  },
  instant: {
    label: msg({ id: 'settings.rio.instant', message: 'Make changes right away' }),
    description: msg({
      id: 'settings.rio.instant.description',
      message: 'Rio makes supported changes right away and gives you a receipt with Undo.',
    }),
  },
};

export function RioSettings() {
  const { t } = useLingui();
  const radioName = useId();
  const inputs = useRef(new Map<Autonomy, HTMLInputElement>());
  const save = useDraftPreferences();
  const status = useQuery({ ...rioStatusQuery, refetchOnMount: 'always', refetchInterval: 30_000 });
  const cap = status.data?.autonomyCap ?? status.data?.autonomy;
  const choice = save.preferences.rioAutonomy ?? cap;
  const effective = cap && effectiveAutonomy(choice, cap);
  const tabChoice = choice === effective ? choice : AUTONOMY[0];

  useLayoutEffect(() => {
    const synchronize = () => {
      for (const [value, input] of inputs.current) {
        // A disabled checked choice must not make the browser skip the enabled native group.
        const name = input.disabled ? `${radioName}-limited` : radioName;
        const tabIndex = !input.disabled && value === tabChoice ? 0 : -1;
        if (input.name !== name) input.name = name;
        if (input.tabIndex !== tabIndex) input.tabIndex = tabIndex;
      }
    };
    // The controls restore native attributes during their own renders, after refs have run.
    const observer = new MutationObserver(synchronize);
    for (const input of inputs.current.values())
      observer.observe(input, { attributes: true, attributeFilter: ['name', 'tabindex', 'disabled'] });
    synchronize();
    return () => observer.disconnect();
  }, [radioName, tabChoice, cap]);

  return (
    <Setting
      page={settingsPage}
      id="autonomy"
      label={msg({ id: 'ai.autonomy', message: 'What Rio may do without asking' })}
      help={msg({
        id: 'settings.rio.safety',
        message: 'Deletes and external actions always ask for your approval.',
      })}
    >
      <RadioGroup
        label={t({ id: 'ai.autonomy', message: 'What Rio may do without asking' })}
        name={radioName}
        value={choice ?? ''}
        isDisabled={!cap}
        onChange={(value) => {
          const parsed = Autonomy.safeParse(value);
          if (parsed.success && cap && effectiveAutonomy(parsed.data, cap) === parsed.data)
            save.mutate({ rioAutonomy: parsed.data });
        }}
        description={t({
          id: 'settings.rio.safety',
          message: 'Deletes and external actions always ask for your approval.',
        })}
      >
        {AUTONOMY.map((value) => {
          const limited = cap !== undefined && effectiveAutonomy(value, cap) !== value;
          return (
            <Radio
              key={value}
              value={value}
              isDisabled={limited}
              inputRef={(input) => {
                if (input) inputs.current.set(value, input);
                else inputs.current.delete(value);
              }}
              description={
                <>
                  {t(choices[value].description)}
                  {limited && (
                    <>
                      {' '}
                      <Trans id="settings.rio.limited">Your organization limits this.</Trans>
                    </>
                  )}
                </>
              }
            >
              {t(choices[value].label)}
            </Radio>
          );
        })}
      </RadioGroup>
      {effective && choice !== effective && (
        <Text role="status">
          <Trans id="settings.rio.effective">
            Your organization limits this.{'  '}Rio currently uses “{t(choices[effective].label)}”.{'  '}
            Your saved choice stays the same.
          </Trans>
        </Text>
      )}
      {status.isError && (
        <Text role="alert">
          <Trans id="settings.rio.loadError">Rio’s settings could not be loaded.{'  '}Try again.</Trans>
        </Text>
      )}
    </Setting>
  );
}
