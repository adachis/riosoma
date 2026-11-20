import { useLayoutEffect, useRef, useState } from 'react';
import { useLingui } from '@lingui/react/macro';
import { AppError, type InterfaceCode } from '@riosoma/contracts';
import { Button, Dialog, DialogBody, DialogFooter, DialogTitle, Modal } from '@riosoma/ui';
import { ApiError } from '../../../api';
import { serverMessage } from '../../../messages/useServerMessage';
import { applyCodeChange, codeRequest, isCodeCall, type CodeChange } from './code-bridge';
import type { BlockContext } from './context';

interface Proposal {
  request: CodeChange;
  resolve(value: unknown): void;
  reject(reason: unknown): void;
}

export function CodeBody(props: {
  code: InterfaceCode;
  name: string;
  context: BlockContext;
  preview?: boolean;
}) {
  const { i18n } = useLingui();
  const { html, css, javascript } = props.code;
  // A new document and bridge discard pending replies whenever the source or language changes.
  return <CodeFrame key={JSON.stringify([i18n.locale, html, css, javascript])} {...props} />;
}

function CodeFrame({
  code,
  name,
  context,
  preview = false,
}: {
  code: InterfaceCode;
  name: string;
  context: BlockContext;
  preview?: boolean;
}) {
  const { t, i18n } = useLingui();
  const iframe = useRef<HTMLIFrameElement>(null);
  const current = useRef({ context, preview });
  useLayoutEffect(() => {
    current.current = { context, preview };
  }, [context, preview]);
  const [proposal, setProposal] = useState<Proposal | null>(null);
  const pending = useRef<Proposal | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { html, css, javascript } = code;
  // Listen before the frame can finish loading and announce that it is ready.
  useLayoutEffect(() => {
    const channel = crypto.randomUUID();
    let closed = false;
    let initialized = false;
    let lastId = 0;
    let active = 0;
    const receive = (event: MessageEvent) => {
      const source = iframe.current?.contentWindow ?? null;
      if (!source || event.source !== source || event.origin !== 'null') return;
      if (!initialized && event.data?.type === 'interface-code-ready') {
        initialized = true;
        // An opaque origin requires '*', and this checked frame receives only its code and locale.
        // nosemgrep: javascript.browser.security.wildcard-postmessage-configuration.wildcard-postmessage-configuration
        source.postMessage(
          { type: 'interface-code-init', channel, code: { html, css, javascript }, locale: i18n.locale },
          '*',
        );
        return;
      }
      if (!initialized || !isCodeCall(event, source, channel)) return;
      const { id, request } = event.data as { id: number; request: unknown };
      if (id <= lastId) return;
      lastId = id;
      const answer = (value: unknown, failure?: string) => {
        if (!closed)
          // An opaque origin requires '*', and this checked frame receives only its authorized result.
          // nosemgrep: javascript.browser.security.wildcard-postmessage-configuration.wildcard-postmessage-configuration
          source.postMessage({ type: 'interface-code-result', channel, id, value, error: failure }, '*');
      };
      if (active >= 16) {
        answer(null, 'interfaces.code.busy');
        return;
      }
      active += 1;
      void codeRequest(
        current.current.context,
        request,
        (change) =>
          new Promise((resolve, reject) => {
            if (closed || pending.current) return reject(new AppError('conflict', 'interfaces.code.busy'));
            const next = { request: change, resolve, reject };
            pending.current = next;
            setError(null);
            setProposal(next);
          }),
        current.current.preview,
      )
        .then(
          (value) => answer(value),
          (reason: unknown) =>
            answer(
              null,
              reason instanceof AppError
                ? reason.messageKey
                : reason instanceof ApiError
                  ? reason.info.messageKey
                  : 'errors.internal',
            ),
        )
        .finally(() => {
          active -= 1;
        });
    };
    window.addEventListener('message', receive);
    return () => {
      closed = true;
      window.removeEventListener('message', receive);
      pending.current?.reject(new AppError('forbidden', 'errors.forbidden'));
      pending.current = null;
    };
  }, [html, css, javascript, i18n.locale]);
  const dismiss = () => {
    if (saving) return;
    pending.current?.reject(new AppError('forbidden', 'errors.forbidden'));
    pending.current = null;
    setProposal(null);
  };
  return (
    <>
      <iframe
        ref={iframe}
        className="rio-interface-code"
        title={name}
        sandbox="allow-scripts"
        referrerPolicy="no-referrer"
        src="/api/interfaces/code-frame"
      />
      {proposal ? (
        <Modal
          isOpen
          onOpenChange={(open) => {
            if (!open) dismiss();
          }}
          size="lg"
        >
          <Dialog>
            <DialogTitle>
              {t({ id: 'interfaces.code.proposal', message: 'Review record change' })}
            </DialogTitle>
            <DialogBody>
              <p>
                {t({
                  id: 'interfaces.code.proposalHelp',
                  message: `${name} proposes this change.  Apply it with your record permissions.`,
                })}
              </p>
              <p>{proposal.request.recordId}</p>
              <dl>
                {Object.entries(proposal.request.values).map(([id, value]) => (
                  <div key={id}>
                    <dt>{context.schema.fieldById.get(id)?.name ?? id}</dt>
                    <dd>
                      <pre className="rio-interface-code-value">{JSON.stringify(value, null, 2)}</pre>
                    </dd>
                  </div>
                ))}
              </dl>
              {error ? <p role="alert">{serverMessage(i18n, error)}</p> : null}
            </DialogBody>
            <DialogFooter>
              <Button isDisabled={saving} onPress={dismiss}>
                {t({ id: 'interfaces.code.dismiss', message: 'Dismiss' })}
              </Button>
              <Button
                variant="primary"
                isDisabled={saving}
                onPress={() => {
                  setSaving(true);
                  void applyCodeChange(current.current.context, proposal.request)
                    .then(() => {
                      proposal.resolve(null);
                      pending.current = null;
                      setProposal(null);
                    })
                    .catch((reason: unknown) => {
                      setError(reason instanceof AppError ? reason.messageKey : 'errors.internal');
                    })
                    .finally(() => setSaving(false));
                }}
              >
                {t({ id: 'interfaces.code.apply', message: 'Apply record change' })}
              </Button>
            </DialogFooter>
          </Dialog>
        </Modal>
      ) : null}
    </>
  );
}
