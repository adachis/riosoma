import {
  PointerSensor,
  TouchSensor,
  type PointerSensorProps,
  type TouchSensorOptions,
  type SensorProps,
} from '@dnd-kit/core';
import { TOUCH_DRAG_ACTIVATION } from '@riosoma/tokens';

/** Editing and selecting text must not pick up the enclosing item. */
export function sortablePointerTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  const item = target.closest('[data-sortable-id]');
  const control = target.closest(
    'input, textarea, select, button, [contenteditable]:not([contenteditable="false"]), [role="textbox"], [role="combobox"], [role="slider"], [data-sortable-selectable]',
  );
  return (
    !control ||
    (!!control.closest('.rio-sortable-handle, [data-sortable-surface]') &&
      control.closest('[data-sortable-id]') === item)
  );
}

/** Cancel before an enclosing overlay handles Escape and discards its draft */
type TouchSensorProps = SensorProps<TouchSensorOptions>;

function captureEscape<T extends PointerSensorProps | TouchSensorProps>(props: T, cancelEvent: string): T {
  const target = props.event.target as HTMLElement;
  const document = target.ownerDocument;
  const key = (event: KeyboardEvent) => {
    if (event.code !== 'Escape') return;
    event.preventDefault();
    event.stopPropagation();
    target.dispatchEvent(new Event(cancelEvent, { bubbles: true }));
  };
  const detach = () => document.removeEventListener('keydown', key, true);
  return {
    ...props,
    onStart(coordinates) {
      document.addEventListener('keydown', key, true);
      props.onStart(coordinates);
    },
    onEnd() {
      detach();
      props.onEnd();
    },
    onCancel() {
      detach();
      props.onCancel();
    },
  };
}

// Touch and pen use a delay so brief contact leaves scrolling and clicks alone.
export class SortablePointerSensor extends PointerSensor {
  static override activators = PointerSensor.activators.map((activator) => ({
    ...activator,
    handler: (...args: Parameters<typeof activator.handler>) =>
      args[0].nativeEvent.pointerType !== 'touch' &&
      sortablePointerTarget(args[0].nativeEvent.target) &&
      activator.handler(...args),
  }));
  constructor(props: PointerSensorProps) {
    super(
      captureEscape(
        (props.event as PointerEvent).pointerType === 'pen'
          ? { ...props, options: { ...props.options, activationConstraint: TOUCH_DRAG_ACTIVATION } }
          : props,
        'pointercancel',
      ),
    );
  }
}

export class SortableTouchSensor extends TouchSensor {
  static override activators = TouchSensor.activators.map((activator) => ({
    ...activator,
    handler: (...args: Parameters<typeof activator.handler>) =>
      sortablePointerTarget(args[0].nativeEvent.target) && activator.handler(...args),
  }));
  constructor(props: TouchSensorProps) {
    super(captureEscape(props, 'touchcancel'));
  }
}

/**
 * Whether edge scrolling during a drag may move this container.  An open popover or dialog locks
 * the page with `overflow: hidden`, yet the page can still hold a pixel of scroll.  Edge scrolling
 * tries the page first, so it would spend a held finger on that pixel and never reach the popover
 * beneath it until the finger moved again.
 */
export function canAutoScroll(element: Element): boolean {
  if (element !== element.ownerDocument.scrollingElement) return true;
  const { overflow, overflowX, overflowY } = getComputedStyle(element);
  return overflow !== 'hidden' && (overflowX !== 'hidden' || overflowY !== 'hidden');
}
