# Rio correctness evals

The suite creates synthetic databases on a disposable PostgreSQL cluster. Table creation,
formula repair, and automation drafting are graded through permission-scoped reads of saved
state. Before approval, schema and data audit counts must remain unchanged. Approved changes
use the existing plan endpoint and command bus; automation drafts must remain disabled.

Run the deterministic suite without credentials:

```sh
pnpm --filter @riosoma/server exec vitest run src/ai/evals --maxWorkers=3
```

For a nightly job, build the server dependencies first, supply the normal runtime provider
credentials through the job's secret store, and run:

```sh
RIOSOMA_RIO_EVAL_LIVE=1 RIOSOMA_RIO_EVAL_BUDGET_USD=0.25 pnpm --filter @riosoma/server exec vitest run src/ai/evals --maxWorkers=3
```

Live mode selects the cheapest configured everyday tool-capable registry entry with known
nonnegative pricing, at least 32,000 context tokens, and capacity for 4,096 output tokens.
Selection compares 16,000 input tokens and 4,096 output tokens across candidates. The run fails
when no eligible entry is available. Each call reserves its worst-case cost before sending; reported usage
releases unused reservations, and interrupted calls retain theirs. The cap covers the entire
suite, including all task rounds, and each call has a 60-second deadline. The default is $0.25.
An exhausted cap fails the eval instead of selecting a different billing route.

The injection corpus tests role impersonation, forged approval results, and encoded orders
through records, comments, history, library descriptions, knowledge passages, web results, remote tool results, and routine inputs.
It deliberately scripts a provider that obeys each injected instruction, so the server must
hold the resulting proposals and refuse unexpected tools and memory writes. External
transports are test doubles; remote approval logic and routine workers remain real. Knowledge
and web retrieval doubles avoid embedding and search charges. Live task grading and
deterministic injection enforcement are separate checks in the same nightly invocation.

Comment and history reads, as well as library descriptions supplied with tool definitions,
persist the conversation's untrusted-data flag through the existing command bus.  Later turns
reload that flag before provider execution.  Follow-up cases echo injected text into a saved
reply and verify that proposals still await approval, including after a library is removed.

The browser spec checks the existing plan review at desktop and phone widths, keyboard
activation, accessible preview controls, and the preview deep link. It verifies that only
the person's Apply action changes saved data.  Database creation extends plan and context metadata
through the same screen and endpoints, without a migration.

Home creation tasks cover a project tracker, a book club reading list, and a simple CRM.
They grade tables, typed fields, choices, internal links, views, and computed samples through
saved-state reads after approval.  Server tests compare the complete preview definitions and
sample values with saved state, check inherited folder access and permission revocation,
exercise sample omission and dismissal, and undo the complete database in one action.

The scripted browser creation journey runs in all three engines with the theme assets installed:

```sh
rsync -a ~/Developer/riosoma-theme-assets/ themes/
RIOSOMA_E2E_ALL_BROWSERS=1 pnpm --filter @riosoma/e2e exec playwright test tests/r-create-database.spec.ts
```
