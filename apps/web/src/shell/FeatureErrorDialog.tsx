import { useLingui } from '@lingui/react/macro';
import { Button } from '@riosoma/ui';
import { useLayoutEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { faXmark } from '@fortawesome/free-solid-svg-icons';
import { isAssetLoadError } from '../asset-recovery';
import { FeatureLoadError } from './lazy';

const dialogs: HTMLDialogElement[] = [];
const background = new Map<HTMLElement, { inert: string | null; hidden: string | null }>();
let trigger: Element | null = null;
let overflow = '';
let observer: MutationObserver | undefined;

function restore(element: HTMLElement, attributes: { inert: string | null; hidden: string | null }) {
  for (const [name, value] of [
    ['inert', attributes.inert],
    ['aria-hidden', attributes.hidden],
  ] as const) {
    if (value === null) element.removeAttribute(name);
    else element.setAttribute(name, value);
  }
}

function isolate() {
  const active = dialogs.at(-1)!;
  for (const element of document.body.children) {
    if (!(element instanceof HTMLElement)) continue;
    // Capture each original value once, before any dialog changes it.
    if (!background.has(element)) {
      background.set(element, {
        inert: element.getAttribute('inert'),
        hidden: element.getAttribute('aria-hidden'),
      });
    }
    if (element === active) {
      element.removeAttribute('inert');
      element.removeAttribute('aria-hidden');
    } else {
      element.setAttribute('inert', '');
      element.setAttribute('aria-hidden', 'true');
    }
  }
}

function openDialog(dialog: HTMLDialogElement, previousFocus: Element | null) {
  if (dialogs.length === 0) {
    trigger = previousFocus;
    overflow = document.documentElement.style.overflow;
    document.documentElement.style.overflow = 'hidden';
    // Background portals can mount while recovery is open and need the same isolation.
    observer = new MutationObserver(isolate);
    observer.observe(document.body, { childList: true });
  }
  dialogs.push(dialog);
  isolate();
  dialog.showModal();
  return () => {
    const wasActive = dialogs.at(-1) === dialog;
    dialogs.splice(dialogs.indexOf(dialog), 1);
    dialog.close();
    if (dialogs.length > 0) {
      isolate();
      if (wasActive)
        dialogs.at(-1)!.querySelector<HTMLButtonElement>('button')?.focus({ preventScroll: true });
      return;
    }
    observer?.disconnect();
    observer = undefined;
    for (const [element, attributes] of background) restore(element, attributes);
    background.clear();
    document.documentElement.style.overflow = overflow;
    if (trigger instanceof HTMLElement && trigger.isConnected) trigger.focus({ preventScroll: true });
    trigger = null;
  };
}

/** Native modality keeps recovery independent of the feature overlay and collection code. */
export default function FeatureErrorDialog({ onDismiss, error }: { onDismiss: () => void; error: unknown }) {
  const ref = useRef<HTMLDialogElement>(null);
  const previousFocus = useRef(document.activeElement);
  useLayoutEffect(() => {
    return openDialog(ref.current!, previousFocus.current);
  }, []);
  const { t } = useLingui();
  const close = t({ id: 'ui.dialog.close', message: 'Close' });
  const title = isAssetLoadError(error)
    ? t({ id: 'app.load.title', message: "This screen couldn't load" })
    : t({ id: 'app.load.problem.title', message: 'This part ran into a problem' });
  return createPortal(
    <dialog
      ref={ref}
      aria-label={title}
      aria-modal="true"
      className="rio-feature-loading-dialog rio-feature-error-dialog"
      onCancel={(event) => {
        event.preventDefault();
        onDismiss();
      }}
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.preventDefault();
          event.stopPropagation();
          onDismiss();
          return;
        }
        // Keep Tab inside the two recovery actions instead of moving focus into browser chrome.
        if (event.key !== 'Tab') return;
        const buttons = event.currentTarget.querySelectorAll<HTMLButtonElement>('button');
        const first = buttons[0]!;
        const last = buttons[buttons.length - 1]!;
        if (document.activeElement === (event.shiftKey ? first : last)) {
          event.preventDefault();
          (event.shiftKey ? last : first).focus();
        }
      }}
    >
      <div className="rio-feature-error-close" title={close}>
        <Button autoFocus icon={faXmark} variant="quiet" aria-label={close} onPress={onDismiss} />
      </div>
      <FeatureLoadError size="editor" error={error} />
    </dialog>,
    document.body,
  );
}
