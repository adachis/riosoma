---
id: sql
title: Querying a database with SQL
summary: Run read-only SQL with your normal permissions, or connect an outside reporting tool through an administrator-managed login.
area: databases
order: 33
level: advanced
related: [field-and-record-permissions, views]
---

Open {{ui:sql.title}} in the database sidebar.  An administrator chooses which database roles can use it.  Your normal field and record permissions apply to every query, including joins, formulas, links, and aggregates.  SQL access can reveal roughly how many records a table holds through query timing, so administrators should give it only to roles that may know that.

External SQL views are removed as soon as access changes, including changes to folders, the databases in folders, and group membership.  Queries may briefly fail while the views rebuild with the person's current access.

A classification label that stops export or sharing outside the organization leaves its fields out of the catalog and out of external views, and a table none of whose fields may leave has no view at all, as [Classifying your data](/settings/classification) explains.  Changing a label rebuilds the views, so a short interruption follows it too.

## Writing and running a query

Start with a SELECT and use the quoted names under {{ui:sql.catalog}}.  Type part of a name to see suggestions, then choose one or press Control+Enter to insert the first suggestion.  Duplicate or reserved names use a stable ID, which the catalog shows.  Live-source tables are not listed because their local copies can be incomplete.

Choose {{ui:sql.run}} to run one query or {{ui:sql.cancel}} to stop it.  WITH queries, joins, subqueries, aggregates, and window functions are available.  Writes, locking, system tables, schema-qualified names, and functions outside the read-only allowlist are refused with a reason.  You can have one query running at a time and start up to 30 a minute.  When the server is already running as many SQL queries as it allows, try again when one finishes.

Restricted fields behave like unknown columns, and so does any name that isn't a column of a table or subquery in the query.  Locked fields can still be read.  A link value contains the visible record IDs and the number of hidden records, without revealing the hidden records' identities.  Date-only fields come back as dates such as `2026-01-05`, as the grid shows them.  A change log field comes back empty, and so does a lookup or rollup of one, because record history stays in the app.

## Results and history

The read-only grid shows 100 rows per page, and the time a query took is rounded to the nearest 100 ms.  The default limit is 10,000 rows and 15 seconds per query.  An administrator can change those limits.  When a query reaches the row limit, narrow it with a filter.

Use {{ui:export.csv}} or {{ui:export.xlsx}} to download the returned result.  Downloads keep the same row limit and recheck your permissions.  {{ui:sql.history}} lists your 50 most recent queries.  Choose one to put it back in the editor.  Every run is recorded in the organization's audit log, including its query text, row count, and duration.

## Connecting an outside tool

Logins for outside tools are off unless whoever runs the server has turned them on with the `RIOSOMA_SQL_OUTSIDE_LOGINS` setting.  Until then {{ui:sql.settings}} says so, and enabling a login is refused.  The login connects to the PostgreSQL database that every organization on the server shares.  It reads records only through its own views, but PostgreSQL also lets it see the names of the tables and fields in every database that has a login, roughly how many records each table holds, and the IDs of the databases and organizations that are changing, as they change.  Give a login only to people and tools who may know that.

An organization owner or security administrator opens {{ui:sql.settings}}, chooses a person under {{ui:sql.person}}, and selects {{ui:sql.login.enable}}.  Everyone who uses that PostgreSQL login reads as the chosen person.  You can choose someone other than yourself only when no field or record rule limits your own access to the database, so nobody gets a login that reads more than they do.  If the chosen person's access later grows past yours, either of you is deleted, or the database is moved to the trash, Riosoma turns the login off and records that in the audit log.  A database restored from the trash has no login until you enable one again.  Save the password when it appears, and use the displayed login and view schema with the PostgreSQL connection details supplied by your administrator.

When Riosoma cannot create PostgreSQL roles, it shows SQL for a database administrator to run.  After it is run, choose {{ui:sql.login.check}}.  Access stays closed until the check passes.  The login also stays closed while any PostgreSQL role in the database can take advisory locks, create temporary tables or large objects, or read the text of views, until its own role has a limit on temporary files, and until Riosoma is able to end the login's connections.  Riosoma changes those itself when its application account is a PostgreSQL superuser.  Otherwise the SQL on screen does, and a superuser must run it.  A PostgreSQL server that allows prepared transactions keeps every login closed, and the status says so.  In the same way, {{ui:sql.settings}} can show SQL that adds a role for the SQL editor's queries to run as, which can read only what those queries need.  Queries work without it, and it adds protection.

On PostgreSQL 14, every role can create objects in the `public` schema through the default PUBLIC grant.  During SQL setup, Riosoma removes that CREATE grant when its application account is allowed to, adopting the default for new databases on PostgreSQL 15 and newer.  Schema USAGE and explicit grants to other roles stay in place.  Databases upgraded from 14 can need the same change.  If the application account cannot remove the grant, the status explains why setup is not ready, and the administrator SQL includes `REVOKE CREATE ON SCHEMA public FROM PUBLIC;` with an explanation.  Have a PostgreSQL administrator run it, then choose {{ui:sql.login.check}}.  Give other applications that need schema creation an explicit grant through their own roles.

Changes to fields, rules, and roles close the old views before they are rebuilt.  A short interruption is normal after a permission change.  {{ui:sql.login.rotate}} replaces the password, and {{ui:sql.login.disable}} closes access and removes the login and views.  Both end the login's open connections, and so does {{ui:sql.login.check}} on a login that was closed.  If the application account lacks privileges, an administrator finishes either action with the SQL shown on screen.

Riosoma also ends a login's connection when a query runs past the query timeout, when it sits idle inside a transaction for that long, or when it holds up a change someone is making, such as adding a field to a table the connection read.  Set the outside tool to autocommit, so each query is its own transaction, and let it reconnect.
