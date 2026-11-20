import {
  Children,
  cloneElement,
  createContext,
  useContext,
  useEffect,
  useId,
  useRef,
  useState,
  type ReactElement,
} from 'react';
import type { MenuTriggerProps } from 'react-aria-components';
import type { ButtonProps, MenuProps, MenuItemProps, MenuSeparatorProps } from '@riosoma/ui';
import { FeatureLoadError, LoadingPopover, usePreloadAnchor } from './lazy';
import { loadFeatureCatalog } from '../i18n';
import { preloadAssets, recoverImport } from '../asset-recovery';

import type * as MenuRuntime from './menu-runtime';
type Runtime = typeof MenuRuntime;
type MenuContext = {
  runtime: Runtime;
  anchor: React.RefObject<HTMLElement | null>;
  id: string;
  focus: 'first' | 'last';
  close(): void;
};
const RuntimeContext = createContext<MenuContext | null>(null);
let pending: Promise<Runtime> | undefined;
const load = () => {
  if (!pending) {
    pending = Promise.all([import('./menu-runtime'), loadFeatureCatalog()]).then(([module]) => module);
    void pending.catch(() => {
      pending = undefined;
    });
  }
  return pending;
};
const preloadMenu = () => preloadAssets(load);

/** The button stays mounted while collections and positioning wait for intent. */
export function MenuTrigger({ children, isOpen, defaultOpen, onOpenChange }: MenuTriggerProps) {
  const [runtime, setRuntime] = useState<Runtime | null>(null);
  const [failure, setFailure] = useState<{ error: unknown } | null>(null);
  const [opened, setOpened] = useState(Boolean(isOpen ?? defaultOpen));
  const [focus, setFocus] = useState<'first' | 'last'>('first');
  const open = isOpen ?? opened;
  const anchor = useRef<HTMLButtonElement>(null);
  const id = useId();
  usePreloadAnchor(anchor, preloadMenu);
  const change = (value: boolean) => {
    if (!value) setFailure(null);
    setOpened(value);
    onOpenChange?.(value);
  };
  const preload = () => {
    void preloadMenu();
  };
  useEffect(() => {
    if (!open || runtime || failure) return;
    let active = true;
    void recoverImport(load)
      .then((module) => {
        if (active) setRuntime(module);
      })
      .catch((error: unknown) => {
        if (active) setFailure({ error });
      });
    return () => {
      active = false;
    };
  }, [open, runtime, failure]);
  const content = Children.toArray(children);
  const button = content[0] as ReactElement<ButtonProps>;
  return (
    <>
      <span
        ref={(element) => {
          anchor.current = element?.querySelector('button') ?? null;
        }}
        className="rio-deferred-menu-trigger"
      >
        {cloneElement(button, {
          'aria-haspopup': 'menu',
          'aria-expanded': open,
          'aria-controls': open ? id : undefined,
          onHoverStart: (event) => {
            button.props.onHoverStart?.(event);
            preload();
          },
          onFocus: (event) => {
            button.props.onFocus?.(event);
            preload();
          },
          onPress: (event) => {
            button.props.onPress?.(event);
            setFocus('first');
            change(!open);
          },
          onKeyDown: (event) => {
            button.props.onKeyDown?.(event);
            if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
              event.preventDefault();
              setFocus(event.key === 'ArrowUp' ? 'last' : 'first');
              change(true);
            }
          },
        })}
      </span>
      {open &&
        (runtime ? (
          <RuntimeContext.Provider value={{ runtime, anchor, id, focus, close: () => change(false) }}>
            {content.slice(1)}
          </RuntimeContext.Provider>
        ) : (
          <LoadingPopover triggerRef={anchor} size="controls">
            {failure ? <FeatureLoadError size="controls" error={failure.error} /> : undefined}
          </LoadingPopover>
        ))}
    </>
  );
}

export function Menu<T extends object>(props: MenuProps<T>) {
  const context = useContext(RuntimeContext);
  return context ? (
    <context.runtime.Menu
      {...props}
      id={context.id}
      triggerRef={context.anchor}
      isOpen
      autoFocus={context.focus}
      onOpenChange={(open) => {
        if (!open) context.close();
      }}
      onClose={() => {
        props.onClose?.();
        context.close();
      }}
    />
  ) : null;
}

export function MenuItem(props: MenuItemProps) {
  const context = useContext(RuntimeContext);
  return context ? <context.runtime.MenuItem {...props} /> : null;
}

export function MenuSeparator(props: MenuSeparatorProps) {
  const context = useContext(RuntimeContext);
  return context ? <context.runtime.MenuSeparator {...props} /> : null;
}
