import { msg } from '@lingui/core/macro';
import { useLingui } from '@lingui/react/macro';
import {
  automationConnections,
  automationConnectionProblems,
  automationOutputPorts,
  connectionRefusal,
  connectionSteps,
  type AutomationConfig,
  type AutomationEndpoint,
  type AutomationStep,
  type ConnectionProblemKey,
} from '@riosoma/contracts';
import { Button, Menu, MenuItem, MenuTrigger, usePointerDrag } from '@riosoma/ui';
import {
  createContext,
  useContext,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
  type ReactNode,
  type RefObject,
} from 'react';
import { newStepId } from './model';
import { STEP_LABELS } from './labels';

export const WIRE_MESSAGES = {
  'automations.wire.loopBoundary': msg({
    id: 'automations.wire.loopBoundary',
    message: 'Merge paths within the same loop.  Use Done to connect the step after a loop.',
  }),
  'automations.wire.kind': msg({ id: 'automations.wire.kind', message: 'Connect an output to an input.' }),
  'automations.wire.occupied': msg({
    id: 'automations.wire.occupied',
    message: 'This input already has a wire.  Use Merge input for several wires.',
  }),
  'automations.wire.cycle': msg({
    id: 'automations.wire.cycle',
    message: 'This connection would create a cycle.',
  }),
  'automations.wire.duplicate': msg({
    id: 'automations.wire.duplicate',
    message: 'These ports are already connected.',
  }),
  'automations.wire.unreachable': msg({
    id: 'automations.wire.unreachable',
    message: 'This step cannot be reached from the trigger.',
  }),
  'automations.wire.missingInput': msg({
    id: 'automations.wire.missingInput',
    message: 'This step needs an input wire.',
  }),
};

type Gesture = {
  source: AutomationEndpoint;
  target?: AutomationEndpoint;
  wireId?: string;
  end?: 'source' | 'target';
};
type Point = { x: number; y: number };
const endpointKey = (endpoint: AutomationEndpoint) => `${endpoint.stepId}:${endpoint.port}`;
const input = (endpoint: AutomationEndpoint) => ['in', 'merge'].includes(endpoint.port);
const Context = createContext<{
  readOnly: boolean;
  reason(endpoint: AutomationEndpoint): ConnectionProblemKey | null;
  start(event: PointerEvent<HTMLElement>, endpoint: AutomationEndpoint): void;
  key(event: KeyboardEvent<HTMLElement>, endpoint: AutomationEndpoint): void;
  press(endpoint: AutomationEndpoint): void;
  announce(endpoint: AutomationEndpoint): void;
} | null>(null);

export function ConnectionCanvas({
  config,
  readOnly,
  onChange,
  onCreate,
  content,
  zoom,
  children,
}: {
  config: AutomationConfig;
  readOnly: boolean;
  onChange(config: AutomationConfig, options?: { immediate?: boolean }): void;
  onCreate(source: AutomationEndpoint): void;
  content: RefObject<HTMLDivElement | null>;
  zoom: number;
  children: ReactNode;
}) {
  const { t, i18n } = useLingui();
  const [gesture, setGesture] = useState<Gesture | null>(null);
  const [point, setPoint] = useState<Point | null>(null);
  const [announcement, setAnnouncement] = useState('');
  const [selected, setSelected] = useState<string | null>(() =>
    new URLSearchParams(window.location.hash.slice(1)).get('wire'),
  );
  const [menuOpen, setMenuOpen] = useState(false);
  const [positions, setPositions] = useState<Record<string, Point>>({});
  const pointerDrag = usePointerDrag(!readOnly);
  const wires = automationConnections(config);
  const latest = useRef(config);
  useLayoutEffect(() => {
    latest.current = config;
  });
  const wire = wires.find((entry) => entry.id === selected);
  const ports = () => [...(content.current?.querySelectorAll<HTMLElement>('[data-wire-port]') ?? [])];
  const endpoint = (element: HTMLElement): AutomationEndpoint => ({
    stepId: element.dataset.wireStep!,
    port: element.dataset.wirePort!,
  });
  const relative = (clientX: number, clientY: number): Point => {
    const rect = content.current!.getBoundingClientRect();
    return { x: (clientX - rect.left) / zoom, y: (clientY - rect.top) / zoom };
  };
  useLayoutEffect(() => {
    const update = () => {
      if (!content.current) return;
      const next: Record<string, Point> = {};
      const container = content.current.getBoundingClientRect();
      for (const element of content.current.querySelectorAll<HTMLElement>('[data-wire-port]')) {
        const rect = element.getBoundingClientRect();
        next[`${element.dataset.wireStep}:${element.dataset.wirePort}`] = {
          x: (rect.left + rect.width / 2 - container.left) / zoom,
          y: (rect.top + rect.height / 2 - container.top) / zoom,
        };
      }
      setPositions(next);
    };
    update();
    const observer = new ResizeObserver(update);
    if (content.current) observer.observe(content.current);
    window.addEventListener('resize', update);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', update);
    };
  }, [config, content, zoom]);
  const reason = (candidate: AutomationEndpoint, operation = gesture, current = config) => {
    if (!operation) return null;
    return operation.end === 'source'
      ? connectionRefusal(current, candidate, operation.target!, operation.wireId)
      : connectionRefusal(current, operation.source, candidate, operation.wireId);
  };
  const clear = () => {
    setGesture(null);
    setPoint(null);
  };
  const chooseWire = (id: string) => {
    setSelected(id);
    const control = [
      ...(content.current?.querySelectorAll<HTMLButtonElement>('[data-wire-select]') ?? []),
    ].find((element) => element.dataset.wireSelect === id);
    control?.focus({ preventScroll: true });
    const hash = new URLSearchParams(window.location.hash.slice(1));
    hash.set('wire', id);
    try {
      window.history.replaceState(null, '', `${window.location.pathname}${window.location.search}#${hash}`);
    } catch {
      /* Selection still works when the browser limits address updates. */
    }
  };
  const remove = () => {
    if (readOnly || !wire) return;
    ports()
      .find((element) => endpointKey(endpoint(element)) === endpointKey(wire.target))
      ?.focus({ preventScroll: true });
    onChange({ ...config, connections: wires.filter((entry) => entry.id !== wire.id) }, { immediate: true });
    setSelected(null);
    setAnnouncement(t({ id: 'automations.wire.removed', message: 'Connection removed.' }));
  };
  const complete = (candidate: AutomationEndpoint, operation: Gesture) => {
    const refused = reason(candidate, operation, latest.current);
    if (refused) {
      setAnnouncement(i18n._(WIRE_MESSAGES[refused]));
      clear();
      return;
    }
    const currentWires = automationConnections(latest.current);
    if (operation.wireId && !currentWires.some((entry) => entry.id === operation.wireId)) {
      clear();
      return;
    }
    const connection = {
      id: operation.wireId ?? newStepId(),
      source: operation.end === 'source' ? candidate : operation.source,
      target: operation.end === 'source' ? operation.target! : candidate,
    };
    const previous = currentWires.find((entry) => entry.id === connection.id);
    if (
      previous &&
      endpointKey(previous.source) === endpointKey(connection.source) &&
      endpointKey(previous.target) === endpointKey(connection.target)
    ) {
      clear();
      return;
    }
    onChange(
      {
        ...latest.current,
        connections: [...currentWires.filter((entry) => entry.id !== connection.id), connection],
      },
      { immediate: true },
    );
    setAnnouncement(t({ id: 'automations.wire.connected', message: 'Connection saved.' }));
    clear();
  };
  const begin = (operation: Gesture) => {
    setGesture(operation);
    setAnnouncement(
      t({
        id: 'automations.wire.started',
        message:
          'Connection started.  Use arrow keys to choose a compatible port, Enter to connect, N to add a step, or Escape to cancel.',
      }),
    );
  };
  const operationFor = (from: AutomationEndpoint): Gesture | null => {
    if (input(from)) {
      const existing =
        wires.find((entry) => entry.id === selected && endpointKey(entry.target) === endpointKey(from)) ??
        wires.find((entry) => endpointKey(entry.target) === endpointKey(from));
      return existing
        ? { source: existing.source, target: existing.target, wireId: existing.id, end: 'target' }
        : null;
    }
    return { source: from };
  };
  const start = (
    event: PointerEvent<HTMLElement>,
    from: AutomationEndpoint,
    operation = operationFor(from),
  ) => {
    if (readOnly || !operation) return;
    pointerDrag(event, {
      scrollElement: content.current?.closest<HTMLElement>('.rio-automation-canvas__viewport'),
      move(next) {
        setGesture(operation);
        setPoint(relative(next.clientX, next.clientY));
        const hovered = document
          .elementFromPoint(next.clientX, next.clientY)
          ?.closest<HTMLElement>('[data-wire-port]');
        const refused = hovered ? reason(endpoint(hovered), operation, latest.current) : null;
        if (refused) setAnnouncement(i18n._(WIRE_MESSAGES[refused]));
      },
      finish(next, activated) {
        if (!activated) return;
        const hovered = document
          .elementFromPoint(next.clientX, next.clientY)
          ?.closest<HTMLElement>('[data-wire-port]');
        if (hovered) complete(endpoint(hovered), operation);
        else {
          const landed = document.elementFromPoint(next.clientX, next.clientY);
          if (
            !operation.wireId &&
            landed?.closest('.rio-automation-canvas__viewport') &&
            !landed.closest('button, input, textarea, [data-step], [data-note]')
          )
            onCreate(operation.source);
          clear();
        }
      },
      cancel() {
        clear();
        setAnnouncement(t({ id: 'automations.wire.canceled', message: 'Connection canceled.' }));
      },
    });
  };
  const press = (from: AutomationEndpoint) => {
    if (readOnly) return;
    if (gesture) complete(from, gesture);
    else {
      const operation = operationFor(from);
      if (operation) begin(operation);
    }
  };
  const key = (event: KeyboardEvent<HTMLElement>, from: AutomationEndpoint) => {
    if (readOnly) return;
    if (event.key === 'Escape' && gesture) {
      event.preventDefault();
      event.stopPropagation();
      clear();
      setAnnouncement(t({ id: 'automations.wire.canceled', message: 'Connection canceled.' }));
    } else if (event.key.toLowerCase() === 'n' && gesture && !gesture.wireId) {
      event.preventDefault();
      onCreate(gesture.source);
      clear();
    } else if (gesture && ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(event.key)) {
      event.preventDefault();
      event.stopPropagation();
      const compatible = ports().filter((element) => !reason(endpoint(element)));
      const index = compatible.indexOf(event.currentTarget);
      const direction = event.key === 'ArrowUp' || event.key === 'ArrowLeft' ? -1 : 1;
      const next = compatible[(index + direction + compatible.length) % compatible.length];
      next?.focus();
      if (next) setPoint(positions[endpointKey(endpoint(next))] ?? null);
    } else if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      event.stopPropagation();
      press(from);
    }
  };
  const curve = (a: Point, b: Point, index: number) => {
    const side = Math.max(4, Math.min(a.x, b.x) - 32 - index * 5);
    return `M ${a.x} ${a.y} C ${side} ${a.y}, ${side} ${b.y}, ${b.x} ${b.y}`;
  };
  const nameOf = (id: string) => {
    if (id === 'trigger') return t({ id: 'automations.wire.trigger', message: 'Trigger' });
    const step = connectionSteps(config).find((entry) => entry.id === id);
    return step ? step.name || i18n._(STEP_LABELS[step.kind]) : id;
  };
  const liveStart = gesture
    ? positions[endpointKey(gesture.end === 'source' ? gesture.target! : gesture.source)]
    : undefined;
  return (
    <Context.Provider
      value={{
        readOnly,
        reason,
        start,
        key,
        press,
        announce(from) {
          const refused = reason(from);
          if (refused) setAnnouncement(i18n._(WIRE_MESSAGES[refused]));
        },
      }}
    >
      <p className="rio-automation-canvas__hint">
        {t({
          id: 'automations.wire.help',
          message:
            'Drag an output to an input, or focus a port and press Enter.  Drag an input to move its wire.  Merge input accepts several wires.',
        })}
      </p>
      <div role="status" aria-live="polite" className="rio-automation-wires__status">
        {announcement}
      </div>
      {children}
      <svg className="rio-automation-wires" aria-hidden="true">
        {wires.map((entry, index) => {
          const a = positions[endpointKey(entry.source)];
          const b = positions[endpointKey(entry.target)];
          return a && b ? (
            <path
              key={entry.id}
              d={curve(a, b, index)}
              data-wire={entry.id}
              data-selected={selected === entry.id || undefined}
              data-wire-color={
                entry.source.port === 'error'
                  ? 'error'
                  : entry.source.port === 'otherwise' || entry.source.port === 'done'
                    ? 'alternate'
                    : 'main'
              }
              onClick={() => chooseWire(entry.id)}
              onContextMenu={(event) => {
                event.preventDefault();
                chooseWire(entry.id);
                setMenuOpen(true);
              }}
            />
          ) : null;
        })}
        {liveStart && point ? (
          <path className="rio-automation-wires__live" d={curve(liveStart, point, 0)} />
        ) : null}
      </svg>
      <div
        className="rio-automation-wires__list"
        role="group"
        aria-label={t({ id: 'automations.wire.list', message: 'Connections' })}
      >
        {wires.map((entry) => {
          const source = nameOf(entry.source.stepId);
          const target = nameOf(entry.target.stepId);
          const port = portName(entry.source.port, i18n);
          return (
            <Button
              key={entry.id}
              size="sm"
              variant="quiet"
              data-wire-select={entry.id}
              aria-pressed={entry.id === selected}
              onPress={() => chooseWire(entry.id)}
              onKeyDown={(event) => {
                if (entry.id === selected && (event.key === 'Delete' || event.key === 'Backspace')) {
                  event.preventDefault();
                  remove();
                }
              }}
              onContextMenu={(event) => {
                event.preventDefault();
                chooseWire(entry.id);
                setMenuOpen(true);
              }}
            >
              {t({ id: 'automations.wire.label', message: `${source}, ${port}, to ${target}` })}
            </Button>
          );
        })}
      </div>
      {wire && !readOnly ? (
        <div className="rio-automation-wires__actions">
          <Button
            onPress={() =>
              begin({ source: wire.source, target: wire.target, wireId: wire.id, end: 'source' })
            }
            onKeyDown={(event) => {
              if (event.key.startsWith('Arrow') || event.key === 'Escape') key(event, wire.source);
            }}
            onPointerDown={(event) =>
              start(event, wire.source, {
                source: wire.source,
                target: wire.target,
                wireId: wire.id,
                end: 'source',
              })
            }
          >
            {t({ id: 'automations.wire.moveSource', message: 'Move wire start' })}
          </Button>
          <Button
            onPress={() =>
              begin({ source: wire.source, target: wire.target, wireId: wire.id, end: 'target' })
            }
            onKeyDown={(event) => {
              if (event.key.startsWith('Arrow') || event.key === 'Escape') key(event, wire.target);
            }}
            onPointerDown={(event) =>
              start(event, wire.target, {
                source: wire.source,
                target: wire.target,
                wireId: wire.id,
                end: 'target',
              })
            }
          >
            {t({ id: 'automations.wire.moveTarget', message: 'Move wire end' })}
          </Button>
          <MenuTrigger isOpen={menuOpen} onOpenChange={setMenuOpen}>
            <Button>{t({ id: 'automations.wire.menu', message: 'Connection options' })}</Button>
            <Menu
              aria-label={t({ id: 'automations.wire.menu', message: 'Connection options' })}
              onAction={() => remove()}
            >
              <MenuItem id="remove">
                {t({ id: 'automations.wire.remove', message: 'Remove connection' })}
              </MenuItem>
            </Menu>
          </MenuTrigger>
        </div>
      ) : null}
    </Context.Provider>
  );
}

function portName(port: string, i18n: ReturnType<typeof useLingui>['i18n']): string {
  switch (port) {
    case 'in':
      return i18n._(msg({ id: 'automations.wire.input', message: 'Input' }));
    case 'merge':
      return i18n._(msg({ id: 'automations.wire.merge', message: 'Merge input' }));
    case 'out':
      return i18n._(msg({ id: 'automations.wire.output', message: 'Output' }));
    case 'then':
      return i18n._(msg({ id: 'automations.wire.yes', message: 'Yes' }));
    case 'otherwise':
      return i18n._(msg({ id: 'automations.wire.no', message: 'No' }));
    case 'each':
      return i18n._(msg({ id: 'automations.wire.each', message: 'Each' }));
    case 'done':
      return i18n._(msg({ id: 'automations.wire.done', message: 'Done' }));
    case 'error':
      return i18n._(msg({ id: 'automations.wire.error', message: 'Error' }));
    default:
      return port;
  }
}

export function ConnectionPorts({ step }: { step?: AutomationStep }) {
  const context = useContext(Context);
  const { t, i18n } = useLingui();
  const id = useId();
  if (!context) return null;
  const stepId = step?.id ?? 'trigger';
  const name = step
    ? step.name || i18n._(STEP_LABELS[step.kind])
    : t({ id: 'automations.wire.trigger', message: 'Trigger' });
  return (
    <div className="rio-automation-ports">
      {[...(step ? ['in', 'merge'] : []), ...automationOutputPorts(step)].map((port, index) => {
        const endpoint = { stepId, port };
        const reason = context.reason(endpoint);
        const label =
          step?.kind === 'switch' && !['in', 'merge', 'error', 'otherwise'].includes(port)
            ? (step.cases.find((entry) => entry.id === port)?.value ?? port)
            : portName(port, i18n);
        return (
          <div key={port} className="rio-automation-ports__item">
            <button
              type="button"
              data-wire-step={stepId}
              data-wire-port={port}
              data-wire-color={
                port === 'error' ? 'error' : port === 'otherwise' || port === 'done' ? 'alternate' : 'main'
              }
              aria-label={t({ id: 'automations.wire.port', message: `${name}: ${label}` })}
              aria-describedby={reason ? `${id}-${index}` : undefined}
              aria-disabled={context.readOnly || Boolean(reason)}
              onPointerDown={(event) => context.start(event, endpoint)}
              onKeyDown={(event) => context.key(event, endpoint)}
              onClick={(event) => {
                if (event.detail === 0) context.press(endpoint);
              }}
              onFocus={() => context.announce(endpoint)}
            >
              {label}
            </button>
            {reason ? (
              <span id={`${id}-${index}`} className="rio-automation-ports__reason">
                {i18n._(WIRE_MESSAGES[reason])}
              </span>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

export function ConnectionProblems({ config, stepId }: { config: AutomationConfig; stepId?: string }) {
  const { i18n, t } = useLingui();
  const problems = automationConnectionProblems(config).filter(
    (problem) => !stepId || problem.stepId === stepId,
  );
  if (!problems.length) return null;
  return (
    <ul
      className="rio-automation-wires__problems"
      aria-label={t({ id: 'automations.wire.problems', message: 'Steps to connect before publishing' })}
    >
      {problems.map((problem, index) => {
        const step = connectionSteps(config).find((entry) => entry.id === problem.stepId);
        const name = step?.name || (step && i18n._(STEP_LABELS[step.kind])) || problem.stepId;
        const reason = i18n._(WIRE_MESSAGES[problem.messageKey]);
        return (
          <li key={`${problem.stepId}-${index}`}>
            {t({ id: 'automations.wire.problemStep', message: `${name} (${problem.stepId}): ${reason}` })}
          </li>
        );
      })}
    </ul>
  );
}
