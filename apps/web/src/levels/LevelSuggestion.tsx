import { useLingui } from '@lingui/react/macro';
import { Banner, Button } from '@riosoma/ui';
import { useLevel } from './context';
import { SHOW_LEVEL, SUGGESTIONS } from './words';
import './levels.css';

/**
 * The quiet suggestion to move up a level, once someone has opened features above theirs through
 * the palette three times in a week.  It lives on the home screen, between tasks rather than in
 * the middle of one, and once dismissed it never comes back.
 */
export function LevelSuggestion() {
  const { i18n } = useLingui();
  const { suggestion, choose, dismissSuggestion } = useLevel();
  if (suggestion === null || suggestion === 'simple') return null;
  return (
    <Banner key={suggestion} tone="info" className="rio-level-suggestion" onDismiss={dismissSuggestion}>
      <p>{i18n._(SUGGESTIONS[suggestion])}</p>
      <Button size="sm" onPress={() => choose(suggestion)}>
        {i18n._(SHOW_LEVEL[suggestion])}
      </Button>
    </Banner>
  );
}
