import { faPen, faTrashCan } from '@fortawesome/free-solid-svg-icons';
import { personLabel } from '../../../data/people';
import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { useLingui } from '@lingui/react/macro';
import { LIMITS, newId, presenceColor, roleAllows, type RecordComment } from '@riosoma/contracts';
import { Avatar, Banner, Button, ConfirmDialog, ListBox, ListBoxItem, Spinner, TextArea } from '@riosoma/ui';
import { useSchema, type CommandInput, type DatabaseSession } from '../../../data';
import { ApiError } from '../../../api';
import { useServerMessage } from '../../../messages/useServerMessage';
import { useRelativeTime } from '../../../relative-time';
import {
  commentParts,
  findPeople,
  insertMention,
  mentionAt,
  mentionedIds,
  type MentionPerson,
} from './mentions';
import './Comments.css';

/** A stable empty thread, so a panel with nothing in it doesn't redraw around a new array. */
const NO_COMMENTS: readonly RecordComment[] = [];
const NO_PEOPLE: ReadonlyMap<string, MentionPerson> = new Map();

export interface CommentsPanelProps {
  session: DatabaseSession;
  tableId: string;
  recordId: string;
}

/**
 * One record's thread, oldest first, with the composer under it.
 *
 * A comment is a command like any other change, so writing one works offline and survives a
 * reload; it only skips undo, because a conversation isn't a value to put back.  What the person
 * types appears at once as a draft of their own and settles into the thread when the server's
 * change arrives carrying the same ID.
 */
export function CommentsPanel({ session, tableId, recordId }: CommentsPanelProps) {
  const { t, i18n } = useLingui();
  const message = useServerMessage();
  const schema = useSchema(session);
  const requestedField = new URLSearchParams(window.location.search).get('cellField');
  const fieldId =
    requestedField && schema?.fieldById.get(requestedField)?.tableId === tableId ? requestedField : undefined;
  const field = fieldId ? schema?.fieldById.get(fieldId)?.name : undefined;
  const role = schema?.database.role ?? null;
  const people = schema?.collaborators ?? NO_PEOPLE;
  const canComment = roleAllows(role, 'comment');
  const [comments, setComments] = useState<readonly RecordComment[]>(NO_COMMENTS);
  const [drafts, setDrafts] = useState<readonly RecordComment[]>(NO_COMMENTS);
  const [loaded, setLoaded] = useState(false);
  const [loading, setLoading] = useState(false);
  const [failure, setFailure] = useState<string>();
  const request = useRef<
    | {
        controller: AbortController;
        changes: Map<string, RecordComment | null>;
      }
    | undefined
  >(undefined);
  const scope = `${tableId}/${recordId}/${fieldId ?? ''}`;
  const [shown, setShown] = useState(scope);
  if (shown !== scope) {
    // Another record: let go of the last one's thread before drawing any of it.
    setShown(scope);
    setComments(NO_COMMENTS);
    setDrafts(NO_COMMENTS);
    setLoaded(false);
    setFailure(undefined);
  }

  const load = useCallback(() => {
    request.current?.controller.abort();
    const controller = new AbortController();
    const read = { controller, changes: new Map<string, RecordComment | null>() };
    request.current = read;
    void session
      .comments(tableId, recordId, controller.signal)
      .then((page) => {
        if (controller.signal.aborted) return;
        // Realtime edits and deletion tombstones received during this read beat its snapshot.
        const byId = new Map(page.comments.map((comment) => [comment.id, comment]));
        for (const [id, comment] of read.changes) {
          if (comment) byId.set(id, comment);
          else byId.delete(id);
        }
        setComments(merge(NO_COMMENTS, [...byId.values()]));
        setFailure(undefined);
        setLoaded(true);
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        setFailure(error instanceof ApiError ? error.info.messageKey : 'errors.offline');
        setLoaded(true);
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
        if (request.current === read) request.current = undefined;
      });
  }, [session, tableId, recordId]);

  useEffect(() => {
    load();
    // The session holds no comments of its own, so a thread folds in what the server broadcasts.
    const unsubscribe = session.subscribeComments((change) => {
      if (change.kind === 'comment.deleted') {
        if (change.tableId !== tableId || change.recordId !== recordId) return;
        request.current?.changes.set(change.commentId, null);
        setComments((current) => current.filter((item) => item.id !== change.commentId));
        setDrafts((current) => current.filter((item) => item.id !== change.commentId));
        return;
      }
      if (change.kind === 'comment.moved') {
        // A merge brings comments here from the records it merged, and undoing it takes them back.
        if (change.tableId !== tableId) return;
        const left = new Set(
          change.comments.filter((item) => change.from[item.id] === recordId).map((item) => item.id),
        );
        const arrived = change.comments.filter((item) => item.recordId === recordId);
        for (const id of left) request.current?.changes.set(id, null);
        for (const comment of arrived) request.current?.changes.set(comment.id, comment);
        if (left.size) setComments((current) => current.filter((item) => !left.has(item.id)));
        if (arrived.length) setComments((current) => merge(current, arrived));
        return;
      }
      const comment = change.comment;
      if (comment.tableId !== tableId || comment.recordId !== recordId) return;
      request.current?.changes.set(comment.id, comment);
      setComments((current) => merge(current, [comment]));
      if (change.kind === 'comment.created')
        setDrafts((current) => current.filter((item) => item.id !== comment.id));
    });
    return () => {
      request.current?.controller.abort();
      unsubscribe();
    };
  }, [session, tableId, recordId, fieldId, load]);

  /** The server's copy wins over a local draft, and a rejected command is fetched back. */
  const thread = useMemo(
    () =>
      merge(drafts, comments).filter(
        (comment) =>
          (!fieldId || comment.fieldId === fieldId) &&
          (!comment.fieldId || schema?.fieldById.get(comment.fieldId)?.tableId === tableId),
      ),
    [drafts, comments, fieldId, schema, tableId],
  );
  const draftIds = useMemo(() => new Set(drafts.map((item) => item.id)), [drafts]);

  function drop(id: string): void {
    setDrafts((current) => current.filter((item) => item.id !== id));
    load();
  }

  /** Runs one comment command; a rejection is already reported, so the thread just catches up. */
  function dispatch(command: CommandInput): void {
    try {
      void session.run([command]).done.then(({ rejected }) => {
        if (rejected) load();
      });
    } catch {
      load();
    }
  }

  function create(body: string): void {
    const text = body.trim();
    if (!text) return;
    const id = newId('comment');
    const draft: RecordComment = {
      id,
      tableId,
      recordId,
      ...(fieldId ? { fieldId } : {}),
      authorId: session.userId,
      body: text,
      mentions: mentionedIds(text, people.keys()),
      createdAt: new Date().toISOString(),
      editedAt: null,
    };
    setDrafts((current) => [...current, draft]);
    try {
      void session
        .run([
          {
            kind: 'comment.create',
            tableId,
            recordId,
            comment: { id, body: text, ...(fieldId ? { fieldId } : {}) },
          },
        ])
        .done.then(({ rejected }) => {
          if (rejected) drop(id);
        });
    } catch {
      drop(id);
    }
  }

  function save(commentId: string, body: string): void {
    const text = body.trim();
    if (!text) return;
    setComments((current) =>
      current.map((item) =>
        item.id === commentId
          ? {
              ...item,
              body: text,
              mentions: mentionedIds(text, people.keys()),
              editedAt: new Date().toISOString(),
            }
          : item,
      ),
    );
    dispatch({ kind: 'comment.update', commentId, body: text });
  }

  function remove(commentId: string): void {
    setComments((current) => current.filter((item) => item.id !== commentId));
    setDrafts((current) => current.filter((item) => item.id !== commentId));
    dispatch({ kind: 'comment.delete', commentId });
  }

  const unknown = t({ id: 'comments.unknownPerson', message: 'Someone' });
  return (
    <div className="rio-comments">
      {field && <p>{t({ id: 'comments.cell.open', message: `Comments on ${field}` })}</p>}
      {failure && (
        <Banner tone="danger">
          {message(failure)}
          <Button
            size="sm"
            isPending={loading}
            onPress={() => {
              setLoading(true);
              load();
            }}
          >
            {t({ id: 'files.retry', message: 'Try again' })}
          </Button>
        </Banner>
      )}
      {thread.length === 0 ? (
        // A read that failed says so; it doesn't claim the thread is empty.
        failure ? null : loaded ? (
          <p className="rio-comments__empty">{t({ id: 'comments.empty', message: 'No comments yet.' })}</p>
        ) : (
          <Spinner size="sm" className="rio-comments__loading" />
        )
      ) : (
        <ol className="rio-comments__thread">
          {thread.map((comment) => {
            const pending = draftIds.has(comment.id);
            const mine = comment.authorId !== null && comment.authorId === session.userId;
            return (
              <CommentItem
                key={comment.id}
                comment={comment}
                field={comment.fieldId ? schema?.fieldById.get(comment.fieldId)?.name : undefined}
                pending={pending}
                author={personName(comment.authorId, people) ?? unknown}
                names={people}
                canEdit={canComment && mine && !pending}
                canDelete={canComment && (mine || role === 'owner') && !pending}
                onSave={(body) => save(comment.id, body)}
                onDelete={() => remove(comment.id)}
              />
            );
          })}
        </ol>
      )}
      {canComment && (
        <Composer
          key={scope}
          people={[...people.values()]}
          locale={i18n.locale}
          unknown={unknown}
          onSend={create}
        />
      )}
    </div>
  );
}

/** One thread, oldest first, with each comment's latest copy by ID. */
function merge(current: readonly RecordComment[], incoming: readonly RecordComment[]): RecordComment[] {
  const byId = new Map(current.map((comment) => [comment.id, comment]));
  for (const comment of incoming) byId.set(comment.id, comment);
  // Stored times are ISO 8601, so comparing them as text compares them as moments.
  return [...byId.values()].sort((one, other) =>
    one.createdAt === other.createdAt ? 0 : one.createdAt < other.createdAt ? -1 : 1,
  );
}

function personName(id: string | null, people: ReadonlyMap<string, MentionPerson>): string | null {
  if (id === null) return null;
  const name = personLabel(people.get(id));
  return name ? name : null;
}

interface CommentItemProps {
  comment: RecordComment;
  field?: string;
  author: string;
  pending: boolean;
  canEdit: boolean;
  canDelete: boolean;
  names: ReadonlyMap<string, MentionPerson>;
  onSave: (body: string) => void;
  onDelete: () => void;
}

function CommentItem({
  comment,
  field,
  author,
  pending,
  canEdit,
  canDelete,
  names,
  onSave,
  onDelete,
}: CommentItemProps) {
  const { t } = useLingui();
  const time = useRelativeTime(comment.editedAt ?? comment.createdAt);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(comment.body);
  const [confirming, setConfirming] = useState(false);
  // Access returning later must not reopen an old editor or deletion prompt.
  if (editing && !canEdit) {
    setEditing(false);
    setDraft(comment.body);
  }
  if (confirming && !canDelete) setConfirming(false);
  const unknown = t({ id: 'comments.unknownPerson', message: 'Someone' });
  const editLabel = t({ id: 'comments.edit', message: 'Edit' });

  function cancel(): void {
    setEditing(false);
    setDraft(comment.body);
  }
  function save(): void {
    const body = draft.trim();
    if (!body) return;
    setEditing(false);
    onSave(body);
  }
  return (
    <li className="rio-comments__item" data-pending={pending || undefined}>
      <Avatar
        personId={comment.authorId ?? undefined}
        name={author}
        color={comment.authorId ? presenceColor(comment.authorId) : 'gray'}
        size="sm"
      />
      <div className="rio-comments__body">
        <div className="rio-comments__meta">
          <span className="rio-comments__author">{author}</span>
          <time className="rio-comments__time" dateTime={comment.editedAt ?? comment.createdAt}>
            {time}
          </time>
          {comment.editedAt && (
            <span className="rio-comments__edited">{t({ id: 'comments.edited', message: 'edited' })}</span>
          )}
        </div>
        {field && <span className="rio-comments__edited">{field}</span>}
        {editing && canEdit ? (
          <div className="rio-comments__edit">
            <TextArea
              aria-label={editLabel}
              rows={3}
              autoFocus
              maxLength={LIMITS.commentLength}
              value={draft}
              onChange={setDraft}
              onKeyDown={(event) => {
                if (event.nativeEvent.isComposing) return event.continuePropagation();
                if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
                  event.preventDefault();
                  save();
                } else if (event.key === 'Escape') {
                  // Canceling an edit keeps the card open; a second Escape closes it.
                  event.preventDefault();
                  cancel();
                } else event.continuePropagation();
              }}
            />
            <div className="rio-comments__edit-actions">
              <Button size="sm" onPress={cancel}>
                {t({ id: 'comments.cancel', message: 'Cancel' })}
              </Button>
              <Button size="sm" variant="primary" isDisabled={!draft.trim()} onPress={save}>
                {t({ id: 'comments.save', message: 'Save' })}
              </Button>
            </div>
          </div>
        ) : (
          <p className="rio-comments__text">
            {commentParts(comment.body).map((part, index) =>
              'text' in part ? (
                <span key={index}>{part.text}</span>
              ) : (
                <span key={index} className="rio-comments__mention">
                  @{personLabel(names.get(part.mentionId), part.writtenName.trim() || unknown)}
                </span>
              ),
            )}
          </p>
        )}
        {(canEdit || canDelete) && (
          <div className="rio-comments__actions">
            {canEdit && (
              <Button
                icon={faPen}
                aria-label={editLabel}
                variant="quiet"
                size="sm"
                onPress={() => {
                  setDraft(comment.body);
                  setEditing(true);
                }}
              />
            )}
            {canDelete && (
              <Button
                variant="quiet"
                size="sm"
                onPress={() => setConfirming(true)}
                aria-label={t({ id: 'comments.delete', message: 'Delete' })}
                icon={faTrashCan}
              />
            )}
          </div>
        )}
      </div>
      <ConfirmDialog
        isOpen={confirming && canDelete}
        onOpenChange={setConfirming}
        tone="danger"
        title={t({ id: 'comments.delete.title', message: 'Delete this comment?' })}
        message={t({ id: 'comments.delete.body', message: 'It’s removed for everyone.' })}
        confirmLabel={t({ id: 'comments.delete', message: 'Delete' })}
        onConfirm={onDelete}
      />
    </li>
  );
}

interface ComposerProps {
  people: readonly MentionPerson[];
  locale: string;
  unknown: string;
  onSend: (body: string) => void;
}

function Composer({ people, locale, unknown, onSend }: ComposerProps) {
  const { t } = useLingui();
  const [text, setText] = useState('');
  const [caret, setCaret] = useState(0);
  const [chosen, setChosen] = useState(0);
  const [dismissed, setDismissed] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const restore = useRef<number | null>(null);
  const offersId = useId();
  const placeholder = t({
    id: 'comments.placeholder',
    message: 'Add a comment.  Type @ to mention someone.',
  });

  // Writing a mention replaces the text under the caret, so the caret goes back where it belongs.
  useEffect(() => {
    const element = root.current?.querySelector('textarea');
    const position = restore.current;
    if (!element || position === null) return;
    restore.current = null;
    element.selectionStart = position;
    element.selectionEnd = position;
  }, [text]);

  function readCaret(): void {
    const element = root.current?.querySelector('textarea');
    if (element) setCaret(element.selectionStart ?? element.value.length);
  }
  const draft = dismissed ? null : mentionAt(text, caret);
  const offers = draft ? findPeople(people, draft.query, locale) : [];
  const active = offers.length ? Math.min(chosen, offers.length - 1) : 0;

  function mention(person: MentionPerson): void {
    if (!draft) return;
    const next = insertMention(text, draft, person);
    restore.current = next.caret;
    setText(next.text);
    setCaret(next.caret);
    setChosen(0);
    setDismissed(false);
    root.current?.querySelector('textarea')?.focus();
  }
  function send(): void {
    const body = text.trim();
    if (!body) return;
    onSend(body);
    restore.current = null;
    setText('');
    setCaret(0);
    setChosen(0);
    setDismissed(false);
  }
  return (
    <div
      className="rio-comments__composer"
      onBlur={(event) => {
        const next = event.relatedTarget;
        // Leaving for the offers keeps them open; leaving the composer puts them away.
        if (next instanceof Node && root.current?.contains(next)) return;
        setDismissed(true);
      }}
    >
      <div className="rio-comments__field" ref={root}>
        {offers.length > 0 && (
          <div
            className="rio-comments__offers"
            // Choosing with the pointer must not take focus away from the text.
            onMouseDown={(event) => event.preventDefault()}
          >
            <ListBox
              id={offersId}
              aria-label={t({ id: 'comments.mention.label', message: 'People to mention' })}
              selectionMode="none"
              onAction={(key) => {
                const person = offers.find((item) => item.id === key);
                if (person) mention(person);
              }}
            >
              {/* Written out rather than from `items`, so the offer the arrow keys reached is
                  marked again each time they move. */}
              {offers.map((person) => (
                <ListBoxItem
                  key={person.id}
                  id={person.id}
                  textValue={person.name}
                  data-active={offers[active]?.id === person.id || undefined}
                >
                  <span className="rio-comments__person">
                    {/* The name beside it says who this is; the initials would only repeat it. */}
                    <Avatar
                      personId={person.id}
                      name={person.name}
                      color={presenceColor(person.id)}
                      size="sm"
                      aria-hidden="true"
                    />
                    <span className="rio-comments__person-name">{personLabel(person, unknown)}</span>
                  </span>
                </ListBoxItem>
              ))}
            </ListBox>
          </div>
        )}
        <TextArea
          aria-label={placeholder}
          placeholder={placeholder}
          rows={3}
          maxLength={LIMITS.commentLength}
          aria-controls={offers.length ? offersId : undefined}
          value={text}
          onChange={(value) => {
            setText(value);
            setDismissed(false);
            setChosen(0);
            readCaret();
          }}
          onKeyUp={readCaret}
          onKeyDown={(event) => {
            if (event.nativeEvent.isComposing) return event.continuePropagation();
            if (offers.length && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
              event.preventDefault();
              setChosen(
                event.key === 'ArrowDown' ? Math.min(active + 1, offers.length - 1) : Math.max(active - 1, 0),
              );
              return;
            }
            if (offers.length && event.key === 'Enter' && !event.metaKey && !event.ctrlKey) {
              event.preventDefault();
              const person = offers[active];
              if (person) mention(person);
              return;
            }
            if (offers.length && event.key === 'Escape') {
              // Putting the offers away keeps the card open; the text stays as it is.
              event.preventDefault();
              setDismissed(true);
              return;
            }
            if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
              event.preventDefault();
              send();
              return;
            }
            event.continuePropagation();
          }}
        />
      </div>
      <div className="rio-comments__send">
        <Button variant="primary" size="sm" isDisabled={!text.trim()} onPress={send}>
          {t({ id: 'comments.send', message: 'Send' })}
        </Button>
      </div>
    </div>
  );
}
