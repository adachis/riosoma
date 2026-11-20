import { AppLogo } from '../brand/OrganizationLogo';
import { Trans } from '@lingui/react/macro';
import {
  lazy,
  Component,
  Children,
  isValidElement,
  Suspense,
  useEffect,
  useLayoutEffect,
  useState,
  type ComponentType,
  type ReactNode,
  type RefObject,
} from 'react';
import { createPortal } from 'react-dom';
import './lazy.css';
import { loadFeatureCatalog } from '../i18n';
import { isAssetLoadError, preloadAssets, recoverAssets, recoverImport, reloadPage } from '../asset-recovery';
import type { AsyncRouteComponent } from '@tanstack/react-router';
import { registerAnchorPreload } from '../demos/anchors';

const FeatureErrorDialog = lazy(() => recoverImport(() => import('./FeatureErrorDialog'), false));
const childTypes = new Map<unknown, number>();

/** Intent and rendering share one request, including when focus follows a hover. */
// React's component constraint must accept the different prop types of named feature exports.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function lazyFeature<T extends ComponentType<any>>(load: () => Promise<{ default: T }>) {
  let pending: ReturnType<typeof load> | undefined;
  const request = () => {
    if (!pending) {
      pending = Promise.all([load(), loadFeatureCatalog()]).then(([module]) => module);
      void pending.catch(() => {
        pending = undefined;
      });
    }
    return pending;
  };
  return Object.assign(
    lazy(() => recoverImport(request, false)),
    {
      preload: () => preloadAssets(request),
    },
  );
}

/** Route intent uses the same silent preload path as feature intent. */
export function lazyRouteComponent<T extends Record<string, unknown>, K extends keyof T = 'default'>(
  load: () => Promise<T>,
  exportName?: K,
): T[K] extends (props: infer Props) => unknown ? AsyncRouteComponent<Props> : never {
  return lazyFeature(async () => ({
    default: (await load())[exportName ?? 'default'] as ComponentType,
  })) as T[K] extends (props: infer Props) => unknown ? AsyncRouteComponent<Props> : never;
}

export function usePreloadAnchor(ref: RefObject<HTMLElement | null>, preload: () => Promise<unknown>): void {
  useEffect(() => {
    const root = ref.current;
    const element = root?.matches('[data-anchor]') ? root : root?.querySelector<HTMLElement>('[data-anchor]');
    if (element) return registerAnchorPreload(element, preload);
  }, [ref, preload]);
}

function LoadingLogo() {
  const [animate, setAnimate] = useState(false);
  useEffect(() => {
    // Brief route waits paint the mark without requesting entrance code before home appears.
    const timer = setTimeout(() => setAnimate(true), 1000);
    return () => clearTimeout(timer);
  }, []);
  return <AppLogo animate={animate} />;
}

export function LoadingState({ size = 'page' }: { size?: 'page' | 'panel' | 'editor' | 'controls' }) {
  return (
    <div className={`rio-feature-loading rio-feature-loading--${size}`} role="status" aria-busy="true">
      {size === 'page' && <LoadingLogo />}
      <Trans id="shell.feature.loading">Loading…</Trans>
    </div>
  );
}

export function LoadingPopover({
  triggerRef,
  size = 'editor',
  children,
}: {
  triggerRef?: RefObject<HTMLElement | null>;
  size?: 'editor' | 'controls';
  children?: ReactNode;
}) {
  const [position, setPosition] = useState({ top: 0, left: 0 });
  useLayoutEffect(() => {
    const box = triggerRef?.current?.getBoundingClientRect();
    if (box) setPosition({ top: box.bottom, left: box.left });
  }, [triggerRef]);
  return createPortal(
    <div className="rio-deferred-menu-loading" style={position}>
      {children ?? <LoadingState size={size} />}
    </div>,
    document.body,
  );
}

class FeatureErrorBoundary extends Component<
  { children: ReactNode; fallback: (error: unknown) => ReactNode },
  { failed: boolean; error?: unknown }
> {
  override state: { failed: boolean; error?: unknown } = { failed: false };
  static getDerivedStateFromError(error: unknown) {
    return { failed: true, error };
  }
  override componentDidCatch(error: unknown) {
    // Plain lazy imports reject inside React, where the window rejection listener cannot see them.
    if (isAssetLoadError(error)) void recoverAssets();
  }
  override render() {
    return this.state.failed ? this.props.fallback(this.state.error) : this.props.children;
  }
}

export function FeatureLoadError({
  size,
  error,
}: {
  size: 'page' | 'panel' | 'editor' | 'controls';
  error: unknown;
}) {
  const asset = isAssetLoadError(error);
  return (
    <div className={`rio-feature-loading rio-feature-loading--${size} rio-feature-error`}>
      <div role="alert">
        <h2>
          {asset ? (
            <Trans id="app.load.title">This screen couldn't load</Trans>
          ) : (
            <Trans id="app.load.problem.title">This part ran into a problem</Trans>
          )}
        </h2>
        <p>
          {asset ? (
            <Trans id="app.load.body">
              {'Check your connection, then reload to try again.  Your saved drafts are kept on this device.'}
            </Trans>
          ) : (
            <Trans id="app.load.problem.body">
              {'Reload to try again.  Your saved drafts are kept on this device.'}
            </Trans>
          )}
        </p>
      </div>
      <button type="button" className="rio-button" data-variant="primary" onClick={reloadPage}>
        <Trans id="app.load.reload">Reload</Trans>
      </button>
    </div>
  );
}

function LazyFrame({
  children,
  size = 'page',
  triggerRef,
  fallback: customFallback,
  onDismiss,
}: {
  children: ReactNode;
  size?: 'page' | 'panel' | 'editor' | 'controls' | 'dialog' | 'popover';
  triggerRef?: RefObject<HTMLElement | null>;
  fallback?: ReactNode;
  onDismiss?: () => void;
}) {
  const [dismissed, setDismissed] = useState(false);
  if (dismissed) return null;
  const loadingSize = size === 'dialog' || size === 'popover' ? 'editor' : size;
  const frame = (content: ReactNode) =>
    size === 'dialog' ? (
      createPortal(
        <div className="rio-feature-loading-overlay">
          <div className="rio-feature-loading-dialog">{content}</div>
        </div>,
        document.body,
      )
    ) : size === 'popover' ? (
      <LoadingPopover triggerRef={triggerRef}>{content}</LoadingPopover>
    ) : (
      content
    );
  const error = (cause: unknown) =>
    size === 'dialog' ? (
      <Suspense fallback={frame(<FeatureLoadError size={loadingSize} error={cause} />)}>
        <FeatureErrorDialog
          error={cause}
          onDismiss={() => {
            setDismissed(true);
            onDismiss?.();
          }}
        />
      </Suspense>
    ) : (
      frame(<FeatureLoadError size={loadingSize} error={cause} />)
    );
  return (
    <FeatureErrorBoundary fallback={error}>
      <Suspense fallback={customFallback ?? frame(<LoadingState size={loadingSize} />)}>{children}</Suspense>
    </FeatureErrorBoundary>
  );
}

export function LazyBoundary(props: Parameters<typeof LazyFrame>[0]) {
  // A persistent dialog host must forget an error and dismissal when a different dialog opens.
  const identity = Children.toArray(props.children)
    .filter(isValidElement)
    .map((child) => {
      if (!childTypes.has(child.type)) childTypes.set(child.type, childTypes.size);
      return [childTypes.get(child.type), child.key];
    });
  return <LazyFrame key={JSON.stringify(identity)} {...props} />;
}
