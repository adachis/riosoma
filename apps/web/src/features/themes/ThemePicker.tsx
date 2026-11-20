import { useLingui } from '@lingui/react/macro';
import { useQuery } from '@tanstack/react-query';
import { useId } from 'react';
import { themeAllowed, type ThemePick } from '@riosoma/contracts';
import { ListBoxItem, Select } from '@riosoma/ui';
import type { AnchorProps } from '../../demos/anchors';
import { themes } from '../../preferences';
import { appliedSettings, useSession } from '../../session';
import './theme-picker.css';

const INHERIT = 'inherit';

export interface ThemePickerProps {
  /** The picked theme and color scheme, or null for whatever `inheritLabel` names */
  value: ThemePick | null;
  onChange(next: ThemePick | null): void;
  label: string;
  /** What no pick means here: each person's own theme, or the database's */
  inheritLabel: string;
  description?: string;
  /** Shown when the picked theme isn't one the person may choose anymore */
  blockedNote: string;
  isDisabled?: boolean;
  /** Help's name for the theme control, as `anchor()` makes it */
  anchorProps?: AnchorProps;
}

/**
 * Picks a theme and color scheme for something other than the person picking: a database that
 * forces its theme, or a public page.  The list holds only the themes the person may choose.  A
 * pick made before the organization narrowed its list still shows, with a note, so nothing
 * changes until someone picks again.  Picking a new theme starts at that theme's own default
 * scheme.
 */
export function ThemePicker({
  value,
  onChange,
  label,
  inheritLabel,
  description,
  blockedNote,
  isDisabled = false,
  anchorProps,
}: ThemePickerProps) {
  const { t } = useLingui();
  const noteId = useId();
  const session = useSession();
  const allowed = appliedSettings(session)?.allowedThemes;
  const index = useQuery({ queryKey: ['themes', 'index'], queryFn: () => themes.list(), staleTime: Infinity });
  const manifest = useQuery({
    queryKey: ['themes', 'manifest', value?.id ?? ''],
    queryFn: () => themes.manifest(value!.id),
    enabled: Boolean(value),
    staleTime: Infinity,
  });
  const blocked = Boolean(value && !themeAllowed(value.id, allowed));
  const choices = (index.data ?? []).filter(
    (theme) => themeAllowed(theme.id, allowed) || theme.id === value?.id,
  );

  const chooseTheme = async (id: string) => {
    if (id === INHERIT) return onChange(null);
    if (id === value?.id) return;
    const next = await themes.manifest(id);
    onChange({ id, scheme: next.defaultScheme });
  };

  return (
    <div className="rio-theme-picker">
      <div className="rio-theme-picker__fields">
        <div className="rio-theme-picker__theme" {...anchorProps}>
          <Select
            label={label}
            {...(description ? { description } : {})}
            selectedKey={value?.id ?? INHERIT}
            isDisabled={isDisabled || !index.data}
            aria-describedby={blocked ? noteId : undefined}
            onSelectionChange={(key) => void chooseTheme(String(key))}
          >
            <ListBoxItem id={INHERIT} textValue={inheritLabel}>
              {inheritLabel}
            </ListBoxItem>
            {choices.map((theme) => (
              <ListBoxItem key={theme.id} id={theme.id} textValue={theme.name}>
                {theme.name}
              </ListBoxItem>
            ))}
          </Select>
        </div>
        {value && manifest.data ? (
          <div className="rio-theme-picker__scheme">
            <Select
              label={t({ id: 'themes.picker.scheme', message: 'Color scheme' })}
              selectedKey={value.scheme}
              isDisabled={isDisabled}
              onSelectionChange={(key) => onChange({ id: value.id, scheme: String(key) })}
            >
              {manifest.data.schemes.map((scheme) => (
                <ListBoxItem key={scheme.id} id={scheme.id} textValue={scheme.name}>
                  {scheme.name}
                </ListBoxItem>
              ))}
            </Select>
          </div>
        ) : null}
      </div>
      {blocked ? (
        <p id={noteId} className="rio-theme-picker__note" role="note">
          {blockedNote}
        </p>
      ) : null}
    </div>
  );
}
