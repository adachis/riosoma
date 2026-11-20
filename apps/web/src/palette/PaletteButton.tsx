import { faMagnifyingGlass } from '@fortawesome/free-solid-svg-icons';
import { useLingui } from '@lingui/react/macro';
import { Button } from '@riosoma/ui';
import { anchor } from '../demos/anchors';
import { shortcutKeys } from '../shortcuts/runtime';
import './PaletteButton.css';

/**
 * The header's way into the palette: the label, with the keys that do the same thing beside it, so
 * the shortcut teaches itself the first time someone reaches for the mouse.  At phone widths only
 * the icon fits, and the button keeps its name through its aria-label.
 */
export function PaletteButton({ onPress }: { onPress(): void }) {
  const { t } = useLingui();
  const label = t({ id: 'palette.open', message: 'Search' });
  const keys = shortcutKeys('palette.open');
  return (
    <Button
      variant="quiet"
      size="sm"
      icon={faMagnifyingGlass}
      aria-label={t({ id: 'palette.openWithShortcut', message: `${label} ${keys}` })}
      onPress={onPress}
      primaryAction
      {...anchor('palette.open')}
    >
      <span className="rio-palette__label">{label}</span>{' '}
      {/* The space keeps the visible text reading "Search Ctrl+K", like the name, where keys are
          words.  A flex button doesn't draw it. */}
      <kbd className="rio-palette__keys">{keys}</kbd>
    </Button>
  );
}
