import { useLingui } from '@lingui/react/macro';
import { useRouter } from '@tanstack/react-router';
import { faCircleQuestion } from '@fortawesome/free-solid-svg-icons';
import { Button } from '@riosoma/ui';
import './footprint.css';

/** The help topic that explains how footprint estimates are made and what their ranges mean. */
export const FOOTPRINT_HELP = 'ai-footprint';

/**
 * Opens the footprint help topic beside the page.  Outside the app's router, as in a component's
 * own tests, it shows without anywhere to go.
 */
export function FootprintHelp({ onOpen }: { onOpen?: () => void }) {
  const { t } = useLingui();
  const router = useRouter({ warn: false });
  return (
    <Button
      variant="quiet"
      size="sm"
      icon={faCircleQuestion}
      className="rio-footprint__help"
      onPress={() => {
        onOpen?.();
        void router?.navigate({
          to: '.',
          search: (previous: Record<string, unknown>) => ({ ...previous, help: FOOTPRINT_HELP }),
        });
      }}
    >
      {t({ id: 'ai.footprint.howEstimated', message: 'How it’s estimated' })}
    </Button>
  );
}
