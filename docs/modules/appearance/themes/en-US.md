---
id: themes
title: Choosing a theme
summary: Pick one of 52 themes and a color scheme to go with it.
area: appearance
order: 0
level: simple
anchors: [settings.appearance.theme, settings.appearance.scheme, database.menu, database.menu.theme, database.theme.picker, settings.appearance]
related: [language, forms, public-view-links, booking-pages]
routes: [/settings/appearance, /settings/appearance/appearance, /settings/*/appearance, /admin/*/appearance]
sections: [settings.appearance=changing-yours]
---

A theme sets Riosoma's colors, fonts, and corners.  There are 52 of them, and each has several color schemes, from calm paper tones to neon.

## Changing yours

Open {{ui:shell.nav.settings}}, then {{ui:settings.nav.appearance}}.  Choose a {{ui:settings.appearance.theme}} and a {{ui:settings.appearance.scheme}}.  The change applies at once and follows you to every device where you sign in.

## Who decides

Preview your choices here, then choose {{ui:settings.draft.save}} in the save bar at the bottom of the page.  {{ui:settings.draft.discard}} restores your stored theme.  Your theme is yours alone.  Until you pick one, you see your organization's default, which starts as Nature.  An administrator can change the default or limit which themes people can choose.

## A database's own theme

A database's owner can give it a theme of its own, so everyone who opens it sees the same colors.  Open {{ui:webhooks.menu}} in the database's header and choose {{ui:databaseTheme.menu}}.  Pick a {{ui:databaseTheme.theme}}, then its {{ui:themes.picker.scheme}}.  The change saves at once and shows for everyone who has the database open.  Choose {{ui:databaseTheme.ownTheme}} to let each person see their own theme again.

The database shows in its theme only while it's open.  Leaving it brings your own theme back.  Your own choice never changes, and the database's theme is never remembered as yours.

Only the owner can set it, and only from the themes their organization allows.  If the list changes later and leaves the database's theme out, people see their own theme there instead, and a short note says why.  The database keeps its choice, so it shows again if the list grows back.  Duplicates, snapshots, and templates keep the database's theme too.

The dialog has its own address ending in `?settings=theme`, so a link can open it directly.  It works with the keyboard and with screen readers, and on a phone the two choices stack.

## Public pages

A public form, a view's public link, and a booking page can each pick a {{ui:publicTheme.label}} in their share or publish settings.  Its theme wins over the database's on the public page.  Choose {{ui:publicTheme.inherit}} to follow the database: its own theme if it has one, and the default if it doesn't.  Published sites pick their theme when you publish them.

Public pages keep to the themes allowed for whoever shared them.  When neither the page's theme nor the database's is allowed anymore, or neither has a theme, the page shows in the organization's allowed default and configured color scheme.  If no default is configured, it uses the first allowed theme and that theme's default scheme.

## Opening records

The {{ui:record.layout}} choice in {{ui:settings.nav.appearance}} sets how expanded records open.  Choose {{ui:record.layout.card}} for a centered card or {{ui:record.layout.panel}} to keep the grid beside the record.  You can also change this choice with {{ui:record.layout}} in an open record's header.  Your choice follows you to every device.

In the side panel, click a grid cell or use the Up and Down arrow keys in the grid to show another record.  Drag the panel's edge to resize it, or focus {{ui:record.resize}} and use the Left and Right arrow keys.  Escape closes the panel and returns focus to the grid or the dashboard link that opened the record.  On a phone, the panel fills the screen.  Use {{ui:record.previous}} and {{ui:record.next}} to move between records there.

Choose {{ui:record.openWindow}} in any record header to open its full page in a new tab.  The page keeps the database's navigation and has its own shareable link.  Editing, attachments, linked records, comments, and history work the same in every layout, with the same permissions and locks.
