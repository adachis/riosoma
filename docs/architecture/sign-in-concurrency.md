# Sign-in concurrency

Password and passkey sign-in acquire their email and IP attempt locks together in sorted order,
before checking or updating credentials.  Passkey sign-in resolves the credential owner without
a row lock first, then checks the credential again under the attempt locks.  Unknown credentials
still count against the IP limit.  Passkey sign-in keeps its existing IP-only lockout rule.

SSO holds the issuer/subject lock before finding the account.  For a new identity with a verified
email, linking and provisioning also hold a separate lock on the normalized email before the
member lookup.  Different subjects sharing an email therefore see the committed account and
membership.  The email lock spans organizations because account emails are globally unique.
Linking still requires membership in the provider's organization, permission to link by email,
and the existing managed-account domain checks.  Unverified claims never reach the member lookup.

Session creation locks the user with `FOR NO KEY UPDATE`, then writes the session, conversation,
and active conversation.  This serializes sessions for one person while allowing identity links'
foreign-key checks.  Audit inserts hold the existing organization hash-chain lock until commit.

Password, passkey, magic-link redemption, and SSO account/session transactions retry only
PostgreSQL deadlocks (`40P01`) and serialization failures (`40001`).  There are at most three
attempts, with jittered backoffs of 10–19 ms and 20–39 ms after rollback and connection release.
The retry covers database work whose effects roll back together: credential counters, consumed
tokens, provisioning, sessions, and audit entries.  Provider exchanges, email delivery, cookies,
and HTTP responses stay outside it.  Other errors and exhausted retries keep the original failure.

The server regression enables `log_lock_waits` and a 100 ms `deadlock_timeout` on its test database.
Gates force password/passkey overlap and distinct-subject SSO provisioning for the same email.
Late aborts verify that retries commit one session and one sign-in event, consume credentials once,
and exchange an SSO code once.  Mixed rounds check shared accounts and organization members,
session uniqueness, attempt resets, audit-chain integrity, active conversations, and expirations.

```sh
RIOSOMA_SIGN_IN_STRESS_RUNS=50 pnpm --filter @riosoma/server test src/auth/concurrent-sign-in.test.ts --maxWorkers=1 --reporter=verbose
```

The browser check runs three waves of six independent contexts through sign-in and the fixture's
preference update.  It requires loaded theme fonts.  Fixture navigation uses document identity
to detect replacement documents even when Firefox rounds navigation timestamps.  A separate
repeated-timestamp regression checks that readiness mechanism in every browser engine.

```sh
RIOSOMA_E2E_ALL_BROWSERS=1 pnpm --filter @riosoma/e2e exec playwright test tests/m-sign-in-stability.spec.ts
```
