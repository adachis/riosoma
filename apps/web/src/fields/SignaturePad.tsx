import { useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { useLingui } from '@lingui/react/macro';
import { LIMITS, type SignatureDrawing } from '@riosoma/contracts';
import { Button, TextField } from '@riosoma/ui';
import { strokesPath, type Point } from './signature';
import './fields.css';

export interface SignaturePadProps {
  /** What is being signed, for the pad's accessible name */
  label: string;
  autoFocus?: boolean;
  onSign: (signature: { drawing: SignatureDrawing | null; name: string | null }) => void;
  onCancel?: () => void;
}

/** The pad's size in pixels when the page hasn't laid it out, as in a test. */
const FALLBACK = { width: 400, height: 150 };

/**
 * A pad to sign on with a mouse, a pen, or a finger.  Strokes are kept as points and drawn on a
 * canvas as they come, and signing turns them into compact path data sized to the pad.  Typing a
 * name signs too, for anyone who can't or would rather not draw.
 */
export function SignaturePad({ label, autoFocus, onSign, onCancel }: SignaturePadProps) {
  const { t } = useLingui();
  const canvas = useRef<HTMLCanvasElement>(null);
  const strokes = useRef<Point[][]>([]);
  const size = useRef(FALLBACK);
  const active = useRef<number | null>(null);
  const [drawn, setDrawn] = useState(false);
  const [name, setName] = useState('');

  function surface() {
    const element = canvas.current;
    const context = element?.getContext('2d') ?? null;
    return element && context ? { element, context } : null;
  }

  /** Sizes the canvas to the pad and draws every stroke again, as after a resize or a clear. */
  function redraw() {
    const drawing = surface();
    if (!drawing) return;
    const { element, context } = drawing;
    const ratio = window.devicePixelRatio || 1;
    element.width = Math.round(size.current.width * ratio);
    element.height = Math.round(size.current.height * ratio);
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    context.clearRect(0, 0, size.current.width, size.current.height);
    context.lineWidth = 2;
    context.lineCap = 'round';
    context.lineJoin = 'round';
    context.strokeStyle = getComputedStyle(element).color;
    for (const stroke of strokes.current) {
      context.beginPath();
      context.moveTo(stroke[0]!.x, stroke[0]!.y);
      for (const point of stroke) context.lineTo(point.x, point.y);
      context.stroke();
    }
  }

  function pointAt(event: { clientX: number; clientY: number }): Point {
    const box = canvas.current!.getBoundingClientRect();
    return {
      x: Math.min(Math.max(event.clientX - box.left, 0), size.current.width),
      y: Math.min(Math.max(event.clientY - box.top, 0), size.current.height),
    };
  }

  function segment(from: Point, to: Point) {
    const drawing = surface();
    if (!drawing) return;
    drawing.context.beginPath();
    drawing.context.moveTo(from.x, from.y);
    drawing.context.lineTo(to.x, to.y);
    drawing.context.stroke();
  }

  function start(event: ReactPointerEvent<HTMLCanvasElement>) {
    if (active.current !== null || (event.pointerType === 'mouse' && event.button !== 0)) return;
    event.preventDefault();
    const box = event.currentTarget.getBoundingClientRect();
    // The first stroke fixes the pad's size, so every point of a drawing shares one frame.
    if (strokes.current.length === 0) {
      size.current =
        box.width >= 1 && box.height >= 1
          ? {
              width: Math.min(Math.round(box.width), LIMITS.signatureSize),
              height: Math.min(Math.round(box.height), LIMITS.signatureSize),
            }
          : FALLBACK;
      redraw();
    }
    event.currentTarget.setPointerCapture?.(event.pointerId);
    active.current = event.pointerId;
    const point = pointAt(event);
    strokes.current.push([point]);
    segment(point, point);
  }

  function move(event: ReactPointerEvent<HTMLCanvasElement>) {
    if (active.current !== event.pointerId) return;
    const stroke = strokes.current.at(-1)!;
    // Pens and fast mice report more points than frames, and the browser keeps the extras for us.
    const events = event.nativeEvent.getCoalescedEvents?.() ?? [];
    for (const each of events.length ? events : [event.nativeEvent]) {
      const point = pointAt(each);
      segment(stroke.at(-1)!, point);
      stroke.push(point);
    }
  }

  function end(event: ReactPointerEvent<HTMLCanvasElement>) {
    if (active.current !== event.pointerId) return;
    active.current = null;
    setDrawn(strokes.current.length > 0);
  }

  function clear() {
    strokes.current = [];
    setDrawn(false);
    redraw();
  }

  function sign() {
    const path = drawn ? strokesPath(strokes.current) : '';
    const typed = name.trim();
    if (!path && !typed) return;
    onSign({
      drawing: path ? { path, width: size.current.width, height: size.current.height } : null,
      name: typed || null,
    });
  }

  return (
    <div className="rio-signature-pad">
      <canvas
        ref={canvas}
        className="rio-signature-pad__canvas"
        role="img"
        aria-label={t({
          id: 'fields.signature.pad',
          message: `Signature pad for ${label}.  Draw with a mouse, pen, or finger.`,
        })}
        onPointerDown={start}
        onPointerMove={move}
        onPointerUp={end}
        onPointerCancel={end}
        onLostPointerCapture={end}
      />
      <TextField
        label={t({ id: 'fields.signature.typeName', message: 'Your name' })}
        description={t({
          id: 'fields.signature.typeNameHelp',
          message: 'Type your name to sign without drawing, or to go with your drawing.',
        })}
        value={name}
        autoFocus={autoFocus}
        maxLength={LIMITS.nameLength}
        onChange={setName}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
            event.preventDefault();
            sign();
          } else event.continuePropagation();
        }}
      />
      <div className="rio-field-input__actions">
        <Button variant="primary" isDisabled={!drawn && name.trim() === ''} onPress={sign}>
          {t({ id: 'fields.signature.sign', message: 'Sign' })}
        </Button>
        <Button isDisabled={!drawn} onPress={clear}>
          {t({ id: 'fields.signature.clear', message: 'Clear drawing' })}
        </Button>
        {onCancel && (
          <Button variant="quiet" onPress={onCancel}>
            {t({ id: 'fields.signature.cancel', message: 'Cancel' })}
          </Button>
        )}
      </div>
    </div>
  );
}
