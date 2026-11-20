import {
  Children,
  cloneElement,
  isValidElement,
  createContext,
  useCallback,
  useContext,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
} from 'react';
import { useLingui } from '@lingui/react/macro';
import { Dialog, DialogTrigger, type DialogTriggerProps } from 'react-aria-components';
import { faSliders } from '@fortawesome/free-solid-svg-icons';
import { Button, DialogTitle, Popover, type ButtonProps } from '@riosoma/ui';
import type { IconDefinition } from '@riosoma/icons';
import { useToolbarOverflowTrigger, type ResponsiveToolbarItem } from '../../../components/ResponsiveToolbar';
import { HelpButton } from '../../../docs/HelpButton';
import type { HelpRequest } from '../../../docs/help-request';
import { anchor, type AnchorId } from '../../../demos/anchors';

interface RegisteredSetting {
  item: ResponsiveToolbarItem;
  marker: HTMLSpanElement;
}
type Register = (id: string, setting: RegisteredSetting | null) => void;
const Registration = createContext<Register | null>(null);
const Items = createContext<readonly ResponsiveToolbarItem[]>([]);
type SettingHelp = HelpRequest & { anchorId: AnchorId };
const Documentation = createContext<SettingHelp | undefined>(undefined);
export const useToolbarSettings = () => useContext(Items);

/** Settings keep their own data and dialog state while sharing the view's measured row. */
export function ToolbarSettings({ children, helpTopic }: { children: ReactNode; helpTopic?: SettingHelp }) {
  const [items, setItems] = useState(new Map<string, RegisteredSetting>());
  const register = useCallback<Register>((id, item) => {
    setItems((current) => {
      const next = new Map(current);
      if (item) next.set(id, item);
      else next.delete(id);
      return next;
    });
  }, []);
  // Conditional settings belong beside their fields even when data makes them appear later.
  const values = useMemo(
    () =>
      [...items.values()]
        .sort((a, b) => {
          const position = a.marker.compareDocumentPosition(b.marker);
          return position & Node.DOCUMENT_POSITION_FOLLOWING
            ? -1
            : position & Node.DOCUMENT_POSITION_PRECEDING
              ? 1
              : 0;
        })
        .map(({ item }) => item),
    [items],
  );
  return (
    <Documentation value={helpTopic}>
      <Registration value={register}>
        <Items value={values}>{children}</Items>
      </Registration>
    </Documentation>
  );
}

function documentPopup(
  popup: ReactElement,
  topic: SettingHelp | undefined,
  label: string,
  close: () => void,
): ReactElement {
  if (!topic) return popup;
  if (popup.type === DialogTitle)
    return (
      <div className="rio-help-heading rio-help-dialog-heading" {...anchor(topic.anchorId)}>
        {popup}
        <HelpButton subject={label} moduleId={topic.id} section={topic.section} onPress={close} />
      </div>
    );
  const props = popup.props as {
    children?: ReactNode | ((...args: unknown[]) => ReactNode);
    'aria-label'?: string;
  };
  const documentChildren = (children: ReactNode) =>
    props['aria-label'] ? (
      <>
        <div className="rio-help-heading" {...anchor(topic.anchorId)}>
          <span>{label}</span>
          <HelpButton subject={label} moduleId={topic.id} section={topic.section} onPress={close} />
        </div>
        {children}
      </>
    ) : (
      Children.map(children, (child) =>
        isValidElement(child) ? documentPopup(child, topic, label, close) : child,
      )
    );
  if (typeof props.children === 'function') {
    const render = props.children;
    return cloneElement(popup as ReactElement<{ children?: typeof render }>, {
      children: (...args) => documentChildren(render(...args)),
    });
  }
  return cloneElement(popup as ReactElement<{ children?: ReactNode }>, {}, documentChildren(props.children));
}

function useSetting(item: Omit<ResponsiveToolbarItem, 'id' | 'priority'> & { priority?: number }) {
  const register = useContext(Registration);
  const id = useId();
  const marker = useRef<HTMLSpanElement>(null);
  useLayoutEffect(() => {
    if (marker.current)
      register?.(id, { item: { ...item, id, priority: item.priority ?? 0 }, marker: marker.current });
  }, [register, id, item]);
  useLayoutEffect(() => () => register?.(id, null), [register, id]);
  return { fitted: Boolean(register), marker };
}

/** Outside a database toolbar, settings keep their original standalone layout. */
export function SettingsBar({ children, className }: { children: ReactNode; className: string }) {
  return useContext(Registration) ? children : <div className={className}>{children}</div>;
}

function FittedDialog({
  button,
  popup,
  overflow,
  isOpen,
  onOpenChange,
}: {
  button: ReactNode;
  popup: ReactElement;
  overflow: boolean;
  isOpen: boolean;
  onOpenChange(open: boolean): void;
}) {
  const more = useToolbarOverflowTrigger();
  return (
    <DialogTrigger
      isOpen={isOpen}
      onOpenChange={(next) => {
        onOpenChange(next);
        if (!next && overflow) requestAnimationFrame(() => more.current?.querySelector('button')?.focus());
      }}
    >
      {button}
      {overflow && popup.type === Popover
        ? cloneElement(popup as ReactElement<{ triggerRef: typeof more }>, { triggerRef: more })
        : popup}
    </DialogTrigger>
  );
}

/** Reuses the existing trigger and panel, including dialogs that open over a settings panel. */
export function SettingsTrigger({
  helpTopic,
  label,
  icon,
  count,
  shortLabel,
  priority,
  children,
  ...props
}: DialogTriggerProps & {
  label: string;
  icon?: IconDefinition;
  count?: number;
  shortLabel?: string;
  priority?: number;
  helpTopic?: SettingHelp;
}) {
  const inheritedHelp = useContext(Documentation);
  const [open, setOpen] = useState(false);
  const [trigger, popup] = Children.toArray(children) as [
    ReactElement<ButtonProps & { 'data-active'?: boolean }>,
    ReactElement,
  ];
  const isOpen = props.isOpen ?? open;
  const onOpenChange = (next: boolean) => {
    setOpen(next);
    props.onOpenChange?.(next);
  };
  const documentedPopup = documentPopup(popup, helpTopic ?? inheritedHelp, label, () => onOpenChange(false));
  const { fitted, marker } = useSetting({
    label,
    count,
    shortLabel,
    priority,
    icon: icon ?? trigger.props.icon ?? faSliders,
    variant: trigger.props.variant ?? 'secondary',
    disabled: trigger.props.isDisabled,
    pending: trigger.props.isPending,
    active: trigger.props['data-active'],
    onAction: () => onOpenChange(true),
    render: (button, { overflow }) => (
      <Registration value={null}>
        <FittedDialog
          button={button}
          popup={documentedPopup}
          overflow={overflow}
          isOpen={isOpen}
          onOpenChange={onOpenChange}
        />
      </Registration>
    ),
  });
  return fitted ? (
    <span ref={marker} hidden />
  ) : (
    <DialogTrigger {...props} isOpen={isOpen} onOpenChange={onOpenChange}>
      {trigger}
      {documentedPopup}
    </DialogTrigger>
  );
}

/** A field picker retains its complete choices in a panel when its toolbar label shrinks. */
export function SettingsPicker({
  label,
  value,
  icon,
  children,
}: {
  label: string;
  icon: IconDefinition;
  children: ReactNode;
  value?: string;
}) {
  const { t } = useLingui();
  const fullLabel = value ? t({ id: 'view.toolbar.settingValue', message: `${label}: ${value}` }) : label;
  const fitted = useContext(Registration);
  return fitted ? (
    <SettingsTrigger label={fullLabel} shortLabel={value} icon={icon}>
      <Button variant="quiet">{label}</Button>
      <Popover placement="bottom start" className="rio-view-popover">
        <Dialog aria-label={label} className="rio-view-dialog">
          {children}
        </Dialog>
      </Popover>
    </SettingsTrigger>
  ) : (
    children
  );
}

export function SettingsAction({
  label,
  onAction,
  ...props
}: Omit<ButtonProps, 'onPress'> & {
  label: string;
  icon: IconDefinition;
  onAction(): void;
}) {
  const { fitted, marker } = useSetting({
    label,
    icon: props.icon,
    variant: props.variant,
    disabled: props.isDisabled,
    pending: props.isPending,
    onAction,
  });
  return fitted ? <span ref={marker} hidden /> : <Button {...props} onPress={onAction} />;
}
