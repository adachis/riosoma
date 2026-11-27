import type { BrowserContext } from './accessibility';

export interface PolicyReport {
  directive: string;
  violatedDirective: string;
  disposition: SecurityPolicyViolationEventDisposition;
  documentURL: string;
  target: string;
  blocked: string;
  source: string;
  line: number;
  sample: string;
}

// WebKit bug 327752: WebKit's HTMLSelectElement::didAddUserAgentShadowRoot() writes an inline
// style on its internal button slot before attaching the slot to the shadow root, so creating
// any <select> raises a `style-src-attr` report the app did not cause.  WebKit commit 5949381
// fixes this behavior, which is tracked in microsoft/playwright#43416.  The canary in
// trusted-types.spec.ts fails when WebKit stops reporting the browser's own attribute, and then
// every exception built on isSelectReport must be removed.
const SELECT_CREATED = 'select-created';

export function isSelectReport(report: PolicyReport): boolean {
  return (
    report.directive === 'style-src-attr' &&
    report.violatedDirective === 'style-src-attr' &&
    report.disposition === 'enforce' &&
    report.blocked === 'inline' &&
    report.sample === ''
  );
}

export function selectConsoleError(url: string) {
  return {
    text: "Refused to apply a stylesheet because its hash, its nonce, or 'unsafe-inline' does not appear in the style-src directive of the Content Security Policy.",
    url,
    line: 0,
    column: 0,
  };
}

export async function policyViolations(
  context: BrowserContext,
  countSelects = false,
): Promise<{ violations: PolicyReport[]; selects: () => number }> {
  const violations: PolicyReport[] = [];
  let selects = 0;
  // One binding carries both kinds of message.  The main test checks them only after the screens settle.
  await context.exposeBinding('recordPolicyViolation', (_source, detail: string) => {
    if (detail === SELECT_CREATED) selects += 1;
    else violations.push(JSON.parse(detail) as PolicyReport);
  });
  await context.addInitScript(
    ({ count, selectCreated }) => {
      const record = (detail: string) => void Reflect.get(window, 'recordPolicyViolation')(detail);
      document.addEventListener('securitypolicyviolation', (event) => {
        record(
          JSON.stringify({
            directive: event.effectiveDirective,
            violatedDirective: event.violatedDirective,
            disposition: event.disposition,
            documentURL: location.href,
            target: event.target instanceof Node ? event.target.nodeName : '',
            blocked: event.blockedURI,
            source: event.sourceFile,
            line: event.lineNumber,
            sample: event.sample,
          }),
        );
      });
      if (!count) return;
      // Count each <select> once, when it joins the document.  Watching insertion rather than wrapping
      // createElement keeps the app's own code as the source of WebKit's report.  A select the app never
      // inserts goes uncounted, so its report still fails the test.
      const seen = new WeakSet<Element>();
      new MutationObserver((mutations) => {
        for (const mutation of mutations) {
          for (const node of mutation.addedNodes) {
            if (!(node instanceof Element)) continue;
            const selects = [...(node.matches('select') ? [node] : []), ...node.querySelectorAll('select')];
            for (const select of selects) {
              if (seen.has(select)) continue;
              seen.add(select);
              record(selectCreated);
            }
          }
        }
      }).observe(document, { childList: true, subtree: true });
    },
    { count: countSelects, selectCreated: SELECT_CREATED },
  );
  return { violations, selects: () => selects };
}
