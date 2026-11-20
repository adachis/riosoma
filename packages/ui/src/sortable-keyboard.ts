import type { KeyboardEvent as ReactKeyboardEvent } from 'react';
import type { KeyboardSensorOptions, SensorProps } from '@dnd-kit/core';

export interface SortableKeyboardOptions extends KeyboardSensorOptions {
  moveKeys?: string[];
}

/** Capture drag keys before a surrounding popover can navigate or dismiss itself */
export class SortableKeyboardSensor {
  autoScrollEnabled = false;
  private document: Document;
  private window: Window | null;
  private origin: { x: number; y: number };
  private coordinates: { x: number; y: number };
  private finished = false;
  private activator: HTMLElement;

  static activators = [
    {
      eventName: 'onKeyDown' as const,
      handler(event: ReactKeyboardEvent) {
        if (event.target !== event.currentTarget) return false;
        if (event.code !== 'Space' && event.code !== 'Enter') return false;
        event.preventDefault();
        return true;
      },
    },
  ];

  constructor(private props: SensorProps<SortableKeyboardOptions>) {
    const element = props.activeNode.activatorNode.current ?? props.activeNode.node.current!;
    this.activator = element;
    this.document = element.ownerDocument;
    this.window = this.document.defaultView;
    const rect = props.activeNode.node.current!.getBoundingClientRect();
    this.origin = { x: rect.left, y: rect.top };
    this.coordinates = this.origin;
    this.document.addEventListener('keydown', this.key, true);
    this.document.addEventListener('pointerdown', this.cancel, true);
    this.activator.addEventListener('focusout', this.cancel);
    this.window?.addEventListener('blur', this.cancel);
    this.window?.addEventListener('resize', this.cancel);
    props.onStart({ x: 0, y: 0 });
  }

  private cancel = () => this.finish(true);

  private finish(canceled: boolean) {
    if (this.finished) return;
    this.finished = true;
    this.document.removeEventListener('keydown', this.key, true);
    this.document.removeEventListener('pointerdown', this.cancel, true);
    this.activator.removeEventListener('focusout', this.cancel);
    this.window?.removeEventListener('blur', this.cancel);
    this.window?.removeEventListener('resize', this.cancel);
    if (canceled) this.props.onCancel();
    else this.props.onEnd();
  }

  private key = (event: KeyboardEvent) => {
    if (event === this.props.event) return;
    const key = event.code;
    if (
      ![
        'Space',
        'Enter',
        'Escape',
        'Tab',
        ...(this.props.options.moveKeys ?? ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight']),
      ].includes(key)
    )
      return;
    if (key === 'Tab') return this.finish(true);
    event.preventDefault();
    event.stopPropagation();
    if (key === 'Escape') return this.finish(true);
    if (key === 'Space' || key === 'Enter') return this.finish(false);
    const next = this.props.options.coordinateGetter?.(event, {
      active: this.props.active,
      currentCoordinates: this.coordinates,
      context: this.props.context.current,
    });
    if (next) {
      this.coordinates = next;
      this.props.onMove({ x: next.x - this.origin.x, y: next.y - this.origin.y });
    }
  };
}
