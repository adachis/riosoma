---
id: public-demo-mode
title: Public demo mode
summary: Let visitors explore a read-only instance without creating an account.
area: administration
order: 30
level: advanced
related: [people-roles-and-lifecycle]
---

Public demo mode signs visitors in as one ordinary member.  Visitors see what that member can read through ordinary sharing.  Use a dedicated member and share only the databases and records you want to publish.

## Turning it on

Create an ordinary member, then set these operator settings and restart the server:

```
RIOSOMA_DEMO_MODE=on
RIOSOMA_DEMO_ACCOUNT=demo@example.com
RIOSOMA_DEMO_LINK=https://riosoma.com
```

Demo mode is off by default.  The account must exist, be active, and have no organization or unit administration roles.  An owner or guest cannot serve as the demo account.  An invalid account refuses startup.  A later promotion or deactivation refuses further demo access.  The optional link appears as {{ui:demo.about}} in the banner.

Real sign-in remains at `/sign-in` on the application address.  Opening that page clears both demo cookie names, including after moving from HTTP to HTTPS, and the operator can sign in normally with a password, passkey, sign-in link, or single sign-on.  A published custom domain can have its own `/sign-in` page, which keeps the demo restrictions.  Password recovery and second-step verification remain available on the application address.  Real sessions keep their ordinary access.

The dedicated demo member cannot use real sign-in, password recovery, invitation tokens, personal tokens, or OAuth tokens while demo mode is on, including requests without a demo cookie.  Those requests are refused before authentication bookkeeping, including single sign-on assertion records.  Startup disables the member's existing SQL logins and ends their open connections.  Use a separate account for the operator.  Existing operator OAuth connections can exchange authorization codes and refresh tokens while demo mode is on, even when the browser also has a demo cookie.

## What visitors can do

Visitors can open shared tables, dashboards, interfaces, and records.  Controls remain visible.  Attempts to change anything are refused, and the banner and calm toast explain that changes are not saved.  Theme, color scheme, level, and layout choices apply only in that visitor's browser.

Map views show records and places as a list through {{ui:views.map.list.title}}.  Demo visitors do not receive a map style or fetch external tiles, fonts, or sprites.  Their browser policy permits only local destinations, even when the operator enables external maps, file downloads, or connected services for real sessions.

Administration, settings, connection details, notification inboxes, people directories, API access, SQL access, and presence are unavailable.  Demo reads do not record recents.  Configuration responses show only reviewed display fields.  Source settings and diagnostics, recipients, contact details, executable inputs, drafts, and unrecognized settings stay private.  Names and descriptions of shared objects, form labels, and published page text remain visible.  Published websites remain readable on the instance address and custom domains, under their existing publishing access rules.  Commands, public submissions, provider calls, and outbound requests are refused, including downloads from remote file storage.  The assistant searches built-in help topics and shows matching passages and links.  It does not use AI or send records to a model.

Published site forms work on a verified custom domain while demo mode is on, and any demo cookie sent to that domain is ignored.  Forms on the instance's own address under `/sites/:slug/` remain read-only, so give a site its own domain when you want forms beside a demo.

The HTTPS proxy must authenticate the site's TLS authority as described in [custom domain proxy setup]({{doc:custom-domains}}).  Missing authority proof or a domain that loses verification, expires its daily check, is removed, or stops hosting sites refuses the submission, including one already waiting to be recorded.

Paid forms, signature requests, bookings, and response editing remain refused for demo visitors.  A plain site submission is non-demo activity, so its table's automations, notifications, and confirmation emails follow their existing rules, including configured delivery after the submission commits.

## Capacity and expiration

Internal TLS certificate authorization remains available while demo mode is on.  The reverse proxy must still supply the configured certificate authorization token from an allowed socket address, and the domain must be active and verified.  These checks do not use demo sessions or visitor request limits.

Each visit expires after two hours.  `RIOSOMA_DEMO_ADDRESS_LIMIT` defaults to 10 active visits per network address, and `RIOSOMA_DEMO_SESSION_LIMIT` defaults to 1000 active visits for the instance.  IPv6 addresses share their /64.  The database counts capacity across server processes.  Demo requests share the per-address request limits used for published sites.  Visitors who reach a limit are asked to try again later.

Expired demo cookies do not automatically allocate another visit.  Start a new browser visit after capacity is available.  Configure trusted proxies correctly so limits use visitor addresses.
