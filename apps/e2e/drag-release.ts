import { expect, type Locator } from './accessibility';

type Point = { x: number; y: number };

/** Follow a destination out of the scrolling edge, then check the preview at the actual release. */
export async function releaseDrag(
  target: Locator,
  move: (point: Point) => Promise<unknown>,
  release: (point: Point) => Promise<unknown>,
  options: {
    measure?: () => Promise<Point>;
    highlight?: Locator;
    attribute?: 'data-drop-target' | 'data-drop-before' | 'data-rio-drop';
    value?: string;
    event?: 'pointerup' | 'touchend';
  } = {},
) {
  const measure =
    options.measure ??
    (() =>
      target.evaluate((element) => {
        const rect = element.getBoundingClientRect();
        return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
      }));
  let contact: Point;
  await expect(async () => {
    await target.evaluate((element) =>
      element.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'instant' }),
    );
    contact = await measure();
    await target.evaluate((element, point) => {
      for (let parent = element.parentElement; parent; parent = parent.parentElement) {
        const style = getComputedStyle(parent);
        const rect =
          parent === document.scrollingElement
            ? { left: 0, top: 0, width: innerWidth, height: innerHeight }
            : parent.getBoundingClientRect();
        const before = { x: parent.scrollLeft, y: parent.scrollTop };
        if (/auto|scroll|overlay/.test(style.overflowY))
          parent.scrollTop += point.y - (rect.top + rect.height / 2);
        if (/auto|scroll|overlay/.test(style.overflowX))
          parent.scrollLeft += point.x - (rect.left + rect.width / 2);
        point.x -= parent.scrollLeft - before.x;
        point.y -= parent.scrollTop - before.y;
      }
    }, contact);
    contact = await measure();
    await move(contact);
    expect(
      await target.evaluate(async (element, point) => {
        const before = element.getBoundingClientRect().toJSON();
        await new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done())));
        if (JSON.stringify(element.getBoundingClientRect().toJSON()) !== JSON.stringify(before)) return false;
        for (let parent = element.parentElement; parent; parent = parent.parentElement) {
          const style = getComputedStyle(parent);
          const root = parent === document.scrollingElement;
          const rect = root
            ? { left: 0, top: 0, width: innerWidth, height: innerHeight }
            : parent.getBoundingClientRect();
          // Sortable's pointer scroller uses the outer 20% of each scrollable ancestor.
          // A contact at a scroll limit is safe too, since it cannot move the destination.
          for (const axis of ['x', 'y'] as const) {
            const vertical = axis === 'y';
            if (!/auto|scroll|overlay/.test(vertical ? style.overflowY : style.overflowX)) continue;
            const offset = vertical ? parent.scrollTop : parent.scrollLeft;
            const maximum = vertical
              ? parent.scrollHeight - parent.clientHeight
              : parent.scrollWidth - parent.clientWidth;
            const start = vertical ? rect.top : rect.left;
            const size = vertical ? rect.height : rect.width;
            if (
              maximum > 1 &&
              ((point[axis] < start + size * 0.2 && offset > 0) ||
                (point[axis] > start + size * 0.8 && offset < maximum - 1))
            )
              return false;
          }
        }
        return true;
      }, contact),
      'the contact cannot edge scroll any destination ancestor',
    ).toBe(true);
    expect(await measure(), 'the destination stayed under the contact').toEqual(contact);
    if (options.highlight)
      await expect(options.highlight).toHaveAttribute(
        options.attribute ?? 'data-drop-before',
        options.value ?? 'true',
        {
          timeout: 200,
        },
      );
  }).toPass({ timeout: 5_000, intervals: [50, 100] });

  const highlighted = options.highlight ? await options.highlight.elementHandle() : null;
  const witness = await target.evaluateHandle(
    (element, { highlighted, attribute, value, event }) => {
      const selector = '[data-drop-before="true"], [data-drop-target="true"], [data-rio-drop="ready"]';
      const markers = Array.from(document.querySelectorAll(selector));
      const rect = JSON.stringify(element.getBoundingClientRect().toJSON());
      const result = { released: false, samePosition: false, sameHighlight: false, highlighted: false };
      const record = () => {
        result.released = true;
        result.highlighted = !highlighted || highlighted.getAttribute(attribute) === value;
        result.samePosition = JSON.stringify(element.getBoundingClientRect().toJSON()) === rect;
        const current = Array.from(document.querySelectorAll(selector));
        result.sameHighlight =
          current.length === markers.length && current.every((node, i) => node === markers[i]);
        dispose();
      };
      const dispose = () => {
        window.removeEventListener('pointerup', record, true);
        window.removeEventListener('touchend', record, true);
      };
      window.addEventListener(event, record, true);
      return { result, dispose };
    },
    {
      highlighted,
      attribute: options.attribute ?? 'data-drop-before',
      value: options.value ?? 'true',
      event: options.event ?? 'pointerup',
    },
  );
  try {
    await release(contact!);
    expect(await witness.evaluate(({ result }) => result)).toEqual({
      released: true,
      highlighted: true,
      samePosition: true,
      sameHighlight: true,
    });
  } finally {
    await witness.evaluate(({ dispose }) => dispose());
    await witness.dispose();
    await highlighted?.dispose();
  }
}
