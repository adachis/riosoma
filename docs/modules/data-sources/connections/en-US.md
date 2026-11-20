---
id: connections
title: Teradata, Db2, and Informix sources
summary: Connect systems that need an admin-installed driver.
area: data-sources
order: 16
level: advanced
anchors: [sources]
related: [drivers]
---

Add these connections through {{ui:settings.nav.sources}} → {{ui:sources.add}}.  First install their driver under {{ui:sources.drivers.title}}.  {{ui:sources.test}} reports a missing driver before attempting a network connection.

## Teradata

Choose {{ui:sources.kind.teradata}}.  Enter the host, port, user, password, and optional database.  TLS verifies the certificate and host name by default.  The TLS port defaults to 443.  A non-TLS connection needs the database’s native port, usually 1025.  Choose TD2 or LDAP for the sign-in method.  A private certificate authority can be supplied as PEM text.

Tables and views come from the database catalog, with catalog row estimates and unique key candidates.  Big integers and exact decimals travel as text before the driver can round them.  Queries are contained inside one SELECT.  Use a login with only read privileges.

## Db2

Choose {{ui:sources.kind.db2}} and enter the database, host, port, user, and password.  This connector targets Db2 for Linux, UNIX, and Windows.  Other editions can require separate Db2 Connect entitlements.  The native port defaults to 50000.  Use the server’s configured TLS port when encryption is enabled.

The connector reads tables, views, estimates, and primary or unique constraints from SYSCAT.  Connections and cursors are read-only.  Use a login with only read privileges.  IBM’s client needs an x86-64 Linux server, or a Mac with Apple silicon.  It can’t send a password, user, or database name that contains a semicolon, so choose a password without one.

## Informix

Choose {{ui:sources.kind.informix}} and enter the database, host, user, password, and DRDA port, usually 9089.  The SQLI port, usually 9088, cannot be used by this client.  Configure DRDA and use its TLS port for encrypted connections.

The connector reads tables and views from the system catalog, keeps composite unique keys in column order, and uses read-only transactions.  The database must support transaction logging.  A table’s BOOLEAN columns become checkboxes, and in a query, where only their values arrive, they read as 1 and 0.  IBM’s driver has the same installation and platform requirements as Db2, and the same rule about semicolons.
