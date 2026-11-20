import { useLingui } from '@lingui/react/macro';
import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { Button } from './Button';
import { Dialog, DialogBody, DialogFooter, DialogTitle } from './Dialog';
import { Modal } from './Modal';
import './ConfirmDialog.css';

/** How strongly the confirm dialog warns: `danger` puts the action on the danger button variant. */
export type ConfirmTone = 'default' | 'danger';

/** The question a confirm dialog asks, and what runs when the answer is yes. */
export interface ConfirmOptions {
  title: ReactNode;
  message?: ReactNode;
  confirmLabel: ReactNode;
  /** Defaults to the shared "Cancel" string. */
  cancelLabel?: ReactNode;
  tone?: ConfirmTone;
  /** Destructive undo starts on the choice that keeps the item. */
  autoFocusCancel?: boolean;
  /** May return a promise; the confirm button stays pending until it settles. */
  onConfirm?: () => void | Promise<unknown>;
}

export interface ConfirmDialogProps extends ConfirmOptions {
  /** Whether the dialog is open (controlled). */
  isOpen?: boolean;
  /** Whether the dialog starts open (uncontrolled). */
  defaultOpen?: boolean;
  /** Called when the dialog opens or closes. */
  onOpenChange?: (isOpen: boolean) => void;
}

/**
 * The in-app replacement for the browser's confirm(), which no theme can style and which blocks
 * the whole page.  It has to be answered through its own buttons: there is no close button, and
 * while `onConfirm` runs every way out is closed so the work can't be abandoned halfway.
 */
export function ConfirmDialog({
  isOpen,
  defaultOpen,
  onOpenChange,
  title,
  message,
  confirmLabel,
  cancelLabel,
  tone = 'default',
  autoFocusCancel = false,
  onConfirm,
}: ConfirmDialogProps) {
  const { t } = useLingui();
  const [isUncontrolledOpen, setUncontrolledOpen] = useState(defaultOpen ?? false);
  const [isPending, setPending] = useState(false);
  const isControlled = isOpen !== undefined;
  const open = isControlled ? isOpen : isUncontrolledOpen;
  const cancelButton = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!open || !autoFocusCancel) return;
    // The dialog establishes its focus scope first, then the safe choice receives focus.
    const frame = requestAnimationFrame(() => cancelButton.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, [open, autoFocusCancel]);

  const setOpen = useCallback(
    (next: boolean) => {
      if (!isControlled) {
        setUncontrolledOpen(next);
      }
      onOpenChange?.(next);
    },
    [isControlled, onOpenChange],
  );

  async function confirm() {
    if (!onConfirm) {
      setOpen(false);
      return;
    }
    setPending(true);
    try {
      await onConfirm();
      setOpen(false);
    } catch {
      // A rejection keeps the dialog open, so the caller can try again or cancel instead of
      // losing the choice they were asked to make.
    } finally {
      setPending(false);
    }
  }

  return (
    <Modal
      isOpen={open}
      onOpenChange={setOpen}
      size="sm"
      isDismissable={!isPending}
      isKeyboardDismissDisabled={isPending}
    >
      <Dialog className="rio-confirm" hideCloseButton>
        <DialogTitle>{title}</DialogTitle>
        {message == null ? null : <DialogBody>{message}</DialogBody>}
        <DialogFooter>
          <Button
            ref={cancelButton}
            autoFocus={autoFocusCancel}
            isDisabled={isPending}
            onPress={() => setOpen(false)}
          >
            {cancelLabel ?? t({ id: 'ui.confirm.cancel', message: 'Cancel' })}
          </Button>
          <Button
            variant={tone === 'danger' ? 'danger' : 'primary'}
            isPending={isPending}
            onPress={() => {
              void confirm();
            }}
          >
            {confirmLabel}
          </Button>
        </DialogFooter>
      </Dialog>
    </Modal>
  );
}

/** Asks a question and resolves with the answer, so callers can `await confirm({...})`. */
export type ConfirmFn = (options: ConfirmOptions) => Promise<boolean>;

interface ConfirmRequest extends ConfirmOptions {
  id: number;
  resolve: (confirmed: boolean) => void;
}

const ConfirmContext = createContext<ConfirmFn | null>(null);

/**
 * Returns the `confirm` function of the closest `ConfirmProvider`.  It throws outside one, because
 * a confirm with nowhere to render would leave the caller awaiting forever.
 */
export function useConfirm(): ConfirmFn {
  const confirm = useContext(ConfirmContext);
  if (confirm === null) {
    throw new Error('useConfirm() needs a ConfirmProvider above it in the tree.');
  }
  return confirm;
}

export interface ConfirmProviderProps {
  children: ReactNode;
}

/**
 * Renders the dialog behind `useConfirm`.  One question is on screen at a time; anything asked
 * while it is open waits its turn, and a question keeps rendering after it is answered so its exit
 * animation can finish.
 */
export function ConfirmProvider({ children }: ConfirmProviderProps) {
  const [queue, setQueue] = useState<ConfirmRequest[]>([]);
  const [answered, setAnswered] = useState<ConfirmRequest | null>(null);
  const queued = useRef<ConfirmRequest[]>([]);
  const answeredId = useRef<number | null>(null);
  const nextId = useRef(0);

  useEffect(() => {
    queued.current = queue;
  }, [queue]);

  const answer = useCallback((request: ConfirmRequest, confirmed: boolean) => {
    // Only the question on screen can be answered, and confirming it also reports the close that
    // follows, so the same answer can arrive twice.
    if (answeredId.current === request.id) {
      return;
    }
    answeredId.current = request.id;
    request.resolve(confirmed);
    setAnswered(request);
    setQueue((current) => current.filter((item) => item.id !== request.id));
  }, []);

  const confirm = useCallback<ConfirmFn>(
    (options) =>
      new Promise<boolean>((resolve) => {
        const request: ConfirmRequest = { ...options, id: nextId.current++, resolve };
        setQueue((current) => [...current, request]);
      }),
    [],
  );

  // A provider that goes away with questions still open must settle them, or their callers hang.
  // Resolving one that was answered a moment ago is harmless: a promise settles once.
  useEffect(
    () => () => {
      for (const request of queued.current) {
        request.resolve(false);
      }
    },
    [],
  );

  const head = queue[0] ?? null;
  const request = head ?? answered;

  return (
    <ConfirmContext.Provider value={confirm}>
      {children}
      {request === null ? null : (
        <ConfirmDialog
          key={request.id}
          isOpen={head !== null}
          title={request.title}
          message={request.message}
          confirmLabel={request.confirmLabel}
          cancelLabel={request.cancelLabel}
          tone={request.tone}
          autoFocusCancel={request.autoFocusCancel}
          onConfirm={async () => {
            await request.onConfirm?.();
            answer(request, true);
          }}
          onOpenChange={(isOpen) => {
            if (!isOpen) {
              answer(request, false);
            }
          }}
        />
      )}
    </ConfirmContext.Provider>
  );
}
