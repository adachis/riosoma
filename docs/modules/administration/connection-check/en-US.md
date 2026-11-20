---
id: connection-check
title: Fixing a database connection
summary: What each step of the connection check means and how to fix it.
area: administration
order: 0
level: advanced
anchors: [setup.database]
related: [setup]
---

Riosoma checks a database connection in order, one layer at a time, and stops at the first problem.

## The steps

**Name lookup.**  Riosoma looks up the server's address.  If this fails, check the host name for typos, or use the server's IP address.

**SSH tunnel.**  Only when you connect through an SSH server.  A host key mismatch means the SSH server isn't the one you pinned: confirm its key with whoever runs it before you change anything.

**Network.**  Riosoma opens a connection to the database port.  Refused means nothing is listening there.  Unreachable or timed out usually means a firewall is in the way.

**Encryption.**  Riosoma negotiates TLS the way you chose.  An untrusted certificate needs its certificate authority added.  A name mismatch means the certificate belongs to a different host name, which you can set in the TLS settings.

**Sign-in.**  Riosoma signs in with the account you gave.  For cloud identity sign-in, the server itself must be allowed to request tokens.

**Database.**  The database you named must exist.

**Permissions.**  Riosoma needs to create its own schemas, or have them created ahead of time with permission to add tables.

**Extensions.**  Optional.  With pg_trgm, searching is faster, and with vector, meaning-based search becomes available.  Riosoma works without either.

**Version.**  PostgreSQL 14 or later.

**Speed.**  Riosoma measures how long a round trip takes.  Over 50 milliseconds works, but everything feels slower, so keep the database close to the server when you can.
