import type { BrowserContext, Locator, Page } from '@playwright/test';

export async function dragInput(
  page: Page,
  context: BrowserContext,
  browserName: string,
  handle: Locator,
  mode: 'touch' | 'touch-pointer' | 'pen' = 'touch',
) {
  if (browserName === 'chromium') return context.newCDPSession(page);
  let last = { x: 0, y: 0 };
  return {
    async send(
      _method: string,
      input: {
        type: string;
        touchPoints?: Array<{ x: number; y: number; id: number }>;
        x?: number;
        y?: number;
        pointerType?: string;
        button?: string;
        buttons?: number;
        clickCount?: number;
      },
    ) {
      last =
        input.touchPoints?.[0] ??
        (input.x !== undefined && input.y !== undefined ? { x: input.x, y: input.y } : last);
      await handle.evaluate(
        (element, { input, last, mode }) => {
          const phase = /Start|Pressed$/.test(input.type)
            ? 'start'
            : /Move|Moved$/.test(input.type)
              ? 'move'
              : 'end';
          if (mode !== 'touch') {
            element.dispatchEvent(
              new PointerEvent(
                phase === 'start' ? 'pointerdown' : phase === 'move' ? 'pointermove' : 'pointerup',
                {
                  bubbles: true,
                  cancelable: true,
                  pointerId: 1,
                  pointerType: mode === 'pen' ? 'pen' : 'touch',
                  buttons: input.buttons ?? (phase === 'end' ? 0 : 1),
                  isPrimary: true,
                  button: 0,
                  clientX: last.x,
                  clientY: last.y,
                },
              ),
            );
          } else {
            // Desktop engines may omit touch constructors.  Synthetic contact still needs the
            // event identity used by pointer libraries when they normalize its coordinates.
            if (typeof TouchEvent === 'undefined')
              Object.defineProperty(window, 'TouchEvent', { value: class extends Event {} });
            const event = new TouchEvent(`touch${phase}`, { bubbles: true, cancelable: true });
            const touches = (input.touchPoints ?? []).map((point) => ({
              identifier: point.id,
              target: element,
              clientX: point.x,
              clientY: point.y,
            }));
            Object.defineProperties(event, {
              touches: { value: touches },
              targetTouches: { value: touches },
              changedTouches: {
                value:
                  phase === 'end'
                    ? [{ identifier: 1, target: element, clientX: last.x, clientY: last.y }]
                    : touches,
              },
            });
            element.dispatchEvent(event);
          }
        },
        { input, last, mode },
      );
    },
    async detach() {},
  };
}
