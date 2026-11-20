import {
  createContext,
  useCallback,
  useContext,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from 'react';
import { Focusable } from 'react-aria-components';
import { flushSync } from 'react-dom';
import { useLingui } from '@lingui/react/macro';
import { faEllipsis, faHourglassHalf } from '@fortawesome/free-solid-svg-icons';
import { Icon, type IconDefinition } from '@riosoma/icons';
import {
  Button,
  Menu,
  MenuItem,
  MenuTrigger,
  Toolbar,
  Tooltip,
  TooltipTrigger,
  type ButtonProps,
} from '@riosoma/ui';
import { usePhone } from '../shell/useMediaQuery';
import type { AnchorProps } from '../demos/anchors';
import './responsive-toolbar.css';

const OverflowTrigger = createContext<RefObject<HTMLDivElement | null>>({ current: null });
export const useToolbarOverflowTrigger = () => useContext(OverflowTrigger);

export type ToolbarMode = 'full' | 'short' | 'icon' | 'overflow';
export interface ResponsiveToolbarItem {
  id: string;
  label: string;
  shortLabel?: string;
  count?: number;
  icon: IconDefinition;
  /** Higher priorities retain their labels and their place in the toolbar longer. */
  priority: number;
  variant?: ButtonProps['variant'];
  active?: boolean;
  disabled?: boolean;
  status?: boolean;
  pending?: boolean;
  buttonProps?: AnchorProps;
  onAction(): void;
  onPreload?(): void;
  render?(
    button: ReactNode,
    options: {
      overflow: boolean;
    },
  ): ReactNode;
}

type Widths = Record<'full' | 'short' | 'icon', number>;
const iconAction = (label: string) =>
  /^(?:add|new|delete|remove|close|rename|edit|duplicate|settings|expand|collapse|more|refresh|copy|download|upload|sign out)(?:\s|$)/i.test(
    label,
  );

export function fitToolbar(
  items: readonly Pick<ResponsiveToolbarItem, 'priority' | 'shortLabel'>[],
  widths: readonly Widths[],
  available: number,
  gap: number,
  moreWidth: number,
  phone: boolean,
  hasMore: boolean,
): ToolbarMode[] {
  const modes: ToolbarMode[] = items.map(() => (phone ? 'icon' : 'full'));
  const order = items
    .map((_, index) => index)
    .sort((a, b) => items[a]!.priority - items[b]!.priority || b - a);
  const size = () => {
    const visible = modes.filter((mode) => mode !== 'overflow').length;
    const more = hasMore || modes.includes('overflow');
    return (
      modes.reduce((sum, mode, index) => sum + (mode === 'overflow' ? 0 : widths[index]![mode]), 0) +
      (more ? moreWidth : 0) +
      Math.max(0, visible + Number(more) - 1) * gap
    );
  };
  if (!phone) {
    for (const index of order) {
      if (size() <= available) return modes;
      if (items[index]!.shortLabel && widths[index]!.short < widths[index]!.full) {
        modes[index] = 'short';
        if (size() <= available) return modes;
      }
      modes[index] = 'icon';
    }
  }
  for (const index of order) {
    if (size() <= available) break;
    modes[index] = 'overflow';
  }
  return modes;
}

export function ResponsiveToolbar({
  items,
  label,
  moreItems,
  morePending,
  className = '',
  toolbarProps,
}: {
  items: readonly ResponsiveToolbarItem[];
  label: string;
  moreItems?: ReactNode;
  morePending?: boolean;
  className?: string;
  toolbarProps?: AnchorProps;
}) {
  const { t, i18n } = useLingui();
  const moreLabel = t({ id: 'toolbar.more', message: 'More' });
  const phone = usePhone();
  const hasMore = Boolean(moreItems) && (phone || items.length === 0);
  const root = useRef<HTMLDivElement>(null);
  const measure = useRef<HTMLDivElement>(null);
  const moreRef = useRef<HTMLDivElement>(null);
  const restoreFocus = useRef(false);
  const moreTriggerRef = useCallback((element: HTMLDivElement | null) => {
    moreRef.current = element;
    return () => {
      if (element?.contains(document.activeElement)) restoreFocus.current = true;
      moreRef.current = null;
    };
  }, []);
  const [modes, setModes] = useState<ToolbarMode[]>([]);
  const [moreOpen, setMoreOpen] = useState(false);
  // Callbacks may change with editor state, but only text, typography, and touch targets affect widths.
  const signature = JSON.stringify(
    items.map(({ id, label, shortLabel, count, priority }) => [id, label, shortLabel, count, priority]),
  );
  useLayoutEffect(() => {
    const element = root.current;
    const samples = measure.current;
    if (!element || !samples) return;
    const descriptions = JSON.parse(signature) as [
      string,
      string,
      string | undefined,
      number | undefined,
      number,
    ][];
    const descriptors = descriptions.map(([, , shortLabel, , priority]) => ({ shortLabel, priority }));
    let widths: Widths[] = [];
    let gap = 0;
    let moreWidth = 0;
    let available = element.getBoundingClientRect().width;
    let disposed = false;
    const update = (sync = false) => {
      if (!available) return;
      const next = fitToolbar(descriptors, widths, available, gap, moreWidth, phone, hasMore);
      if (!hasMore && !next.includes('overflow')) setMoreOpen(false);
      const apply = () => setModes((current) => (current.join() === next.join() ? current : next));
      if (sync) flushSync(apply);
      else apply();
    };
    const read = () => {
      widths = descriptors.map((_, index) => {
        const row = samples.children[index]!;
        const width = (mode: string) =>
          row.querySelector(`[data-fit="${mode}"]`)!.getBoundingClientRect().width;
        return { full: width('full'), short: width('short'), icon: width('icon') };
      });
      gap = parseFloat(getComputedStyle(samples).columnGap) || 0;
      moreWidth = samples.lastElementChild!.getBoundingClientRect().width;
      const rowWidth = (mode: 'full' | 'icon') =>
        widths.reduce((sum, width) => sum + width[mode], 0) +
        (hasMore ? moreWidth : 0) +
        Math.max(0, widths.length + Number(hasMore) - 1) * gap;
      const icons = rowWidth('icon');
      const full = phone ? icons : rowWidth('full');
      element.style.setProperty('--rio-toolbar-icons', `${Math.ceil(icons)}px`);
      element.style.setProperty('--rio-toolbar-full', `${Math.ceil(full)}px`);
      update();
    };
    read();
    const observer = new ResizeObserver(([entry]) => {
      if (!entry) return;
      available = entry.contentRect.width;
      update(true);
    });
    observer.observe(element);
    const fontsChanged = () => {
      if (!disposed) read();
    };
    void document.fonts?.ready.then(fontsChanged);
    document.fonts?.addEventListener('loadingdone', fontsChanged);
    const typography = new MutationObserver(fontsChanged);
    typography.observe(document.documentElement, { attributes: true });
    return () => {
      disposed = true;
      observer.disconnect();
      typography.disconnect();
      document.fonts?.removeEventListener('loadingdone', fontsChanged);
    };
  }, [signature, phone, hasMore]);

  useLayoutEffect(() => {
    if (restoreFocus.current) {
      const visible = root.current?.querySelectorAll<HTMLElement>(
        '[data-item]:not([data-fit="overflow"]) button:not(:disabled), [data-item]:not([data-fit="overflow"]) [role="img"]',
      );
      visible?.[visible.length - 1]?.focus();
      restoreFocus.current = false;
    }
    const focused = document.activeElement;
    if (
      focused instanceof HTMLElement &&
      root.current?.contains(focused) &&
      focused.closest('[data-fit="overflow"]')
    ) {
      moreRef.current?.querySelector('button')?.focus();
    }
  }, [modes, hasMore]);

  const content = (item: ResponsiveToolbarItem, mode: ToolbarMode) => (
    <>
      {mode !== 'icon' && mode !== 'overflow' && !iconAction(item.label) ? (
        <span className="rio-responsive-toolbar__label">
          {mode === 'short' ? item.shortLabel : item.label}
        </span>
      ) : item.count ? (
        <span className="rio-responsive-toolbar__badge" aria-hidden="true">
          {i18n.number(item.count)}
        </span>
      ) : null}
    </>
  );
  if (!items.length && !moreItems) return null;
  const overflow = items.filter((_, index) => modes[index] === 'overflow');
  return (
    <div ref={root} className={`rio-responsive-toolbar ${className}`}>
      <OverflowTrigger value={moreRef}>
        <Toolbar density="compact" aria-label={label} {...toolbarProps}>
          {items.map((item, index) => {
            const fitted = modes[index] ?? 'full';
            const mode = fitted !== 'overflow' && iconAction(item.label) ? 'icon' : fitted;
            // An icon-fit button shows its count as a badge, so its name carries the count too.
            const iconName = item.count
              ? `${item.label}, ${item.shortLabel ?? i18n.number(item.count)}`
              : item.label;
            const button = item.status ? (
              <TooltipTrigger>
                <Focusable>
                  <span
                    role="img"
                    data-variant="quiet"
                    tabIndex={0}
                    aria-label={item.label}
                    className="rio-button rio-responsive-toolbar__button"
                    data-fit={mode}
                    data-primary-action="true"
                  >
                    <span className="rio-button__content">
                      <Icon icon={item.icon} />
                      {content(item, mode)}
                    </span>
                  </span>
                </Focusable>
                <Tooltip>{item.label}</Tooltip>
              </TooltipTrigger>
            ) : (
              <TooltipTrigger>
                <Button
                  variant={item.variant ?? 'quiet'}
                  icon={item.icon}
                  aria-label={mode === 'short' ? item.shortLabel : mode === 'icon' ? iconName : item.label}
                  className="rio-responsive-toolbar__button"
                  data-fit={mode}
                  data-active={item.active || undefined}
                  isDisabled={item.disabled}
                  isPending={item.pending}
                  onPress={item.onAction}
                  onHoverStart={item.onPreload}
                  onFocus={item.onPreload}
                  primaryAction
                  {...item.buttonProps}
                >
                  {content(item, mode)}
                </Button>
                <Tooltip>{item.label}</Tooltip>
              </TooltipTrigger>
            );
            return (
              <div key={item.id} className="rio-responsive-toolbar__item" data-item={item.id} data-fit={mode}>
                {item.render ? item.render(button, { overflow: mode === 'overflow' }) : button}
              </div>
            );
          })}
          {overflow.length || hasMore ? (
            <div ref={moreTriggerRef} className="rio-responsive-toolbar__item">
              <MenuTrigger isOpen={moreOpen} onOpenChange={setMoreOpen}>
                <TooltipTrigger>
                  <Button
                    aria-busy={morePending || undefined}
                    variant="quiet"
                    icon={faEllipsis}
                    aria-label={moreLabel}
                    className="rio-responsive-toolbar__button"
                    data-fit="icon"
                    primaryAction
                  >
                    {morePending ? (
                      <span className="rio-responsive-toolbar__badge" aria-hidden="true">
                        <Icon icon={faHourglassHalf} />
                      </span>
                    ) : null}
                  </Button>
                  <Tooltip>{moreLabel}</Tooltip>
                </TooltipTrigger>
                <Menu aria-label={moreLabel}>
                  {overflow.map((item) => (
                    <MenuItem
                      key={item.id}
                      id={item.id}
                      icon={item.icon}
                      isDisabled={item.status || item.disabled || item.pending}
                      onHoverStart={item.onPreload}
                      onFocus={item.onPreload}
                      onAction={() => {
                        setMoreOpen(false);
                        item.onAction();
                      }}
                    >
                      {item.label}
                    </MenuItem>
                  ))}
                  {moreItems}
                </Menu>
              </MenuTrigger>
            </div>
          ) : null}
        </Toolbar>
      </OverflowTrigger>
      <div ref={measure} className="rio-responsive-toolbar__measure" aria-hidden="true" inert>
        {items.map((item) => (
          <div key={item.id}>
            {(['full', 'short', 'icon'] as const).map((mode) => (
              <span
                key={mode}
                className="rio-button rio-responsive-toolbar__button"
                data-size="md"
                data-variant={item.variant ?? 'quiet'}
                data-primary-action="true"
                data-fit={mode}
              >
                <span className="rio-button__content">
                  <Icon icon={item.icon} />
                  {content(item, mode)}
                </span>
              </span>
            ))}
          </div>
        ))}
        <span
          className="rio-button rio-responsive-toolbar__button"
          data-fit="icon"
          data-primary-action="true"
        >
          <Icon icon={faEllipsis} />
        </span>
      </div>
    </div>
  );
}
