import { recoverImport } from '../asset-recovery';
import { faXmark } from '@fortawesome/free-solid-svg-icons';
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import type { MessageDescriptor } from '@lingui/core';
import { msg } from '@lingui/core/macro';
import { useLingui } from '@lingui/react/macro';
import { reaches, type DemoScript, type DocModuleMeta } from '@riosoma/contracts';
import { Button } from '@riosoma/ui';
import { director } from '../audio/director';
import { beginSandbox, endSandbox, resetSandbox } from '../data/sandbox';
import { reducedMotion } from '../features/celebrations/settings';
import { useLevel } from '../levels/context';
import { useSavePreferences } from '../screens/settings/usePreferences';
import { useSession } from '../session';
import { LazyBoundary, lazyFeature } from '../shell/lazy';
const DemoLayer = lazyFeature(() => import('./DemoLayer').then((module) => ({ default: module.DemoLayer })));
import { NARRATION, PLACES, STOPPED } from './messages';
import { restoreDemoFocus } from './actions';
import type { DemoRunner, DemoOutcome } from './runner';
import { loadDemo } from './scripts';
import './demo.css';

const subscribeMute = (listener: () => void) => director.subscribe(listener);
const readMute = () => director.muted;

const ENDED = {
  finished: msg({
    id: 'demos.finished',
    message: 'The demo is over, and everything is back the way it was.',
  }),
  stopped: msg({
    id: 'demos.stopped',
    message: 'The demo stopped, and everything is back the way it was.',
  }),
};

function stoppedEarly(outcome: DemoOutcome, script: DemoScript): MessageDescriptor | null {
  switch (outcome) {
    case 'where':
      return script.where === 'anywhere' ? STOPPED.access : PLACES[script.where];
    case 'level':
      return STOPPED.level;
    case 'access':
      return STOPPED.access;
    case 'refused':
      return STOPPED.refused;
    default:
      return null;
  }
}

import type { DemoHostProps } from './DemoHost';

/**
 * Plays "Show me" demos for help.  One demo plays at a time, over the page the person is on, in a
 * sandbox that nothing leaves.  When it ends, focus goes back to where it was, which is the help
 * module's Show me button.
 */
export function DemoRuntime({
  request,
  onRunning,
  onStart,
  onEnd,
}: Omit<DemoHostProps, 'children'> & {
  request: { id: number; module: DocModuleMeta };
  onRunning(running: boolean): void;
}) {
  const { t, i18n } = useLingui();
  const session = useSession();
  const { level } = useLevel();
  const save = useSavePreferences();
  const [run, setRun] = useState<{ runner: DemoRunner; module: DocModuleMeta } | null>(null);
  const [notice, setNotice] = useState<{ text: string; module: DocModuleMeta } | null>(null);
  const [announcement, setAnnouncement] = useState('');
  const returnFocus = useRef<HTMLElement | null>(null);
  const pendingFocus = useRef<(() => void) | null>(null);
  useEffect(() => () => pendingFocus.current?.(), []);
  // A choice to mute made during a demo is saved once it ends, since nothing is sent while one runs.
  const unsavedMute = useRef<boolean | null>(null);
  const muted = useSyncExternalStore(subscribeMute, readMute, readMute);
  // Narration stays quiet until the person turns it on, so a demo never speaks unexpectedly.
  const preferred = session?.preferences.narration !== 'on';
  useEffect(() => {
    director.setMuted(preferred);
  }, [preferred]);
  const motion = reducedMotion(session?.preferences);

  function saveMute(value: boolean) {
    save.mutate({ narration: value ? 'muted' : 'on' });
  }

  function refocus() {
    const target = returnFocus.current;
    returnFocus.current = null;
    pendingFocus.current?.();
    pendingFocus.current = restoreDemoFocus(target);
  }

  function ended(runner: DemoRunner, module: DocModuleMeta, script: DemoScript) {
    const { outcome = 'stopped' } = runner.getState();
    setRun(null);
    if (unsavedMute.current !== null) {
      saveMute(unsavedMute.current);
      unsavedMute.current = null;
    }
    const early = stoppedEarly(outcome, script);
    if (early) {
      const text = i18n._(early);
      setNotice({ text, module });
      // The demo says why it stopped, too, the way it said everything else.
      director.narrate({ text, lang: i18n.locale || 'en-US' });
      return;
    }
    setAnnouncement(i18n._(outcome === 'finished' ? ENDED.finished : ENDED.stopped));
    onEnd?.(module);
    refocus();
  }

  async function start(module: DocModuleMeta) {
    if (run) return;
    pendingFocus.current?.();
    pendingFocus.current = null;
    const active = document.activeElement;
    returnFocus.current = active instanceof HTMLElement ? active : null;
    setNotice(null);
    setAnnouncement('');
    const script = await loadDemo(module.demo ?? module.id).catch(() => null);
    if (!script) {
      setNotice({ text: i18n._(STOPPED.failed), module });
      return;
    }
    const { DemoRunner } = await recoverImport(() => import('./runner'));
    DemoLayer.preload();
    const loaded = script;
    const preferences = session?.preferences;
    const runner = new DemoRunner(loaded, {
      document,
      narrate: (line) => director.narrate(line),
      stopNarration: () => director.stop(),
      sandbox: { begin: beginSandbox, reset: resetSandbox, end: endSandbox },
      say: (id) => {
        const descriptor = NARRATION[id];
        return descriptor ? i18n._(descriptor) : id;
      },
      lang: i18n.locale || 'en-US',
      reducedMotion: () => reducedMotion(preferences),
      aboveLevel: !reaches(level, module.level),
    });
    runner.subscribe(() => {
      if (runner.getState().status === 'ended') ended(runner, module, loaded);
    });
    onStart?.(module);
    setRun({ runner, module });
  }

  function closeNotice() {
    const module = notice?.module;
    director.stop();
    setNotice(null);
    if (module) onEnd?.(module);
    refocus();
  }

  function mute(value: boolean) {
    director.setMuted(value);
    if (run) unsavedMute.current = value;
    else saveMute(value);
  }

  const answered = useRef<number | null>(null);
  useEffect(() => {
    if (answered.current === request.id) return;
    answered.current = request.id;
    void start(request.module);
  });
  useEffect(() => {
    onRunning(run !== null);
  }, [run, onRunning]);
  const startRunner = useCallback(() => {
    if (run) void run.runner.start();
  }, [run]);
  return (
    <>
      {run ? (
        <LazyBoundary size="panel">
          <DemoLayer
            key={run.module.id}
            runner={run.runner}
            muted={muted}
            reducedMotion={motion}
            onMute={mute}
            onReady={startRunner}
          />
        </LazyBoundary>
      ) : null}
      {notice
        ? createPortal(
            <div
              className="rio-demo-layer"
              data-demo-layer=""
              data-react-aria-top-layer=""
              data-motion={motion ? 'reduced' : undefined}
            >
              <section
                className="rio-demo-card"
                data-docked=""
                aria-label={t({ id: 'demos.region', message: 'Demo' })}
              >
                <p className="rio-demo-card__caption" role="alert">
                  {notice.text}
                </p>
                <Button
                  size="sm"
                  autoFocus
                  onPress={closeNotice}
                  aria-label={t({ id: 'demos.close', message: 'Close' })}
                  icon={faXmark}
                />
              </section>
            </div>,
            document.body,
          )
        : null}
      <div className="rio-visually-hidden" role="status">
        {announcement}
      </div>
    </>
  );
}
