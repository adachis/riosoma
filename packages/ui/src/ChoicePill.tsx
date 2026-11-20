import { faXmark } from '@fortawesome/free-solid-svg-icons';
import { useLingui } from '@lingui/react/macro';
import type { ChoiceColor } from '@riosoma/contracts';
import { Icon } from '@riosoma/icons';
import { Button as AriaButton, Focusable } from 'react-aria-components';
import { useLayoutEffect, useRef, useState, type RefObject } from 'react';
import { Tooltip, TooltipTrigger } from './Tooltip';
import { cx } from './cx';
import './ChoicePill.css';

/** `sm` is the size for a grid cell, `md` the size for everywhere else. */
export type ChoicePillSize = 'sm' | 'md';

export interface ChoicePillProps {
  /** The option's name, already translated by the caller. */
  name: string;
  color: ChoiceColor;
  size?: ChoicePillSize;
  /** Given, the pill shows the button that takes this option off the record. */
  onRemove?: () => void;
  className?: string;
}

/** True while the text inside the label is wider than the box that clips it. */
function isCutOff(label: RefObject<HTMLSpanElement | null>): boolean {
  const element = label.current;
  return element != null && element.scrollWidth > element.clientWidth;
}

/**
 * One option's name on a tint of the color that belongs to it.  The pill stays on one line and
 * clips with an ellipsis, and the whole name is a tooltip away only while it really is cut off: a
 * name that fits has no reason to repeat itself.  Nothing changes size between states — the border
 * is always there and only takes a color in forced colors, and the remove button keeps its room
 * for as long as it is mounted.
 */
export function ChoicePill({ name, color, size = 'md', onRemove, className }: ChoicePillProps) {
  const { t } = useLingui();
  const labelRef = useRef<HTMLSpanElement>(null);
  const [cutOff, setCutOff] = useState(false);

  // Measured after every render: a new name changes the text without changing the box, which is
  // the one change a resize observer cannot see.
  useLayoutEffect(() => {
    setCutOff(isCutOff(labelRef));
  });

  // The column a pill sits in can be dragged narrower without the pill rendering again.
  useLayoutEffect(() => {
    const label = labelRef.current;
    if (label == null || typeof ResizeObserver !== 'function') return;
    const observer = new ResizeObserver(() => setCutOff(isCutOff(labelRef)));
    observer.observe(label);
    return () => observer.disconnect();
  }, []);

  return (
    <span className={cx('rio-choice-pill', className)} data-color={color} data-size={size}>
      <TooltipTrigger isDisabled={!cutOff}>
        {/*
          React Aria hands its tooltip props to a focusable child, and `img` is the role it accepts
          for an element that is not a control.  The remove button stays outside that element, since
          the children of an image are presentational.  The trigger is out of the tab order: the
          whole name is already the label's accessible name, so the tooltip serves the pointer.
        */}
        <Focusable excludeFromTabOrder>
          <span ref={labelRef} className="rio-choice-pill__label" role="img" aria-label={name}>
            {name}
          </span>
        </Focusable>
        <Tooltip>{name}</Tooltip>
      </TooltipTrigger>
      {onRemove == null ? null : (
        <TooltipTrigger>
          <AriaButton
            className="rio-choice-pill__remove"
            aria-label={t({ id: 'ui.pill.remove', message: `Remove ${name}` })}
            onPress={onRemove}
          >
            <Icon icon={faXmark} size="1em" />
          </AriaButton>
          <Tooltip>{t({ id: 'ui.pill.remove', message: `Remove ${name}` })}</Tooltip>
        </TooltipTrigger>
      )}
    </span>
  );
}
