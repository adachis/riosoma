---
id: offline
title: Working through a dropped connection
summary: Keep editing when the network drops, and your changes save when it returns.
area: databases
order: 6
level: simple
related: [together, undo]
---

Beside the database's name, Riosoma shows whether your changes are saved: "{{ui:database.save.saving}}", then "{{ui:database.save.saved}}".

If the connection drops, it shows "{{ui:database.save.offline}}", and you can keep editing the records already on your screen.  Your changes wait in the browser, even if you close the tab, and are sent in order as soon as you're back online.  For record values without text conflict resolution, the change that reaches the server last wins.

Text fields preserve both drafts when overlapping changes need a choice.  Review the conflict after reconnecting, then choose {{ui:textEdit.keepMine}}, {{ui:textEdit.useTheirs}}, or {{ui:textEdit.saveCombined}}.

An installed app keeps its shell and the theme files it has already loaded available during a dropped connection.  Reloading offline shows the connection recovery screen.  It does not load database records without the server.  Your queued edits stay in this browser.  Once the connection returns, choose {{ui:boot.error.retry}} to open the same address and resend them.

When {{ui:app.update.title}} appears, keep working until you are ready to choose {{ui:app.update.action}}.  A waiting update does not reload your open page on its own.
