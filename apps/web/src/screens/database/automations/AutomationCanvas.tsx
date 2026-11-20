import { faArrowsUpDownLeftRight, faPlus, faXmark } from '@fortawesome/free-solid-svg-icons';
import { useLingui } from '@lingui/react/macro';
import {
  automationConnections,
  automationStepEntries,
  type AutomationConfig,
  type AutomationEndpoint,
} from '@riosoma/contracts';
import { Button, TextArea } from '@riosoma/ui';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { STEP_LABELS } from './labels';
import { newStepId } from './model';
import { ConnectionCanvas } from './Connections';

export function AutomationCanvas({
  config,
  readOnly,
  onChange,
  onCreate,
  children,
}: {
  config: AutomationConfig;
  readOnly: boolean;
  onChange(config: AutomationConfig, options?: { immediate?: boolean }): void;
  onCreate(source: AutomationEndpoint): void;
  children: ReactNode;
}) {
  const { t, i18n } = useLingui();
  const viewport = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const drag = useRef<{ x: number; y: number; left: number; top: number } | null>(null);
  const [zoom, setZoom] = useState(1);
  const entries = automationStepEntries(config.steps);
  const steps = entries.map(({ step }) => step);
  const notes = config.notes ?? [];
  const open = (id: string) => {
    const element = content.current?.querySelector<HTMLElement>(
      `[data-step="${CSS.escape(id)}"], [data-note="${CSS.escape(id)}"]`,
    );
    element?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
    element?.focus();
  };
  useEffect(() => {
    const id = new URLSearchParams(window.location.hash.slice(1)).get('step');
    if (id) open(id);
  }, []);
  const choose = (id: string) => {
    const hash = new URLSearchParams(window.location.hash.slice(1));
    hash.set('step', id);
    window.history.replaceState(null, '', `${window.location.pathname}${window.location.search}#${hash}`);
    open(id);
  };
  const scale = (value: number) => setZoom(Math.max(0.01, Math.min(2, value)));
  const moveNote = (id: string, x: number, y: number) =>
    onChange({
      ...config,
      notes: notes.map((note) => (note.id === id ? { ...note, x: Math.max(0, x), y: Math.max(0, y) } : note)),
    });
  return (
    <div className="rio-automation-canvas" data-wired>
      <div
        className="rio-automation-canvas__toolbar"
        role="group"
        aria-label={t({ id: 'automations.canvas.controls', message: 'Canvas controls' })}
      >
        <Button onPress={() => scale(zoom - 0.1)}>
          {t({ id: 'automations.canvas.zoomOut', message: 'Zoom out' })}
        </Button>
        <Button onPress={() => scale(zoom + 0.1)}>
          {t({ id: 'automations.canvas.zoomIn', message: 'Zoom in' })}
        </Button>
        <Button onPress={() => scale(1)}>
          {t({ id: 'automations.canvas.reset', message: 'Actual size' })}
        </Button>
        <Button
          onPress={() => {
            if (viewport.current && content.current)
              scale(
                Math.min(
                  viewport.current.clientWidth /
                    Math.max(content.current.offsetWidth, content.current.scrollWidth),
                  viewport.current.clientHeight /
                    Math.max(content.current.offsetHeight, content.current.scrollHeight),
                ),
              );
          }}
        >
          {t({ id: 'automations.canvas.fit', message: 'Fit' })}
        </Button>
        <output aria-live="polite">
          {i18n.number(zoom, { style: 'percent', maximumFractionDigits: 0 })}
        </output>
        {!readOnly ? (
          <Button
            onPress={() =>
              onChange({
                ...config,
                notes: [
                  ...notes,
                  {
                    id: newStepId(),
                    text: '',
                    x: (viewport.current?.scrollLeft ?? 0) / zoom,
                    y: (viewport.current?.scrollTop ?? 0) / zoom,
                  },
                ],
              })
            }
            isDisabled={notes.length >= 100}
            aria-label={t({ id: 'automations.canvas.addNote', message: 'Add a sticky note' })}
            icon={faPlus}
          />
        ) : null}
      </div>
      <p className="rio-automation-canvas__hint">
        {t({
          id: 'automations.canvas.keyboard',
          message:
            'Focus the canvas and use arrow keys to pan, plus or minus to zoom, and zero to reset.  Use Tab to move between steps and controls.',
        })}
      </p>
      <div
        ref={viewport}
        className="rio-automation-canvas__viewport"
        tabIndex={0}
        role="region"
        aria-label={t({ id: 'automations.canvas.label', message: 'Automation canvas' })}
        onKeyDown={(event) => {
          if (event.target !== event.currentTarget) return;
          const offsets: Record<string, [number, number]> = {
            ArrowLeft: [-80, 0],
            ArrowRight: [80, 0],
            ArrowUp: [0, -80],
            ArrowDown: [0, 80],
          };
          const offset = offsets[event.key];
          if (offset) {
            event.preventDefault();
            event.currentTarget.scrollBy?.(...offset);
          }
          if (event.key === '+' || event.key === '=') {
            event.preventDefault();
            scale(zoom + 0.1);
          }
          if (event.key === '-') {
            event.preventDefault();
            scale(zoom - 0.1);
          }
          if (event.key === '0') {
            event.preventDefault();
            scale(1);
          }
        }}
        onPointerDown={(event) => {
          if (event.target !== event.currentTarget || event.button !== 0) return;
          event.currentTarget.setPointerCapture(event.pointerId);
          drag.current = {
            x: event.clientX,
            y: event.clientY,
            left: event.currentTarget.scrollLeft,
            top: event.currentTarget.scrollTop,
          };
        }}
        onPointerMove={(event) => {
          if (drag.current) {
            event.currentTarget.scrollLeft = drag.current.left + drag.current.x - event.clientX;
            event.currentTarget.scrollTop = drag.current.top + drag.current.y - event.clientY;
          }
        }}
        onPointerUp={() => {
          drag.current = null;
        }}
        onPointerCancel={() => {
          drag.current = null;
        }}
      >
        <div ref={content} className="rio-automation-canvas__content" style={{ zoom }}>
          <ConnectionCanvas
            key={String(readOnly)}
            config={config}
            readOnly={readOnly}
            onChange={onChange}
            onCreate={onCreate}
            content={content}
            zoom={zoom}
          >
            {children}
          </ConnectionCanvas>
          {notes.map((note) => (
            <section
              key={note.id}
              data-note={note.id}
              tabIndex={-1}
              className="rio-automation-canvas__note"
              style={{ left: note.x, top: note.y }}
              aria-label={t({ id: 'automations.canvas.note', message: 'Sticky note' })}
            >
              <TextArea
                label={t({ id: 'automations.canvas.note', message: 'Sticky note' })}
                value={note.text}
                isReadOnly={readOnly}
                onChange={(text) =>
                  onChange({
                    ...config,
                    notes: notes.map((item) => (item.id === note.id ? { ...item, text } : item)),
                  })
                }
              />
              {!readOnly ? (
                <>
                  <Button
                    icon={faArrowsUpDownLeftRight}
                    aria-label={t({
                      id: 'automations.canvas.moveNote',
                      message: 'Move note with arrow keys',
                    })}
                    onKeyDown={(event) => {
                      const offsets: Record<string, [number, number]> = {
                        ArrowLeft: [-20, 0],
                        ArrowRight: [20, 0],
                        ArrowUp: [0, -20],
                        ArrowDown: [0, 20],
                      };
                      const offset = offsets[event.key];
                      if (offset) {
                        event.preventDefault();
                        moveNote(note.id, note.x + offset[0], note.y + offset[1]);
                      }
                    }}
                  />
                  <Button
                    onPress={() =>
                      onChange({ ...config, notes: notes.filter((item) => item.id !== note.id) })
                    }
                    aria-label={t({ id: 'automations.canvas.removeNote', message: 'Remove note' })}
                    icon={faXmark}
                  />
                </>
              ) : null}
            </section>
          ))}
        </div>
      </div>
      <nav
        className="rio-automation-canvas__minimap"
        aria-label={t({ id: 'automations.canvas.minimap', message: 'Canvas minimap' })}
      >
        <svg
          className="rio-automation-canvas__map"
          viewBox={`0 0 160 ${Math.max(20, entries.length * 10)}`}
          aria-hidden="true"
        >
          {automationConnections(config).map((wire) => {
            const from = entries.findIndex(({ step }) => step.id === wire.source.stepId);
            const to = entries.findIndex(({ step }) => step.id === wire.target.stepId);
            return to >= 0 ? (
              <path key={wire.id} d={`M 8 ${from < 0 ? 0 : 7 + from * 10} V ${7 + to * 10} H 24`} />
            ) : null;
          })}
          {entries.map(({ step, path }, index) => {
            const depth = Math.max(0, path.filter((part) => typeof part === 'number').length - 1);
            const x = 8 + depth * 16;
            const y = 4 + index * 10;
            return (
              <g key={step.id}>
                <rect x={x} y={y} width={70} height={6} rx={2} data-port={depth % 3} />
              </g>
            );
          })}
        </svg>
        {steps.map((step, index) => (
          <Button key={step.id} size="sm" variant="quiet" onPress={() => choose(step.id)}>
            {index + 1} {step.name || i18n._(STEP_LABELS[step.kind])}
          </Button>
        ))}
        {notes.map((note) => (
          <Button key={note.id} size="sm" variant="quiet" onPress={() => choose(note.id)}>
            {note.text || t({ id: 'automations.canvas.note', message: 'Sticky note' })}
          </Button>
        ))}
      </nav>
    </div>
  );
}
