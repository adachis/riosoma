import { Trans, useLingui } from '@lingui/react/macro';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { ROUTINE_LIMITS, type RoutineApproval } from '@riosoma/contracts';
import { Button, Checkbox, TextArea, TextField } from '@riosoma/ui';
import { ApiError } from '../../api';
import { useServerMessage } from '../../messages/useServerMessage';
import { ErrorBanner } from '../../shell/ErrorBanner';
import { errorInfo } from '../../screens/setup/useSetup';
import { approve, change, refreshRoutines, skip } from './api';
import { ChangeSummary } from './ChangeSummary';
import { UndoChanges } from './UndoChanges';
import { useRoutineWords } from './words';

const ADDRESS = /^[^\s@,;<>"]+@[^\s@,;<>"]+\.[^\s@,;<>"]+$/;
/** Answers after which the approval reads differently, so it's read again */
const REFRESHED = new Set(['routines.approval.stale', 'routines.approval.nothingLeft']);

/**
 * Something a routine's run left for its owner: a plan of changes, an email to someone else, or
 * new sites it met in the fields its plan reads sites from.  The owner approves it, changes it, or
 * skips it.  Changing an email edits it in place before it goes, and changing a plan asks Rio to
 * prepare it again with a note.  Sites are read or skipped, and skipped ones aren't asked about again.
 */
export function ApprovalCard({ approval }: { approval: RoutineApproval }) {
  const { t } = useLingui();
  const words = useRoutineWords();
  const message = useServerMessage();
  const client = useQueryClient();
  const [changing, setChanging] = useState(false);
  const [always, setAlways] = useState(false);
  const [note, setNote] = useState('');
  const [to, setTo] = useState(approval.email?.to.join(', ') ?? '');
  const [subject, setSubject] = useState(approval.email?.subject ?? '');
  const [body, setBody] = useState(approval.email?.body ?? '');
  const act = useMutation({
    mutationFn: async (action: 'approve' | 'skip' | 'change' | 'send') => {
      if (action === 'skip') return skip(approval.id);
      if (action === 'change') return change(approval.id, note.trim());
      if (action === 'send')
        return approve(approval.id, {
          always,
          email: {
            to: to
              .split(/[\s,;]+/)
              .map((entry) => entry.trim())
              .filter(Boolean),
            subject: subject.trim(),
            body: body.trim(),
          },
        });
      // A plan is approved as the revision shown here, which the server checks is still the one.
      return approve(approval.id, approval.kind === 'email' ? { always } : { revision: approval.revision });
    },
    onSuccess: async () => {
      setChanging(false);
      await refreshRoutines(client);
    },
    // A plan that changed since it was shown comes back as it is now, to be read again, and one
    // with nothing left to do comes back closed.
    onError: async (error) => {
      if (error instanceof ApiError && REFRESHED.has(error.info.messageKey)) await refreshRoutines(client);
    },
  });
  const pending = approval.status === 'pending';
  const busy = act.isPending;
  const addresses = to
    .split(/[\s,;]+/)
    .map((entry) => entry.trim())
    .filter(Boolean);
  const badTo = !addresses.length || addresses.some((entry) => !ADDRESS.test(entry));
  const recipients = approval.email ? words.list(approval.email.to) : '';
  return (
    <article className="rio-routines__approval" data-status={approval.status}>
      <p className="rio-routines__approval-head">
        <strong>
          {approval.kind === 'email'
            ? t({ id: 'routines.approval.email', message: 'An email' })
            : approval.kind === 'hosts'
              ? t({ id: 'routines.approval.hosts', message: 'Read these new sites?' })
              : t({ id: 'routines.approval.plan', message: 'Changes' })}
        </strong>{' '}
        <span className="rio-routines__badge">{words.approvalStates[approval.status]}</span>
      </p>
      {approval.kind === 'hosts' ? (
        <>
          <ul className="rio-routines__sites">
            {approval.sites.map((site) => (
              <li key={site}>{site}</li>
            ))}
          </ul>
          <p className="rio-routines__note">
            {t({
              id: 'routines.approval.hosts.help',
              message:
                'A run found these in the fields it reads sites from.  Approving lets it read the home page of each one, and nothing else on them.  Skipping means it won’t ask about them again.',
            })}
          </p>
        </>
      ) : approval.email ? (
        <dl className="rio-routines__facts">
          <div>
            <dt>
              <Trans id="routines.approval.to">To</Trans>
            </dt>
            <dd>{recipients}</dd>
          </div>
          <div>
            <dt>
              <Trans id="routines.approval.subject">Subject</Trans>
            </dt>
            <dd>{approval.email.subject}</dd>
          </div>
          <div>
            <dt>
              <Trans id="routines.approval.body">Message</Trans>
            </dt>
            <dd className="rio-routines__body">{approval.email.body}</dd>
          </div>
        </dl>
      ) : (
        <>
          {approval.changes ? (
            <ChangeSummary changes={approval.changes} />
          ) : (
            <p role="alert">
              {t({
                id: 'routines.approval.unknownChanges',
                message: 'What these changes do couldn’t be worked out, so skip them or ask Rio again.',
              })}
            </p>
          )}
          <div className="rio-routines__words">
            <p className="rio-routines__note">
              {t({ id: 'routines.approval.rioSays', message: 'Rio’s description, in its own words:' })}
            </p>
            <p>{approval.summary}</p>
            <ol>
              {approval.steps.map((step, index) => (
                <li key={index}>{step}</li>
              ))}
            </ol>
          </div>
        </>
      )}
      {approval.messageKey ? <p role="alert">{message(approval.messageKey)}</p> : null}
      {approval.receipt ? (
        <UndoChanges databaseId={approval.receipt.databaseId} groupId={approval.receipt.groupId} />
      ) : null}
      {pending && changing ? (
        approval.kind === 'email' ? (
          <div className="rio-routines__fields">
            <TextField
              label={t({ id: 'routines.approval.edit.to', message: 'To' })}
              value={to}
              onChange={setTo}
              isDisabled={busy}
              isInvalid={badTo}
              validationBehavior="aria"
              errorMessage={t({
                id: 'routines.approval.edit.to.invalid',
                message: 'List email addresses, separated by commas.',
              })}
            />
            <TextField
              label={t({ id: 'routines.approval.edit.subject', message: 'Subject' })}
              value={subject}
              onChange={setSubject}
              maxLength={ROUTINE_LIMITS.subjectLength}
              isDisabled={busy}
            />
            <TextArea
              label={t({ id: 'routines.approval.edit.body', message: 'Message' })}
              value={body}
              onChange={setBody}
              maxLength={ROUTINE_LIMITS.bodyLength}
              isDisabled={busy}
            />
            <Checkbox isSelected={always} isDisabled={busy} onChange={setAlways}>
              {t({
                id: 'routines.approval.always',
                message: 'Send to exactly these people without asking me each time',
              })}
            </Checkbox>
            <div className="rio-routines__actions">
              <Button
                variant="primary"
                isPending={busy}
                isDisabled={badTo || !subject.trim() || !body.trim()}
                onPress={() => act.mutate('send')}
              >
                {t({ id: 'routines.approval.sendChanged', message: 'Send it' })}
              </Button>
              <Button isDisabled={busy} onPress={() => setChanging(false)}>
                {t({ id: 'routines.approval.cancelChange', message: 'Cancel' })}
              </Button>
            </div>
          </div>
        ) : (
          <div className="rio-routines__fields">
            <TextArea
              label={t({ id: 'routines.approval.note', message: 'What should Rio do differently?' })}
              value={note}
              onChange={setNote}
              maxLength={ROUTINE_LIMITS.noteLength}
              isDisabled={busy}
            />
            <div className="rio-routines__actions">
              <Button
                variant="primary"
                isPending={busy}
                isDisabled={!note.trim()}
                onPress={() => act.mutate('change')}
              >
                {t({ id: 'routines.approval.askAgain', message: 'Ask Rio to prepare it again' })}
              </Button>
              <Button isDisabled={busy} onPress={() => setChanging(false)}>
                {t({ id: 'routines.approval.cancelChange', message: 'Cancel' })}
              </Button>
            </div>
          </div>
        )
      ) : pending ? (
        <div className="rio-routines__actions">
          {approval.kind === 'email' ? (
            <Checkbox isSelected={always} isDisabled={busy} onChange={setAlways}>
              {t({
                id: 'routines.approval.always',
                message: 'Send to exactly these people without asking me each time',
              })}
            </Checkbox>
          ) : null}
          <Button
            variant="primary"
            isPending={busy}
            isDisabled={approval.kind === 'plan' && !approval.changes}
            onPress={() => act.mutate('approve')}
          >
            {approval.kind === 'email'
              ? t({ id: 'routines.approval.approveEmail', message: 'Approve and send' })
              : approval.kind === 'hosts'
                ? t({ id: 'routines.approval.approveSites', message: 'Read them' })
                : t({ id: 'routines.approval.approvePlan', message: 'Approve changes' })}
          </Button>
          {approval.kind === 'hosts' ? null : (
            <Button isDisabled={busy} onPress={() => setChanging(true)}>
              {t({ id: 'routines.approval.change', message: 'Change' })}
            </Button>
          )}
          <Button isDisabled={busy} onPress={() => act.mutate('skip')}>
            {t({ id: 'routines.approval.skip', message: 'Skip' })}
          </Button>
        </div>
      ) : null}
      <ErrorBanner error={errorInfo(act.error)} />
    </article>
  );
}
