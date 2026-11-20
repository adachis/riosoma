import { faCircleQuestion } from '@fortawesome/free-solid-svg-icons';
import { useLingui } from '@lingui/react/macro';
import { Button, Tooltip, TooltipTrigger } from '@riosoma/ui';
import { requestHelp } from './help-request';
import './help-button.css';

export function HelpButton({
  subject,
  moduleId,
  section,
  onPress,
}: {
  subject: string;
  moduleId: string;
  section?: string;
  onPress?(): void;
}) {
  const { t } = useLingui();
  return (
    <TooltipTrigger>
      <Button
        className="rio-help-button"
        variant="quiet"
        size="sm"
        icon={faCircleQuestion}
        aria-label={t({ id: 'docs.helpWithSubject', message: `Help with ${subject}` })}
        onPress={() => {
          requestHelp({ id: moduleId, section });
          onPress?.();
        }}
      />
      <Tooltip>{t({ id: 'docs.helpWithThis', message: 'Help with this' })}</Tooltip>
    </TooltipTrigger>
  );
}
