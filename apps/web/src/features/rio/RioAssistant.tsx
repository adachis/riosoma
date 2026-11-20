import {
  faClockRotateLeft,
  faEllipsis,
  faListCheck,
  faPlus,
  faXmark,
  faWandMagicSparkles,
} from '@fortawesome/free-solid-svg-icons';
import { RemoteApproval } from './RemoteApproval';
import {
  Component,
  Fragment,
  type ReactNode,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { Trans, useLingui } from '@lingui/react/macro';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { RouterProvider as LinkRouterProvider } from 'react-aria-components';
import { useRouter, useParams, useLocation, useMatch } from '@tanstack/react-router';
import {
  idKind,
  type RioBlock,
  type RioContext,
  type RioConversation,
  type RioConversationDetail,
} from '@riosoma/contracts';
import { RioAvatar, useRioMood } from '@riosoma/rio';
import {
  Button,
  Dialog,
  Drawer,
  Heading,
  Link,
  Select,
  ListBoxItem,
  Menu,
  MenuItem,
  MenuTrigger,
  Spinner,
  TextArea,
} from '@riosoma/ui';
import { api, ApiError } from '../../api';
import { useDatabaseSession } from '../../data/hooks';
import type { DatabaseSession } from '../../data/types';
import { useServerMessage } from '../../messages/useServerMessage';
import { useSession } from '../../session';
import { useRelativeTime } from '../../relative-time';
import { canManageAi } from '../ai/access';
import { Block, Usage } from './Blocks';
import { PLAN_APPLIED } from './PlanPreview';
import { FootprintPill, footprintMineQuery } from '../ai-footprint/FootprintPill';
import { Markdown } from './Markdown';
import { questionContext } from './context';
import { RIO_DANCE_MS, subscribeRioReactions } from './reactions';
import { useSundayAfternoon } from '../celebrations/surprises';
import { streamReply } from './stream';
import { rioStatusQuery } from './status';
import { ProviderOffNotice } from './ProviderOffNotice';
import { GatewayErrorMessage } from './GatewayErrorMessage';
import { RoutineDialog } from '../routines/RoutineForm';
import { RoutineList } from '../routines/RoutineList';
import { anchor } from '../../demos/anchors';
import { useConversationStore } from './conversation-store';
import './RioLauncher.css';
import './RioAssistant.css';

export { rioStatusQuery } from './status';

export function RioAssistant({ phone, initialOpen = false }: { phone: boolean; initialOpen?: boolean }) {
  // An explicit close consumes the initial opening even if a database error replaces the panel.
  const [dismissed, setDismissed] = useState(false);
  const router = useRouter();
  const followLink = (href: string) => {
    const url = new URL(href, window.location.href);
    if (url.origin !== window.location.origin) {
      window.open(href, '_blank', 'noopener,noreferrer');
      return;
    }
    void router.navigate({ href: url.pathname + url.search + url.hash });
  };
  const params = useParams({ strict: false });
  const location = useLocation();
  const recordPage = useMatch({
    from: '/app/$databaseId/$tableId/$viewId/$recordId/page',
    shouldThrow: false,
  });
  const databaseId =
    params.databaseId && idKind(params.databaseId) === 'database' ? params.databaseId : undefined;
  const context: RioContext = databaseId
    ? { databaseId, tableId: params.tableId, viewId: params.viewId, recordId: params.recordId }
    : {
        page: location.pathname.startsWith('/settings') ? 'settings' : 'home',
        folderId: location.pathname.startsWith('/home/folders/')
          ? decodeURIComponent(location.pathname.split('/')[3] ?? '')
          : undefined,
      };
  const auth = useSession();
  const previewing = Boolean(new URLSearchParams(location.searchStr).get('rioPreview'));
  const recordCard =
    context.recordId &&
    idKind(context.recordId) === 'record' &&
    !recordPage &&
    !params.recordSuffix &&
    (auth?.preferences.recordLayout ?? 'card') === 'card';
  const props = {
    phone,
    previewing,
    modalTarget: Boolean(previewing || recordCard),
    context,
    canManage: canManageAi(auth),
    initialOpen: initialOpen && !dismissed,
    onClose: () => setDismissed(true),
  };
  return (
    <LinkRouterProvider navigate={followLink}>
      <SessionBoundary
        resetKey={databaseId}
        fallback={<RioAssistantView {...props} modalTarget={previewing} session={null} />}
      >
        <SessionAssistant {...props} />
      </SessionBoundary>
    </LinkRouterProvider>
  );
}

// A database that becomes unavailable must not take the shell and its help panel down with it.
class SessionBoundary extends Component<
  { children: ReactNode; fallback: ReactNode; resetKey: string | undefined },
  { failed: boolean }
> {
  override state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  override componentDidUpdate(previous: Readonly<{ resetKey: string | undefined }>) {
    if (this.state.failed && previous.resetKey !== this.props.resetKey) this.setState({ failed: false });
  }
  override render() {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}
function SessionAssistant({
  previewing,
  ...props
}: {
  phone: boolean;
  previewing: boolean;
  modalTarget: boolean;
  context: RioContext;
  canManage: boolean;
  initialOpen: boolean;
  onClose: () => void;
}) {
  const session = useDatabaseSession(props.context.databaseId ?? null);
  return (
    <RioAssistantView
      {...props}
      modalTarget={previewing || (props.modalTarget && Boolean(session))}
      session={session}
    />
  );
}

const linkedRemoteApproval = () =>
  /^#remote-approval=([0-9a-f-]{36})$/.exec(window.location.hash)?.[1] ?? null;

export function RioAssistantView({
  phone,
  modalTarget = false,
  context,
  session,
  canManage,
  initialOpen = false,
  onClose,
}: {
  phone: boolean;
  modalTarget?: boolean;
  context: RioContext;
  session: DatabaseSession | null;
  canManage: boolean;
  initialOpen?: boolean;
  onClose?: () => void;
}) {
  const { t, i18n } = useLingui();
  const message = useServerMessage();
  const queryClient = useQueryClient();
  const { store, state } = useConversationStore();
  const { open, tier, conversation, messages, input } = state;
  const setOpen = (value: boolean) => store.patch({ open: value });
  const setInput = (value: string) => store.patch({ input: value });
  const setTier = (value: 'everyday' | 'power') => store.patch({ tier: value });
  const setMessages = store.messages;
  useEffect(() => {
    if (initialOpen) store.patch({ open: true });
  }, [initialOpen, store]);
  const [remoteApproval, setRemoteApproval] = useState(linkedRemoteApproval);
  useEffect(() => {
    const update = () => {
      const id = linkedRemoteApproval();
      setRemoteApproval(id);
      if (id) store.patch({ open: true });
    };
    update();
    window.addEventListener('hashchange', update);
    return () => window.removeEventListener('hashchange', update);
  }, [store]);
  const [mood, setMood, pulse] = useRioMood();
  useEffect(() => {
    const applied = (event: Event) => {
      const receipt = (event as CustomEvent<RioBlock>).detail;
      if (receipt.kind !== 'receipt') return;
      const matches = (block: RioBlock) => block.kind === 'plan' && block.planId === receipt.planId;
      if (!store.get().messages.some((entry) => entry.blocks.some(matches))) return;
      // Preview navigation can close the drawer; its conversation still needs the receipt.
      store.messages((previous) =>
        previous.map((entry) => ({
          ...entry,
          blocks: entry.blocks.map((block) => (matches(block) ? receipt : block)),
        })),
      );
      setMood('idle');
      pulse('celebrating', 3);
    };
    window.addEventListener(PLAN_APPLIED, applied);
    return () => window.removeEventListener(PLAN_APPLIED, applied);
  }, [store, setMood, pulse]);
  const [busy, setBusy] = useState(false);
  const [switching, setSwitching] = useState(false);
  const [working, setWorking] = useState<string | null>(null);
  const [error, setError] = useState<ReactNode>(null);
  const [showRoutines, setShowRoutines] = useState(false);
  const [addingRoutine, setAddingRoutine] = useState(false);
  const flight = useRef<AbortController | null>(null);
  const trigger = useRef<HTMLSpanElement>(null);
  const end = useRef<HTMLDivElement>(null);
  const transcript = useRef<HTMLDivElement>(null);
  const transcriptContent = useRef<HTMLDivElement>(null);
  const restoringScroll = useRef(false);
  const follow = useRef(true);
  const status = useQuery({ ...rioStatusQuery, enabled: open });
  const history = useQuery({
    queryKey: ['rio', 'conversations'],
    queryFn: () => api<RioConversation[]>('/api/rio/conversations'),
    enabled: open,
  });
  useEffect(() => {
    if (!open) return;
    void store.hydrate().catch(() => setError(message('errors.internal')));
  }, [open, store, message]);
  useEffect(() => {
    const refresh = () => {
      if (document.visibilityState === 'visible' && !flight.current && store.get().ready)
        void store.hydrate(true).catch(() => setError(message('errors.internal')));
    };
    window.addEventListener('focus', refresh);
    return () => window.removeEventListener('focus', refresh);
  }, [store, message]);
  useEffect(() => {
    const saved = store.get().dividers;
    const dividers = [...saved];
    let label: string | undefined;
    messages.forEach((entry, index) => {
      if (!entry.context) return;
      const location = entry.context.label;
      const after = messages[index - 1]?.id ?? null;
      if (
        label !== undefined &&
        label !== location &&
        !dividers.some((divider) => divider.after === after && divider.location === location)
      )
        dividers.push({ after, location });
      label = location;
    });
    if (dividers.length !== saved.length) store.patch({ dividers });
  }, [messages, store]);
  const schema = session?.getSchema();
  const databaseName = schema?.database.name;
  const tableName = context.tableId ? schema?.tableById.get(context.tableId)?.name : undefined;
  const location = databaseName
    ? [databaseName, tableName].filter(Boolean).join(' › ')
    : context.databaseId
      ? null
      : t({ id: 'rio.context.home', message: 'Home' });
  useEffect(() => {
    if (location) store.context(location);
  }, [location, store]);
  const effectiveTier = status.data?.tiers.includes(tier) ? tier : (status.data?.tiers[0] ?? 'everyday');
  const enabled = Boolean(status.data?.enabled && !status.data.paused && status.data.tiers.length);
  const stop = useCallback(() => {
    flight.current?.abort();
    flight.current = null;
    setBusy(false);
    setSwitching(false);
    setWorking(null);
    setMood('idle');
  }, [setMood]);
  useEffect(() => {
    const leave = () => flight.current?.abort();
    window.addEventListener('pagehide', leave);
    return () => {
      leave();
      window.removeEventListener('pagehide', leave);
    };
  }, []);
  useLayoutEffect(() => {
    const element = transcript.current;
    const content = transcriptContent.current;
    if (!open || (phone && modalTarget) || !state.ready || showRoutines || !element || !content) return;
    const saved = store.get();
    let frame = 0;
    restoringScroll.current = true;
    const restore = () => {
      const target = saved.scrollAnchor
        ? [...content.querySelectorAll<HTMLElement>('[data-message-id]')].find(
            (entry) => entry.dataset.messageId === saved.scrollAnchor!.messageId,
          )
        : undefined;
      const top =
        target && saved.scrollAnchor
          ? element.scrollTop +
            target.getBoundingClientRect().top -
            element.getBoundingClientRect().top +
            saved.scrollAnchor.offset
          : (saved.scrollTop ?? element.scrollHeight);
      element.scrollTop = top;
      follow.current = element.scrollHeight - element.scrollTop - element.clientHeight < 80;
      if (content.querySelector('[role="progressbar"]')) return;
      const maximum = Math.max(0, element.scrollHeight - element.clientHeight);
      if (Math.abs(element.scrollTop - Math.min(Math.max(0, top), maximum)) > 1) return;
      // A scroll event from a clamped loading transcript must not replace the saved position.
      frame = requestAnimationFrame(() => {
        restoringScroll.current = false;
        resize.disconnect();
        mutations.disconnect();
      });
    };
    const schedule = () => {
      cancelAnimationFrame(frame);
      restoringScroll.current = true;
      frame = requestAnimationFrame(restore);
    };
    const resize = new ResizeObserver(schedule);
    const mutations = new MutationObserver(schedule);
    resize.observe(content);
    mutations.observe(content, { childList: true, subtree: true, characterData: true });
    restore();
    return () => {
      cancelAnimationFrame(frame);
      resize.disconnect();
      mutations.disconnect();
      restoringScroll.current = false;
    };
  }, [open, phone, modalTarget, store, state.ready, conversation, showRoutines]);
  useEffect(() => {
    if (!restoringScroll.current && follow.current) end.current?.scrollIntoView?.({ block: 'nearest' });
  }, [messages, working]);
  const [dancing, setDancing] = useState(false);
  // Celebrations and surprises elsewhere ask for a reaction.  A Rio busy with a question keeps
  // thinking rather than breaking off to cheer.
  useEffect(() => {
    let stopDancing: ReturnType<typeof setTimeout> | undefined;
    const unsubscribe = subscribeRioReactions((reaction) => {
      if (flight.current) return;
      if (reaction.kind === 'mood') {
        pulse(reaction.mood, reaction.seconds);
        return;
      }
      clearTimeout(stopDancing);
      setDancing(true);
      pulse('happy', RIO_DANCE_MS / 1000);
      stopDancing = setTimeout(() => setDancing(false), RIO_DANCE_MS);
    });
    return () => {
      clearTimeout(stopDancing);
      unsubscribe();
    };
  }, [pulse]);
  // Sunday afternoons are for resting, so Rio dozes off sooner and spends more of them asleep.
  const sunday = useSundayAfternoon();
  const close = () => {
    stop();
    setOpen(false);
    onClose?.();
    requestAnimationFrame(() => trigger.current?.querySelector('button')?.focus());
  };
  const celebrate = () => {
    setMood('idle');
    pulse('celebrating', 3);
  };
  async function send(text: string) {
    text = text.trim();
    if (!text || text.length > 8000 || flight.current || !enabled) return;
    const controller = new AbortController();
    follow.current = true;
    flight.current = controller;
    setBusy(true);
    setError(null);
    setWorking(null);
    setMood('thinking');
    setInput('');
    let receivedReceipt = false;
    let failed = false;
    let replyId = '';
    try {
      const location = await questionContext(context, session);
      if (controller.signal.aborted) return;
      await store.hydrate();
      const id = store.get().conversation;
      if (!id || controller.signal.aborted) return;
      setMessages((previous) => [
        ...previous,
        {
          id: crypto.randomUUID(),
          role: 'person',
          blocks: [{ kind: 'text', text }],
          createdAt: new Date().toISOString(),
        },
      ]);
      await streamReply(
        id,
        {
          text,
          context: location,
          tier: effectiveTier,
          autonomy: status.data?.autonomy,
          locale: i18n.locale,
        },
        controller.signal,
        (event) => {
          if (controller.signal.aborted) return;
          if (event.type === 'contextUsage') {
            store.patch({ contextUsage: event.usage });
          } else if (event.type === 'start') {
            replyId = event.message.id;
            setMessages((previous) => [...previous, event.message]);
          } else if (event.type === 'working') {
            setWorking(event.messageKey);
            setMood('thinking');
          } else if (event.type === 'error') {
            failed = true;
            setError(<GatewayErrorMessage {...event} canManage={canManage} />);
            setMood('oops');
          } else if (event.type === 'text' || event.type === 'block' || event.type === 'usage') {
            if (event.type === 'text') {
              setWorking(null);
              setMood('happy');
            }
            if (event.type === 'block' && event.block.kind === 'receipt') {
              receivedReceipt = true;
              celebrate();
            }
            if (event.type === 'block' && event.block.kind === 'error') {
              failed = true;
              setMood('oops');
            }
            setMessages((previous) =>
              previous.map((item) => {
                if (item.id !== replyId) return item;
                if (event.type === 'usage') return { ...item, usage: event.usage };
                const blocks = [...item.blocks];
                const prior = blocks[event.blockIndex];
                blocks[event.blockIndex] =
                  event.type === 'block'
                    ? event.block
                    : { kind: 'text', text: (prior?.kind === 'text' ? prior.text : '') + event.delta };
                return { ...item, blocks };
              }),
            );
          }
        },
      );
    } catch (cause) {
      if (!controller.signal.aborted) {
        failed = true;
        setError(message(cause instanceof ApiError ? cause.info.messageKey : 'errors.internal'));
        setMood('oops');
      }
    } finally {
      if (flight.current === controller) {
        flight.current = null;
        setBusy(false);
        setWorking(null);
        // A failed question can be edited and sent again without replacing a newer draft.
        if (failed && !store.get().input) setInput(text);
        if (!failed) {
          if (receivedReceipt) celebrate();
          else setMood('idle');
        }
        void queryClient.invalidateQueries({ queryKey: ['rio', 'conversations'] });
        // The shell's monthly totals now include this reply.
        void queryClient.invalidateQueries({ queryKey: footprintMineQuery.queryKey });
      }
    }
  }
  async function choose(id: string) {
    stop();
    setError(null);
    const controller = new AbortController();
    flight.current = controller;
    setBusy(true);
    setSwitching(true);
    try {
      const result =
        id === 'new'
          ? {
              conversation: await api<RioConversation>('/api/rio/conversations', {
                method: 'POST',
                signal: controller.signal,
              }),
              messages: [],
            }
          : await api<RioConversationDetail>('/api/rio/active-conversation', {
              method: 'PUT',
              body: { conversationId: id },
              signal: controller.signal,
            });
      if (!controller.signal.aborted) {
        store.accept(result);
        store.patch({ input: '', scrollTop: null, scrollAnchor: null, location });
        follow.current = true;
        void queryClient.invalidateQueries({ queryKey: ['rio', 'conversations'] });
      }
    } catch (cause) {
      if (!controller.signal.aborted) {
        setError(message(cause instanceof ApiError ? cause.info.messageKey : 'errors.internal'));
        setMood('oops');
      }
    } finally {
      if (flight.current === controller) {
        flight.current = null;
        setBusy(false);
        setSwitching(false);
      }
    }
  }
  async function compact() {
    if (!conversation || busy || !enabled) return;
    const controller = new AbortController();
    follow.current = true;
    flight.current = controller;
    setBusy(true);
    setError(null);
    setMood('thinking');
    try {
      const result = await api<RioConversationDetail>(`/api/rio/conversations/${conversation}/compact`, {
        method: 'POST',
        signal: controller.signal,
        body: {
          context:
            state.contextUsage?.databaseId === undefined
              ? await questionContext(context, session)
              : state.contextUsage.databaseId === null
                ? {}
                : { databaseId: state.contextUsage.databaseId },
          tier: effectiveTier,
          locale: i18n.locale,
        },
      });
      if (!controller.signal.aborted) store.accept(result);
    } catch (cause) {
      if (!controller.signal.aborted) {
        const info = cause instanceof ApiError ? cause.info : { messageKey: 'errors.internal' };
        setError(
          <GatewayErrorMessage
            messageKey={info.messageKey}
            params={'params' in info ? info.params : undefined}
            providerId={
              'params' in info && typeof info.params?.providerId === 'string'
                ? info.params.providerId
                : undefined
            }
            canManage={canManage}
          />,
        );
      }
    } finally {
      if (flight.current === controller) {
        flight.current = null;
        setBusy(false);
        setMood('idle');
        void queryClient.invalidateQueries({ queryKey: footprintMineQuery.queryKey });
      }
    }
  }
  const divider = (after: string | null) =>
    state.dividers
      .filter((entry) => entry.after === after)
      .map((entry, index) => (
        <p key={`${after}-${index}`} className="rio-assistant__quiet" role="separator">
          <Trans id="rio.context.changed">
            Now in {entry.location || t({ id: 'rio.context.home', message: 'Home' })}
          </Trans>
        </p>
      ));
  const workingLabels: Record<string, string> = {
    'rio.working.databases': t({ id: 'rio.working.databases', message: 'Looking through your databases…' }),
    'rio.working.schema': t({ id: 'rio.working.schema', message: 'Reading the table’s setup…' }),
    'rio.working.records': t({ id: 'rio.working.records', message: 'Finding records…' }),
    'rio.working.counting': t({ id: 'rio.working.counting', message: 'Counting…' }),
    'rio.working.planning': t({ id: 'rio.working.planning', message: 'Planning the changes…' }),
  };
  const panel = (
    <div
      className="rio-assistant__panel"
      data-compact={phone || undefined}
      data-conversation-id={conversation ?? undefined}
      onKeyDown={(event) => {
        if (event.key === 'Escape') close();
      }}
    >
      <header className="rio-assistant__header">
        <Heading level={2} className={(history.data?.length ?? 0) > 10 ? 'rio-visually-hidden' : undefined}>
          <Trans id="rio.title">Rio</Trans>
        </Heading>
        <span className="rio-assistant__secondary-action">
          <Button
            variant="quiet"
            icon={faPlus}
            primaryAction
            aria-label={t({ id: 'rio.new', message: 'New conversation' })}
            onPress={() => void choose('new')}
            isDisabled={busy}
          />
        </span>
        {(history.data?.length ?? 0) > 10 ? (
          <Select
            listId="rio.conversations"
            filterable
            aria-label={t({ id: 'rio.history', message: 'Past conversations' })}
            placeholder={t({ id: 'rio.history', message: 'Past conversations' })}
            selectedKey={conversation}
            onSelectionChange={(key) => {
              if (key !== null) void choose(String(key));
            }}
          >
            <ListBoxItem id="new">{t({ id: 'rio.new', message: 'New conversation' })}</ListBoxItem>
            {(history.data ?? []).map((item) => (
              <ListBoxItem
                id={item.id}
                key={item.id}
                textValue={item.title || t({ id: 'rio.new', message: 'New conversation' })}
                description={<ConversationTime date={item.updatedAt} />}
              >
                {item.title || t({ id: 'rio.new', message: 'New conversation' })}
              </ListBoxItem>
            ))}
          </Select>
        ) : (
          <MenuTrigger>
            <Button
              variant="quiet"
              icon={faClockRotateLeft}
              primaryAction
              aria-label={t({ id: 'rio.history', message: 'Past conversations' })}
            />
            <Menu
              aria-label={t({ id: 'rio.history', message: 'Past conversations' })}
              onAction={(key) => void choose(String(key))}
            >
              <MenuItem id="new" textValue={t({ id: 'rio.new', message: 'New conversation' })}>
                <Trans id="rio.new">New conversation</Trans>
              </MenuItem>
              {history.data?.map((item) => (
                <MenuItem
                  key={item.id}
                  id={item.id}
                  textValue={item.title || t({ id: 'rio.new', message: 'New conversation' })}
                  description={<ConversationTime date={item.updatedAt} />}
                >
                  {item.title || t({ id: 'rio.new', message: 'New conversation' })}
                </MenuItem>
              ))}
            </Menu>
          </MenuTrigger>
        )}
        {status.data?.routines || showRoutines ? (
          <span className="rio-assistant__secondary-action">
            <Button
              variant="quiet"
              icon={faListCheck}
              primaryAction
              aria-label={t({ id: 'rio.routines', message: 'Routines' })}
              aria-pressed={showRoutines}
              onPress={() => setShowRoutines(!showRoutines)}
            />
          </span>
        ) : null}
        <span className="rio-assistant__header-overflow">
          <MenuTrigger>
            <Button
              variant="quiet"
              icon={faEllipsis}
              primaryAction
              aria-label={t({ id: 'rio.moreActions', message: 'More Rio actions' })}
            />
            <Menu aria-label={t({ id: 'rio.moreActions', message: 'More Rio actions' })}>
              <MenuItem id="new" isDisabled={busy} onAction={() => void choose('new')}>
                {t({ id: 'rio.new', message: 'New conversation' })}
              </MenuItem>
              {status.data?.routines || showRoutines ? (
                <MenuItem id="routines" onAction={() => setShowRoutines(!showRoutines)}>
                  {t({ id: 'rio.routines', message: 'Routines' })}
                </MenuItem>
              ) : null}
            </Menu>
          </MenuTrigger>
        </span>

        {/* AI spending belongs beside the assistant that spends it, never in the app's own bar. */}
        <span className="rio-assistant__header-end">
          <FootprintPill />
          <Button
            autoFocus
            className="rio-assistant__close"
            variant="quiet"
            icon={faXmark}
            primaryAction
            aria-label={t({ id: 'rio.close', message: 'Close Rio' })}
            onPress={close}
          />
        </span>
      </header>
      {showRoutines ? (
        <div className="rio-assistant__conversation">
          <RoutineList
            {...(context.databaseId ? { databaseId: context.databaseId } : {})}
            {...(status.data?.routines ? { onNew: () => setAddingRoutine(true) } : {})}
          />
          {addingRoutine ? (
            <RoutineDialog
              {...(context.databaseId ? { databaseId: context.databaseId } : {})}
              onClose={() => setAddingRoutine(false)}
            />
          ) : null}
        </div>
      ) : null}
      <div
        ref={transcript}
        onScroll={(event) => {
          if (!state.ready || restoringScroll.current) return;
          const element = event.currentTarget;
          follow.current = element.scrollHeight - element.scrollTop - element.clientHeight < 80;
          const top = element.getBoundingClientRect().top;
          const entries = [...element.querySelectorAll<HTMLElement>('[data-message-id]')];
          const target = entries.find((entry) => entry.getBoundingClientRect().bottom > top);
          store.patch({
            scrollTop: element.scrollTop,
            scrollAnchor: target
              ? { messageId: target.dataset.messageId!, offset: top - target.getBoundingClientRect().top }
              : null,
          });
        }}
        className="rio-assistant__conversation"
        hidden={showRoutines}
        role="log"
        aria-label={t({ id: 'rio.title', message: 'Rio' })}
        aria-live="polite"
      >
        <div ref={transcriptContent}>
          {status.isPending && <Spinner />}
          {status.error && <p role="alert">{message('errors.internal')}</p>}
          {history.error && <p role="alert">{message('errors.internal')}</p>}
          {status.data && !status.data.enabled ? (
            <p>
              {status.data.disabledReason === 'noProvider' ? (
                <ProviderOffNotice />
              ) : (
                <>
                  <Trans id="rio.off">Rio isn’t turned on here yet.</Trans>{' '}
                  {canManage && (
                    <Link href="/settings/ai">
                      <Trans id="rio.off.admin">Turn on AI in Settings</Trans>
                    </Link>
                  )}
                </>
              )}
            </p>
          ) : status.data?.paused ? (
            <p>
              <Trans id="rio.paused">
                {'Rio is resting until next month.  This month’s AI budget is used up.'}
              </Trans>
            </p>
          ) : status.data && !messages.length ? (
            <p>
              <Trans id="rio.empty">
                {'Hi!  I’m Rio.  Ask me to find records, explain a table, or build something for you.'}
              </Trans>
            </p>
          ) : null}
          {remoteApproval && <RemoteApproval id={remoteApproval} disabled={busy} />}
          {divider(null)}
          {messages.map((item) => (
            <Fragment key={item.id}>
              <article
                key={item.id}
                className="rio-assistant__message"
                data-role={item.role}
                data-message-id={item.id}
                data-summarized={item.summarized || undefined}
              >
                {item.summarized && (
                  <small className="rio-assistant__quiet">
                    <Trans id="rio.summarized">Summarized</Trans>
                  </small>
                )}
                {item.compaction &&
                  item.blocks.some(
                    (block) => block.kind === 'notice' && block.messageKey === 'rio.compacted',
                  ) && (
                    <p>
                      <Trans id="rio.compacted">
                        Conversation compacted. Earlier messages are still here.
                      </Trans>
                    </p>
                  )}
                {item.blocks.map((block, index) =>
                  block.kind === 'attention' || (item.compaction && block.kind === 'notice') ? null : (
                    <Block
                      key={`${item.id}-${index}`}
                      block={block}
                      canManage={canManage}
                      session={session}
                      disabled={busy || !enabled}
                      onAnswer={(text) => void send(text)}
                      onError={() => setMood('oops')}
                      onReceipt={celebrate}
                      onReplace={(replacement) =>
                        setMessages((previous) =>
                          previous.map((entry) =>
                            entry.id === item.id
                              ? {
                                  ...entry,
                                  blocks: entry.blocks.map((old, position) =>
                                    position === index ? replacement : old,
                                  ),
                                }
                              : entry,
                          ),
                        )
                      }
                    />
                  ),
                )}
                {item.usage && <Usage usage={item.usage} />}
              </article>
              {divider(item.id)}
            </Fragment>
          ))}
          <div ref={end} />
        </div>
      </div>
      <div className="rio-assistant__foot" hidden={showRoutines}>
        <div className="rio-assistant__mascot" data-dancing={dancing || undefined}>
          {/* Rio sits beside a conversation people are reading, so a nap waits a good while. */}
          <RioAvatar size={phone ? 88 : 144} mood={mood} napDelaySeconds={sunday ? 60 : 120} />
        </div>
        <div className="rio-assistant__composer">
          <div className="rio-assistant__composer-top">
            {state.contextUsage?.limit && state.contextUsage.tokens / state.contextUsage.limit >= 0.75 ? (
              <div className="rio-assistant__attention">
                <p>
                  <Trans id="rio.context.long">
                    This conversation is getting long. Rio will start forgetting the earliest messages.
                  </Trans>
                </p>
                <div className="rio-assistant__actions">
                  <Button onPress={() => void compact()} isDisabled={busy || !enabled}>
                    <Trans id="rio.compact">Compact</Trans>
                  </Button>
                  <Button
                    onPress={() => void choose('new')}
                    isDisabled={busy}
                    aria-label={t({ id: 'rio.new', message: 'New conversation' })}
                    icon={faPlus}
                  />
                </div>
              </div>
            ) : null}
            {messages.flatMap((item) =>
              item.blocks.map((block, index) =>
                block.kind === 'attention' ? (
                  <div className="rio-assistant__attention" key={`${item.id}-${index}`}>
                    <Markdown text={block.text} />
                  </div>
                ) : null,
              ),
            )}
            <div className="rio-assistant__quiet" role="status">
              {working ? workingLabels[working] : null}
            </div>
            {error && <p role="alert">{error}</p>}
            {status.data && status.data.tiers.length > 1 && (
              <div className="rio-assistant__actions">
                <Button
                  aria-pressed={effectiveTier === 'everyday'}
                  isDisabled={busy}
                  onPress={() => setTier('everyday')}
                >
                  <Trans id="rio.tier.everyday">Quick</Trans>
                </Button>
                <Button
                  aria-pressed={effectiveTier === 'power'}
                  isDisabled={busy}
                  onPress={() => setTier('power')}
                >
                  <Trans id="rio.tier.power">Thorough</Trans>
                </Button>
              </div>
            )}
          </div>
          <TextArea
            {...anchor('rio.input')}
            aria-label={t({ id: 'rio.placeholder', message: 'Ask Rio anything about your data' })}
            placeholder={t({ id: 'rio.placeholder', message: 'Ask Rio anything about your data' })}
            value={input}
            onChange={setInput}
            isInvalid={input.trim().length > 8000}
            errorMessage={t({
              id: 'rio.message.tooLong',
              message: 'Keep your message to 8,000 characters or fewer.',
            })}
            isDisabled={!enabled || switching}
            onKeyDown={(event) => {
              if (event.nativeEvent.isComposing) return;
              if (event.key === 'Escape') {
                event.preventDefault();
                close();
              } else if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault();
                void send(input);
              }
            }}
          />
          <div className="rio-assistant__actions">
            {busy ? (
              <Button onPress={stop}>
                <Trans id="rio.stop">Stop</Trans>
              </Button>
            ) : (
              <Button
                variant="primary"
                isDisabled={!enabled || !input.trim() || input.trim().length > 8000}
                onPress={() => void send(input)}
                {...anchor('rio.send')}
              >
                <Trans id="rio.send">Send</Trans>
              </Button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
  return (
    <>
      <span ref={trigger} className="rio-assistant__trigger" data-phone={phone}>
        <Button
          variant="quiet"
          size="sm"
          primaryAction
          tooltip
          icon={faWandMagicSparkles}
          aria-label={t({ id: 'rio.open', message: 'AI: Ask Rio' })}
          aria-expanded={open}
          onPress={() => (open ? close() : setOpen(true))}
          {...anchor('rio.open')}
        >
          <span className="rio-assistant__trigger-label">{t({ id: 'rio.ai', message: 'AI' })}</span>
        </Button>
      </span>
      {open &&
        // The destination's dialog owns phone focus while Rio keeps its place for the return.
        (!phone || !modalTarget) &&
        (phone ? (
          <Drawer
            isOpen
            isDismissable={false}
            onOpenChange={(value) => {
              if (!value) close();
            }}
            className="rio-assistant__sheet"
          >
            <Dialog
              hideCloseButton
              aria-label={t({ id: 'rio.title', message: 'Rio' })}
              className="rio-assistant__dialog"
            >
              {panel}
            </Dialog>
          </Drawer>
        ) : (
          <aside
            className="rio-assistant__dock"
            aria-label={t({ id: 'rio.title', message: 'Rio' })}
            data-conversation-id={conversation ?? undefined}
          >
            {panel}
          </aside>
        ))}
    </>
  );
}

function ConversationTime({ date }: { date: string }) {
  return useRelativeTime(date);
}
