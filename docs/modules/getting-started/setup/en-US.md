---
id: setup
title: Setting up a new server
summary: Connect Riosoma to its database and create the owner account.
area: getting-started
order: 1
level: standard
anchors: [setup.database, setup.owner]
related: [connection-check, sign-in]
---

A new Riosoma server asks for two things before anyone can use it: a PostgreSQL database and an owner.

## The setup link

When the server starts for the first time, it writes a setup link to its log.  The link carries a one-time token, so only someone who can read the server's log can finish setup.  Open the link in your browser to begin.  Once the owner account exists, the token stops working.

## Connecting the database

If whoever runs the server already gave it a database, Riosoma skips this step.  Otherwise, enter the server's address, the database name, and how to sign in to it, then choose {{ui:setup.database.test}}.

Riosoma checks the connection one layer at a time and stops at the first problem, so you see exactly what's wrong and how to fix it.  {{doc:connection-check}} explains each check.

After correcting a connection problem, choose {{ui:setup.database.test}} again.  The new check replaces the previous result, including a failed {{ui:setup.database.save}} attempt.  Reloading setup resumes at the database or owner step the server has reached.  Reopening `/setup` after the owner exists takes you into Riosoma.

## Creating the owner

The owner can do everything, including choosing who else manages the server.  Enter your organization's name, your name, your email address, and a password of at least 12 characters, then choose {{ui:setup.owner.submit}}.  You're signed in right away.

## Optional virus scanning

After creating the owner and choosing usage counts, setup offers {{ui:files.scanner.title}}.  Riosoma detects the Compose ClamAV sidecar, a configured host and port, or a local socket approved by the server operator, and tests it with a harmless EICAR signature sent directly from memory.  No test file is uploaded or saved.  Choose {{ui:files.scanner.enable}} to turn scanning on with one click.  New uploads stay in quarantine until they pass a complete scan.

When no scanner is reachable, follow {{ui:files.scanner.installDocs}} to add the sidecar, then detect again.  {{ui:setup.scanner.skip}} finishes setup without enabling scanning.  Return anytime at `/settings/files#virus-scanning`; owners and organization Security administrators can detect, test, and enable or disable scanning there.  {{doc:file-uploads}} explains scanner limits and the option to keep oversized files quarantined, the default.
