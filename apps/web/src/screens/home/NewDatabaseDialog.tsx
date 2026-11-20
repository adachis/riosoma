import { Trans, useLingui } from '@lingui/react/macro';
import { CHOICE_COLORS, LIMITS } from '@riosoma/contracts';
import {
  Banner,
  Button,
  ColorSwatchPicker,
  Dialog,
  DialogBody,
  DialogFooter,
  DialogTitle,
  Modal,
  TextField,
} from '@riosoma/ui';
import { useEffect, useRef, useState } from 'react';
import type { NewDatabaseValues } from './payload';
import './home.css';
import { TemplatePicker, type TemplateSummary } from './TemplatePicker';
import { TemplateDatabaseForm } from './TemplateDatabaseForm';

export interface NewDatabaseDialogProps {
  onSubmit(values: NewDatabaseValues): void;
  onClose(): void;
  isCreating: boolean;
  error?: string;
  /** Organization admins may remove the organization's own templates */
  canRemoveTemplates?: boolean;
}

const colors = CHOICE_COLORS.filter((color) => color !== 'gray');

export function NewDatabaseDialog({
  onSubmit,
  onClose,
  isCreating,
  error,
  canRemoveTemplates = false,
}: NewDatabaseDialogProps) {
  const { t } = useLingui();
  const form = useRef<HTMLFormElement>(null);
  const [template, setTemplate] = useState<TemplateSummary | null>(null);
  const [templatePending, setTemplatePending] = useState(false);
  const pending = isCreating || templatePending;
  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      const input = form.current?.querySelector('input');
      input?.focus();
      input?.select();
    });
    return () => cancelAnimationFrame(frame);
  }, []);
  const [name, setName] = useState(() => t({ id: 'home.default.database', message: 'Untitled database' }));
  const [color, setColor] = useState<NewDatabaseValues['color']>(
    () => colors[Math.floor(Math.random() * colors.length)]!,
  );
  return (
    <Modal
      isOpen
      // Wide enough for two columns of template cards.
      size="lg"
      onOpenChange={(open) => {
        if (!open && !pending) onClose();
      }}
      isDismissable={!pending}
      isKeyboardDismissDisabled={pending}
    >
      <Dialog hideCloseButton>
        <DialogTitle>
          <Trans id="home.dialog.title">New database</Trans>
        </DialogTitle>
        <DialogBody>
          <TemplatePicker
            selected={template}
            onSelect={setTemplate}
            disabled={pending}
            canRemove={canRemoveTemplates}
          />
        </DialogBody>
        {template ? (
          <TemplateDatabaseForm
            key={template.id}
            template={template}
            onClose={onClose}
            onPendingChange={setTemplatePending}
          />
        ) : (
          <form
            ref={form}
            onSubmit={(event) => {
              event.preventDefault();
              if (!isCreating && name.trim()) onSubmit({ name: name.trim(), color });
            }}
          >
            <DialogBody className="rio-new-database__fields">
              <TextField
                label={t({ id: 'home.dialog.name', message: 'Name' })}
                value={name}
                onChange={setName}
                maxLength={LIMITS.nameLength}
                isRequired
                isDisabled={isCreating}
              />
              <ColorSwatchPicker
                label={t({ id: 'home.dialog.color', message: 'Color' })}
                value={color}
                onChange={setColor}
                isDisabled={isCreating}
              />
              <div className="rio-new-database__error">
                {error ? <Banner tone="danger">{error}</Banner> : null}
              </div>
            </DialogBody>
            <DialogFooter>
              <Button onPress={onClose} isDisabled={isCreating}>
                <Trans id="home.dialog.cancel">Cancel</Trans>
              </Button>
              <Button type="submit" variant="primary" isPending={isCreating} isDisabled={!name.trim()}>
                <Trans id="home.dialog.create">Create</Trans>
              </Button>
            </DialogFooter>
          </form>
        )}
      </Dialog>
    </Modal>
  );
}
