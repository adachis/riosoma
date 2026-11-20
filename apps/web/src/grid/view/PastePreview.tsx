import { serverMessage } from '../../messages/useServerMessage';
import { useLingui, Plural, Trans } from '@lingui/react/macro';
import { Button, Dialog, DialogBody, DialogFooter, DialogTitle, Modal } from '@riosoma/ui';
import type { FieldMeta } from '@riosoma/contracts';
import type { PastePlan } from '../clipboard/plan';

export function PastePreview({
  plan,
  fields,
  onPaste,
  onCancel,
}: {
  plan: PastePlan;
  fields: ReadonlyMap<string, FieldMeta>;
  onPaste(): void;
  onCancel(): void;
}) {
  const { i18n, t } = useLingui();
  return (
    <Modal
      isOpen
      isDismissable
      onOpenChange={(open) => {
        if (!open) onCancel();
      }}
    >
      <Dialog hideCloseButton>
        <DialogTitle>
          <Plural id="grid.paste.title" value={plan.cellCount} one="Paste # cell?" other="Paste # cells?" />
        </DialogTitle>
        <DialogBody tabIndex={0}>
          {plan.creates.length > 0 && (
            <p>
              <Plural
                id="grid.paste.creates"
                value={plan.creates.length}
                one="Adds # new record."
                other="Adds # new records."
              />
            </p>
          )}
          {[...plan.newChoices].map(([id, options]) => {
            const field = fields.get(id)?.name ?? id;
            const names = options.join(', ');
            return (
              <p key={id}>
                <Trans id="grid.paste.options">
                  Adds options to {field}: {names}
                </Trans>
              </p>
            );
          })}
          {plan.problems.length > 0 && (
            <ul>
              {plan.problems.map((problem, index) => {
                const row = problem.row + 1;
                const column = problem.col + 1;
                const detail =
                  problem.message || serverMessage(i18n, problem.messageKey ?? 'data.value.invalid');
                return (
                  <li key={index}>
                    {t({ id: 'grid.paste.problem', message: `Row ${row}, column ${column}: ${detail}` })}
                  </li>
                );
              })}
            </ul>
          )}
          {plan.problems.length > 0 && (
            <p>
              <Plural
                id="grid.paste.problems"
                value={plan.problems.length}
                one="# value can’t be read and will be skipped."
                other="# values can’t be read and will be skipped."
              />
            </p>
          )}
        </DialogBody>
        <DialogFooter>
          <Button onPress={onCancel}>
            <Trans id="grid.paste.cancel">Cancel</Trans>
          </Button>
          <Button variant="primary" isDisabled={plan.refused} onPress={onPaste}>
            <Trans id="grid.paste.confirm">Paste</Trans>
          </Button>
        </DialogFooter>
      </Dialog>
    </Modal>
  );
}
