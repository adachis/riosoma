import { useState } from 'react';
import { useLingui } from '@lingui/react/macro';
import { checkCellValue, prettyJson, type FieldMeta, type TextConflict } from '@riosoma/contracts';
import { Button, Dialog, DialogBody, DialogFooter, DialogTitle, Modal, TextArea } from '@riosoma/ui';
import './text-edits.css';

export interface TextConflictDialogProps {
  field: FieldMeta;
  conflict: TextConflict;
  pending?: boolean;
  onChoose(value: string | null): void;
  onClose(): void;
}

/** Closing preserves the unsaved draft; every choice is checked again against the returned base. */
export function TextConflictDialog({
  field,
  conflict,
  pending = false,
  onChoose,
  onClose,
}: TextConflictDialogProps) {
  const { t, i18n } = useLingui();
  const [proposal, setProposal] = useState(conflict.proposal);
  const name = conflict.name ?? t({ id: 'textEdit.someone', message: 'Someone else' });
  const when = new Intl.DateTimeFormat(i18n.locale, { dateStyle: 'medium', timeStyle: 'short' }).format(
    new Date(conflict.updatedAt),
  );
  const checked = checkCellValue(field, proposal === '' ? null : proposal);
  const marked = /<<<<<<<|=======|>>>>>>>/u.test(proposal);
  const text = (value: string | null) =>
    field.type === 'json' && value !== null ? prettyJson(value) : (value ?? '');
  return (
    <Modal
      size="lg"
      isOpen
      isDismissable={!pending}
      isKeyboardDismissDisabled={pending}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <Dialog hideCloseButton className="rio-text-conflict">
        <DialogTitle>{t({ id: 'textEdit.conflict.title', message: 'Resolve text conflict' })}</DialogTitle>
        <DialogBody>
          <p>
            {t({
              id: 'textEdit.conflict.help',
              message: 'Your text has not been saved.  Choose a version or edit the combined text.',
            })}
          </p>
          <p>{t({ id: 'textEdit.conflict.author', message: `${name} changed this cell on ${when}.` })}</p>
          <div className="rio-text-conflict__versions">
            <TextArea
              label={t({ id: 'textEdit.mine', message: 'Your text' })}
              value={text(conflict.ours)}
              isReadOnly
              rows={8}
            />
            <TextArea
              label={t({ id: 'textEdit.theirs', message: 'Their text' })}
              value={text(conflict.theirs)}
              isReadOnly
              rows={8}
            />
          </div>
          <TextArea
            label={t({ id: 'textEdit.combined', message: 'Combined text' })}
            value={proposal}
            onChange={setProposal}
            rows={10}
            description={t({
              id: 'textEdit.markers',
              message:
                'Conflicting spans are between <<<<<<<, =======, and >>>>>>>.  Remove the markers and keep the text you want.',
            })}
          />
          {!checked.ok && (
            <p role="status">
              {t({
                id: 'textEdit.invalid',
                message: 'The combined text must be valid for this field before you can save it.',
              })}
            </p>
          )}
        </DialogBody>
        <DialogFooter>
          <Button isDisabled={pending} onPress={onClose}>
            {t({ id: 'textEdit.back', message: 'Back to editing' })}
          </Button>
          <Button isDisabled={pending} onPress={() => onChoose(conflict.ours)}>
            {t({ id: 'textEdit.keepMine', message: 'Keep mine' })}
          </Button>
          <Button isDisabled={pending} onPress={() => onChoose(conflict.theirs)}>
            {t({ id: 'textEdit.useTheirs', message: 'Use theirs' })}
          </Button>
          <Button
            variant="primary"
            isDisabled={pending || marked || !checked.ok}
            onPress={() => onChoose(proposal === '' ? null : proposal)}
          >
            {t({ id: 'textEdit.saveCombined', message: 'Save combined text' })}
          </Button>
        </DialogFooter>
      </Dialog>
    </Modal>
  );
}
