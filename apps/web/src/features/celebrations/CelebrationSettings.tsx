import { msg } from '@lingui/core/macro';
import { Setting, defineSettingsPage } from '../../screens/settings/Setting';

import { useLingui } from '@lingui/react/macro';
import { faPlay } from '@fortawesome/free-solid-svg-icons';
import { Button, Radio, RadioGroup, Text } from '@riosoma/ui';
import { useDraftPreferences } from '../../screens/settings/useDraftPreferences';
import { errorInfo } from '../../screens/setup/useSetup';
import { ErrorBanner } from '../../shell/ErrorBanner';
import type { CelebrationLevel } from './engine';
import { celebrationLevel, soundLevel, type SoundLevel } from './settings';
import { sounds as appSounds, type SoundName, type SoundPlayer } from './sounds';
import './celebrations.css';

const settingsPage = defineSettingsPage({
  area: 'personal',
  section: 'preferences',
  page: 'celebrations',
  label: msg({ id: 'settings.nav.celebrations', message: 'Celebrations and sounds' }),
  roles: ['personal'],
  keywords: msg({
    id: 'settings.search.keywords.celebrations',
    message: 'celebrations sounds volume quiet animations',
  }),
});

/**
 * How much the app celebrates, and whether it makes sounds.  Both are saved with the person's
 * other preferences, so they follow them to every device.
 */
export function CelebrationSettings({ player = appSounds }: { player?: SoundPlayer }) {
  const { t } = useLingui();
  const save = useDraftPreferences();
  const level = celebrationLevel(save.preferences);
  const sound = soundLevel(save.preferences);
  const previews: Array<{ name: SoundName; label: string }> = [
    { name: 'tick', label: t({ id: 'settings.sounds.preview.tick', message: 'Checked box' }) },
    { name: 'chime', label: t({ id: 'settings.sounds.preview.chime', message: 'Small celebration' }) },
    { name: 'rise', label: t({ id: 'settings.sounds.preview.rise', message: 'Big celebration' }) },
    { name: 'low', label: t({ id: 'settings.sounds.preview.low', message: 'Error' }) },
  ];
  return (
    <Setting
      page={settingsPage}
      id="overview"
      label={msg({ id: 'settings.nav.celebrations', message: 'Celebrations and sounds' })}
      help={msg({
        id: 'settings.celebrations.note',
        message: 'These follow you to every device where you sign in.',
      })}
    >
      {
        <div className="rio-celebration-settings">
          <div className="rio-celebration-settings__group" data-anchor="settings.celebrations.level">
            <Setting
              page={settingsPage}
              id="level"
              label={msg({ id: 'settings.celebrations.level', message: 'Celebrations' })}
            >
              <RadioGroup
                label={t({ id: 'settings.celebrations.level', message: 'Celebrations' })}
                value={level}
                onChange={(value) => save.mutate({ celebrations: value as CelebrationLevel })}
              >
                <Radio value="on">{t({ id: 'settings.celebrations.on', message: 'On' })}</Radio>
                <Radio
                  value="quieter"
                  description={t({ id: 'settings.celebrations.quieter.hint', message: 'Small ones only' })}
                >
                  {t({ id: 'settings.celebrations.quieter', message: 'Quieter' })}
                </Radio>
                <Radio value="off">{t({ id: 'settings.celebrations.off', message: 'Off' })}</Radio>
              </RadioGroup>
            </Setting>
          </div>
          <div className="rio-celebration-settings__group" data-anchor="settings.celebrations.sounds">
            <Setting
              page={settingsPage}
              id="sounds"
              label={msg({ id: 'settings.celebrations.sounds', message: 'Sounds' })}
            >
              <RadioGroup
                label={t({ id: 'settings.celebrations.sounds', message: 'Sounds' })}
                value={sound}
                onChange={(value) => save.mutate({ soundLevel: value as SoundLevel })}
              >
                <Radio value="off">{t({ id: 'settings.sounds.off', message: 'Off' })}</Radio>
                <Radio value="quiet">{t({ id: 'settings.sounds.quiet', message: 'Quiet' })}</Radio>
                <Radio value="normal">{t({ id: 'settings.sounds.normal', message: 'Normal' })}</Radio>
              </RadioGroup>
            </Setting>
            <div
              className="rio-celebration-settings__previews"
              role="group"
              aria-label={t({ id: 'settings.sounds.preview', message: 'Hear a sound' })}
            >
              {previews.map((preview) => (
                <Button
                  key={preview.name}
                  icon={faPlay}
                  // A preview plays even with sounds off, quietly, so they can be heard before choosing.
                  onPress={() => player.play(preview.name, sound === 'off' ? 'quiet' : sound)}
                >
                  {preview.label}
                </Button>
              ))}
            </div>
          </div>
          {save.isError ? <ErrorBanner error={errorInfo(save.error)} /> : null}
          <Text variant="muted">
            {t({
              id: 'settings.celebrations.note',
              message: 'These follow you to every device where you sign in.',
            })}
          </Text>
        </div>
      }
    </Setting>
  );
}
