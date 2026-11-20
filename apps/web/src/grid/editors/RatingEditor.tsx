import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { useLingui } from '@lingui/react/macro';
import { cellValue, type FieldOptionsOf } from '@riosoma/contracts';
import { Button } from '@riosoma/ui';
import { faXmark } from '@fortawesome/free-solid-svg-icons';
import { ratingIcons } from '../ratingIcons';
import { EditorPopover } from './EditorPopover';
import { applyValue, type EditorProps } from './types';
import './AdditionalEditors.css';

interface RatingControlProps {
  options: FieldOptionsOf<'rating'>;
  value: number | null;
  label: string;
  autoFocus?: boolean;
  readOnly?: boolean;
  onChange: (value: number | null) => void;
}

export function RatingControl({
  options,
  value: selected,
  label,
  autoFocus,
  readOnly,
  onChange,
}: RatingControlProps) {
  const { t } = useLingui();
  const { max } = options;
  const root = useRef<HTMLDivElement>(null);
  const [focused, setFocused] = useState(selected || 1);
  return (
    <div
      ref={root}
      role="group"
      aria-label={label}
      className="rio-rating-control"
      style={{ '--rio-rating-color': `var(--rio-aa-choice-${options.color})` } as CSSProperties}
      onKeyDownCapture={(event) => {
        if (readOnly || event.nativeEvent.isComposing || event.ctrlKey || event.metaKey || event.altKey)
          return;
        if (/^(?:[0-9]|10)$/.test(event.key)) {
          const next = Number(event.key);
          if (next <= max) {
            event.preventDefault();
            event.stopPropagation();
            onChange(next || null);
          }
        } else if (['ArrowRight', 'ArrowLeft', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) {
          event.preventDefault();
          event.stopPropagation();
          const rtl = getComputedStyle(event.currentTarget).direction === 'rtl';
          const forward = event.key === 'ArrowUp' || event.key === (rtl ? 'ArrowLeft' : 'ArrowRight');
          const next =
            event.key === 'Home'
              ? 1
              : event.key === 'End'
                ? max
                : Math.max(1, Math.min(max, focused + (forward ? 1 : -1)));
          setFocused(next);
          root.current?.querySelectorAll<HTMLButtonElement>('button')[next - 1]?.focus();
        }
      }}
    >
      {Array.from({ length: max }, (_, index) => index + 1).map((rating) => {
        const value = rating;
        return (
          <Button
            key={rating}
            variant="quiet"
            className="rio-rating-control__icon"
            icon={ratingIcons[options.icon]}
            aria-label={t({ id: 'grid.rating.label', message: `${value} of ${max}` })}
            aria-pressed={rating === selected}
            data-filled={rating <= (selected ?? 0)}
            isDisabled={readOnly}
            autoFocus={autoFocus && rating === focused}
            onFocus={() => setFocused(rating)}
            onPress={() => onChange(rating === selected ? null : rating)}
          />
        );
      })}
      <Button
        variant="quiet"
        icon={faXmark}
        aria-label={t({ id: 'grid.rating.clear', message: 'Clear rating' })}
        isDisabled={readOnly}
        onPress={() => onChange(null)}
      />
    </div>
  );
}

export function RatingEditor(props: EditorProps) {
  const { request, context } = props;
  const field = context.field;
  const stored = cellValue(request.row, field);
  const [value, setValue] = useState(typeof stored === 'number' ? stored : null);
  const ended = useRef(false);
  useEffect(() => {
    const text = request.initialText;
    if (ended.current || text === null || text === undefined || !/^\d+$/.test(text)) return;
    if (applyValue(context, Number(text))) {
      ended.current = true;
      request.done('down');
    }
  }, [context, request]);
  function finish(move: 'down' | 'next' | 'previous' | 'none') {
    if (ended.current) return;
    ended.current = true;
    request.done(move);
  }
  if (field.type !== 'rating') return null;
  return (
    <EditorPopover
      {...props}
      onDismiss={() => finish('none')}
      onTab={(event) => {
        event.preventDefault();
        event.stopPropagation();
        finish(event.shiftKey ? 'previous' : 'next');
      }}
    >
      <div>
        <RatingControl
          options={field.options}
          value={value}
          label={field.name}
          autoFocus
          onChange={(next) => {
            if (!ended.current && applyValue(context, next)) {
              setValue(next);
              finish('down');
            }
          }}
        />
      </div>
    </EditorPopover>
  );
}
