---
id: install-app
title: Installing Riosoma as an app
summary: Add Riosoma to your computer or phone so it opens in its own window.
area: getting-started
order: 3
level: simple
related: [welcome]
---

Riosoma works in any modern browser, and you can also install it like an app.  It then opens in its own window, has its own icon, and starts faster.

## On a computer

In Chrome or Edge, choose the install button at the end of the address bar.  In Safari on a Mac, choose File, then Add to Dock.

## On a phone or tablet

On an iPhone or iPad, open Riosoma in Safari, choose the share button, then Add to Home Screen.  On Android, open the browser menu and choose Install app.

## Updates

When Riosoma confirms that a new version is ready for your open page, it offers {{ui:app.update.action}}.  Your open page keeps running until you choose it.  A page already running the current version shows no update notice.  If a screen can no longer load after an update, Riosoma keeps queued edits on this device and reloads that page once to recover.  Offline failures show the recovery message.  If you are offline, or the screen still cannot load, check your connection and choose {{ui:app.load.reload}}.

Leaving a page pauses recovery for interrupted loads.  If you stay on the page after canceling navigation, or return with your browser's Back control, recovery resumes when the page is available again.

Hovering or focusing a control can discover an update and offer {{ui:app.update.action}} without interrupting your work.  If an unopened panel cannot load while you are offline, it shows {{ui:app.load.reload}} in that panel, and the rest of your screen stays available.  If startup files are missing, the same recovery message remains available even before the app starts.

If an action cannot load its code while you are offline, Riosoma shows {{ui:app.load.part.title}} and keeps your current screen available.  Check your connection and try the action again.  A recovery dialog keeps keyboard focus inside it, and closing it returns focus to the control you used.  If a part runs into another problem, it shows {{ui:app.load.problem.title}} with {{ui:app.load.reload}}.

Downloading help as a PDF uses the same recovery when a deployment removes its files.  If the download cannot start while you are offline, the notice offers {{ui:app.load.reload}} and leaves your help page available.  Closing a failed dialog leaves other dialogs available, including ones you opened earlier.

When more than one dialog fails to load, the most recent recovery dialog stays available to your keyboard and screen reader.  Choose {{ui:ui.dialog.close}} or press Escape to return to the earlier dialog.  Your page becomes available again after every recovery dialog closes.

If the app does not start within ten seconds, Riosoma shows {{ui:app.load.title}} with {{ui:app.load.reload}}.  If a slow startup finishes afterward, the app replaces that message.
