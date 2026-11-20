import { useEffect, useRef, useState } from 'react';
import { useLingui } from '@lingui/react/macro';
import { faWandMagicSparkles } from '@fortawesome/free-solid-svg-icons';
import { Button } from '@riosoma/ui';
import { anchor } from '../../demos/anchors';
import { LazyBoundary, LoadingState, lazyFeature, usePreloadAnchor } from '../../shell/lazy';
import { useSession } from '../../session';
import { savedPanelOpen } from './conversation-session';
import './RioLauncher.css';

const DemoAssistant = lazyFeature(() =>
  import('./DemoAssistant').then((module) => ({ default: module.DemoAssistant })),
);
const RioAssistant = lazyFeature(() =>
  import('./RioAssistant').then((module) => ({ default: module.RioAssistant })),
);
const linkedApproval = () => /^#remote-approval=[0-9a-f-]{36}$/.test(window.location.hash);

/** Keeps Rio present while the conversation and its tools wait for intent. */
export function RioLauncher({ phone }: { phone: boolean }) {
  const { t } = useLingui();
  const session = useSession();
  const [opened, setOpened] = useState(() => linkedApproval() || savedPanelOpen(session));
  const target = useRef<HTMLSpanElement>(null);
  usePreloadAnchor(target, RioAssistant.preload);
  useEffect(() => {
    const followLink = () => {
      if (linkedApproval()) setOpened(true);
    };
    window.addEventListener('hashchange', followLink);
    return () => window.removeEventListener('hashchange', followLink);
  }, []);
  const trigger = (
    <span ref={target} className="rio-assistant__trigger" data-phone={phone}>
      <Button
        variant="quiet"
        size="sm"
        primaryAction
        tooltip
        icon={faWandMagicSparkles}
        aria-label={
          session?.demo
            ? t({ id: 'demo.help.title', message: 'Ask the help topics' })
            : t({ id: 'rio.open', message: 'AI: Ask Rio' })
        }
        aria-expanded={opened}
        onHoverStart={RioAssistant.preload}
        onFocus={RioAssistant.preload}
        onPress={() => setOpened(true)}
        {...anchor('rio.open')}
      >
        <span className="rio-assistant__trigger-label">
          {session?.demo ? t({ id: 'common.help', message: 'Help' }) : t({ id: 'rio.ai', message: 'AI' })}
        </span>
      </Button>
    </span>
  );
  if (session?.demo && opened)
    return (
      <LazyBoundary fallback={<LoadingState size="panel" />}>
        <DemoAssistant onClose={() => setOpened(false)} />
      </LazyBoundary>
    );
  return opened ? (
    <LazyBoundary
      fallback={
        <>
          {trigger}
          <aside className="rio-assistant__dock">
            <LoadingState size="panel" />
          </aside>
        </>
      }
    >
      <RioAssistant phone={phone} initialOpen />
    </LazyBoundary>
  ) : (
    trigger
  );
}
