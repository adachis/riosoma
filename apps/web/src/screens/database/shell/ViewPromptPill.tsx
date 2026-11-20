import { Plural, Trans } from '@lingui/react/macro';
import { Button } from '@riosoma/ui';
import type { ViewPrompts } from '../../../data/types';
import './shell.css';

export function ViewPromptPill({ prompts, onRefresh }: { prompts: ViewPrompts; onRefresh(): void }) {
  const count = prompts.entered;
  if (prompts.entered <= 0 && prompts.left.size === 0 && !prompts.orderChanged) return null;
  return (
    <div className="rio-db-prompt">
      <Button size="sm" onPress={onRefresh}>
        {prompts.entered > 0 ? (
          <Plural id="database.prompt.newRecords" value={count} one="# new record" other="# new records" />
        ) : (
          <Trans id="database.prompt.changed">View changed</Trans>
        )}
      </Button>
    </div>
  );
}
