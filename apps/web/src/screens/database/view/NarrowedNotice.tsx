import { useLingui } from '@lingui/react/macro';
import { Banner, Button } from '@riosoma/ui';
import './view.css';

/**
 * Says a view shows only the records behind part of a dashboard chart, because a link narrowed it
 * for this person alone, and puts every record back.  The view's own filter is untouched.
 */
export function NarrowedNotice({ onClear }: { onClear(): void }) {
  const { t } = useLingui();
  return (
    <div className="rio-narrowed-notice">
      <Banner tone="info">
        <div className="rio-narrowed-notice__body">
          <p>
            {t({
              id: 'views.narrowed.notice',
              message:
                'This view shows only the records behind part of a dashboard chart.  Its own filter hasn’t changed.',
            })}
          </p>
          <Button size="sm" onPress={onClear}>
            {t({ id: 'views.narrowed.clear', message: 'Show all records' })}
          </Button>
        </div>
      </Banner>
    </div>
  );
}
