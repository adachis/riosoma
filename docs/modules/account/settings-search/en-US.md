---
id: settings-search
title: Finding and sharing settings
summary: Search settings in your language, open them from the keyboard, and share a link to one setting.
area: account
order: 8
level: simple
related: [palette, notifications, passkeys-and-two-step-sign-in]
---

At the top of Settings, use {{ui:settings.search.label}} to find a label, a keyword, or words in a setting’s help.  Results use your current language and are grouped by section.  You see only settings your roles allow you to open, including settings your experience level normally hides.

Use the arrow keys to choose a result and Enter to open it.  Escape clears the search.  You can also click a result.  The setting scrolls into view, receives keyboard focus, and is highlighted briefly.  When your device requests reduced motion, scrolling is immediate.

Settings keep their space while stored values load.  Opening a shared link waits for its controls to become available before moving keyboard focus, including {{ui:mfa.nav.policy}}.

You can find the same settings in the command palette.  Press {{keys:palette.open}} and type a setting’s name or help text.

Change settings locally, then choose {{ui:settings.draft.save}} in the bottom bar to store them.  {{ui:settings.draft.discard}} restores the stored values and clears errors for discarded edits.  If you edit a field while a save is pending, that newer edit stays unsaved until you save it separately.  This includes returning a field to its original value while its section waits for another section to finish saving.

Leaving with unsaved changes opens an in-app dialog.  Choose {{ui:settings.draft.keep}}, {{ui:settings.draft.discardContinue}}, or {{ui:settings.draft.saveContinue}}.  If stored settings change elsewhere while you edit, use {{ui:settings.draft.reload}} to load them before saving.

In {{ui:settings.nav.integrations}}, a saved {{ui:integrations.clientSecret}} becomes blank because stored secrets are never shown.  A {{ui:integrations.clientId}} or replacement secret typed during that save remains unsaved and can be saved next.  Open `/admin/connections/integrations/client-id` to return to these settings.

Opening a result gives you an address you can bookmark or share.  Personal settings use `/settings/<section>/<page>/<setting>`, such as `/settings/preferences/appearance/theme`.  Admin settings use `/admin/<section>/<page>/<setting>`, such as `/admin/security/files/max-upload-bytes`.  Existing `/settings/<page>` addresses still work.  Language entries stay out of settings search when your build offers only English.

Anyone opening a shared link needs the roles required by that setting.  If part of a link is invalid or unavailable to you, Riosoma removes that part and shows a notice while opening the closest available settings page.

When you open {{ui:governance.legalHold}} without a database in the address, use {{ui:governance.legalHoldDatabase}} to choose an available database.  The address keeps the setting and adds your database choice, so reloading or sharing it opens the same legal hold.

Open {{ui:shell.personalMenu}} at the end of the top bar for your name, email address, {{ui:shell.nav.settings}}, {{ui:settings.nav.appearance}}, {{ui:shortcuts.title}}, {{ui:shell.help}}, and {{ui:shell.signOut}}.  The menu stays available inside a database and on a phone.  Administration remains in Settings.

On narrow screens, {{ui:shell.moreControls}} holds update notices and monthly usage.  Personal actions remain at the end of the top bar.

Choose {{ui:settings.nav.appearance}} in that menu to switch your theme or color scheme immediately.  A database with a fixed theme keeps showing its own theme and explains that your choice applies when you leave it.  These quick changes save through your personal preferences and do not need the Settings save bar.

When you open Settings from a database, {{ui:shell.settings.close}} returns to that database, including its open view or record.  Browser Back also returns to the previous screen.  The return address stays in the Settings link while you move between sections.
