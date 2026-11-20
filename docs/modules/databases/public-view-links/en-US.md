---
id: public-view-links
title: Sharing a view by public link
summary: Let anyone with a link read a grid, gallery, kanban, calendar, list, map, timeline, gantt, pivot, or chart, choose the fields it shows, add a password, and embed it on a site.
area: databases
order: 30
level: standard
related: [views, forms, downloading, attachments]
anchors: [view.menu, view.share, shareView.help, shareView.publish, shareView.theme, shareView.dialog, settings.public.sharing]
demo: public-view-links
routes: [/settings/public-sharing, /settings/*/public-sharing, /admin/*/public-sharing]
sections: [shareView.dialog=making-a-link, settings.public.sharing=making-a-link]
---

A public link puts one view on the web for people who don't have a Riosoma account, such as clients following a project or a neighborhood reading a schedule.  They open an address and read the view, and reading is all they can do.  The dialog that makes the link says it plainly: "{{ui:shareView.help}}"  Nothing else in the database is reachable through it, and nobody can add, change, or delete anything with it.

{{ui:view.type.grid}}, {{ui:view.type.gallery}}, {{ui:view.type.kanban}}, {{ui:view.type.calendar}}, {{ui:views.list.name}}, {{ui:views.map.name}}, {{ui:views.timeline.name}}, {{ui:views.gantt.name}}, {{ui:views.pivot.name}}, and {{ui:views.chart.name}} views can be shared.  A shared list always includes the field it groups or nests by, and a shared map its place field.  A form has its own public link for taking answers, described in {{doc:forms}}.

## Making a link

Open the view's menu, beside its name in the row of views, and choose {{ui:shareView.menu}}.  Only people who can change the database's views see this, so it takes the {{ui:share.role.creator}} or {{ui:share.role.owner}} role.

Turn on {{ui:shareView.publish}} and Riosoma makes the link at once.  It's an address on your own server with 22 random characters in it, which nobody can guess by trying addresses, and it keeps working until someone stops sharing it.  {{ui:shareView.copyLink}} copies it from the {{ui:shareView.link}} box, and the panel says "{{ui:shareView.copiedLink}}"  Send it however you like.

Where field or record permissions apply, or the table links to another database, the link reads as the person who shared the view: it shows the records and linked records they can see, and none they can't.  Anyone else who can change the database's views can change the link too, unless there are fields or records they can't see themselves.  The link could show them those, so for them the dialog says "{{ui:data.access.linkLimited}}" and offers only {{ui:shareView.stop}}, and changing the view's filter, order, fields, or layout is refused with "{{ui:data.access.publicLimited}}"  What the link's fields hold is kept the same way.  Adding a field to the table while the link shares every field the view shows, restoring a field from the trash, changing a field's type or options, choosing another primary field, or changing a named function is refused with "{{ui:data.access.publicFieldLimited}}" whenever the link shows the field, shows something worked out from it, or filters, sorts, or groups by either.  They can still rename the view and its fields and move a field to the trash, and the person who shared the view, or anyone who sees everything in the database, can make the change for them.  {{doc:field-and-record-permissions}} describes the permissions.

## What someone sees

The page shows the view's name, the view itself, and a box marked {{ui:shareView.search}} that looks through the shared fields, ignoring capital letters.  Choosing a record opens it with the shared fields and nothing else.  At the foot of the page is "{{ui:shareView.poweredBy}}"

The page is read only, and it leaves out the parts of Riosoma that belong to the people who work in it:

- No comments and no history, so nobody sees who wrote what or when.
- People appear as names only, and linked records as names only, with nothing to open behind either.
- No buttons to add a record, filter, sort, or change the view in any way.

The view's filter and order still apply, including a condition on a field the link doesn't share, so what's on the page is what the view shows.  If a condition can no longer apply, because its field was deleted, was changed into a type the condition doesn't fit, or is one the person who shared the view can't see, the page says "{{ui:shareView.unavailable}}" rather than showing records the view was leaving out.  It works again once the filter is fixed, the field comes back, or the person who shared the view can see the field.  A view that filters by a field read from another database, for example, stops when the person who shared it has no access to that database.  The page isn't live.  It reads again every five minutes and when someone comes back to it, so a change you make shows up within a few minutes rather than at once.

Whether the visitor is signed in or not makes no difference.  Everyone with the link reads the same thing.

The page shows in the database's theme, if it has one.  To give the link a look of its own, pick a {{ui:publicTheme.label}} and its {{ui:themes.picker.scheme}} in {{ui:shareView.title}}.  {{ui:publicTheme.inherit}} follows the database again.  A page with a password shows in its theme even before the password, since how it looks gives nothing away.

## Choosing the fields

{{ui:shareView.fields}} decides what leaves the server:

- {{ui:shareView.fieldsAll}} shares every field the view shows.  "{{ui:shareView.fieldsAllHelp}}"  A field you hide from the view later stops being shared at once, and one you show starts being shared.
- {{ui:shareView.fieldsSome}} shares only the ones you check under {{ui:shareView.fieldsPicked}}, so a view can show your team everything and the link only part of it.  It starts with everything the view shows, so you take off what shouldn't go out.  A field the view stops showing stops being shared even if it's still checked.

Some fields a view can't be read without are shared whatever you pick, and each is marked "{{ui:shareView.fieldRequired}}"  They are the primary field, a kanban's stack field and cover image, a gallery's cover image, a calendar's dates, a timeline's dates and groups, a gantt view's dates and dependencies, and the grouping and value fields used by charts and pivots.  When one of them is hidden in the view, the dialog names it, so you can see that it goes out.

Only the shared fields are ever sent.  The rest of the table stays on the server, so unchecking a field here is enough to keep it private.

## Copying and downloading

Turn on {{ui:shareView.allowCopy}} to let people copy cells and take the view away as a file.  The page then has a {{ui:shareView.download}} button, which saves the shared fields of the records the view shows, as {{doc:downloading}} describes.  Leave it off and text on the page can't even be selected, so nothing can be lifted from it by hand.

## A password

Turn on {{ui:shareView.passwordOn}} and type one under {{ui:shareView.password}}, then choose {{ui:shareView.passwordSave}}.  It has to be at least 6 characters.  Once one is set the field reads {{ui:shareView.passwordNew}} and the button {{ui:shareView.passwordChange}}, since "{{ui:shareView.passwordSet}}"

Someone opening the link then sees "{{ui:shareView.locked.title}}" and "{{ui:shareView.locked.help}}"  They type it under {{ui:shareView.locked.password}} and choose {{ui:shareView.locked.open}}.  That browser remembers it for eight hours, for this link alone, so they aren't asked again straight away.  A wrong one reads "{{ui:shareView.passwordWrong}}", and after ten tries from the same address Riosoma says "{{ui:shareView.tooManyTries}}"  A whole IPv6 network counts as one address.  A link also takes only 100 wrong passwords in fifteen minutes from everywhere together, and then says the same to everyone who tries until the fifteen minutes are up.  The right password never counts toward that, and a browser that already gave it keeps reading.

A password is a locked door rather than a wall.  It keeps out someone who stumbles on the link, and it's worth setting whenever the view holds anything you wouldn't pin to a bulletin board, but the stronger protection is sharing fewer fields.

Two things can get in the way of a browser remembering the password, and the page says which: "{{ui:shareView.locked.cookies}}" when the browser refuses cookies, and "{{ui:shareView.locked.framed}}" when the page sits inside another site's page, where {{ui:shareView.locked.openTab}} opens it on its own instead.

Turning {{ui:shareView.passwordOn}} off takes the password away and forgets it on every device at once, so the link opens without one again.

## Putting the view on another site

Turn on {{ui:shareView.embedOn}} and the page can sit in a frame on another site, such as a page about your project or your neighborhood's calendar.  List the sites under {{ui:shareView.sites}}, one to a line, and choose {{ui:shareView.sitesSave}}.  "{{ui:shareView.sitesHelp}}"  List up to 20 exact origins, including the scheme and any nondefault port.  Paths, queries, credentials, and wildcard hosts are rejected.  An empty list permits framing only on this site.  {{ui:shareView.embedCode}} is the snippet to paste into the other site, and {{ui:shareView.copyEmbed}} copies it.

With embedding off, only this site may put the page in a frame.  An administrator can disable all external embedding at /settings/public-sharing using {{ui:publicSharing.allowEmbedding}}.  The link still works when it's opened on its own.

An upgrade turns embedding off for a link whose rule named a whole subdomain with a star, or named no sites at all and so meant any site, because neither lists exact origins.  Nothing else about the link changes, and each one is written to the audit log as `publicSharing.embedReset` with the sites it held, so an administrator can see what stopped and list the exact origins again.

## Files in a shared view

An attachment field that's shared shows its files on the page, with a small picture for an image, and each one opens in a new tab.  Files stay private by default.  An organization administrator can enable {{ui:publicSharing.allowFiles}} at /settings/public-sharing.  Public files then travel under signed addresses that name one file and expire after one hour by default.  {{ui:publicSharing.lifetime}} allows 60 to 604800 seconds.  The addresses the page is using stay fresh as it reads again, and one that has stopped working opens again after the page is loaded afresh.

A file is only reachable while its record is still in the view and its field is still shared.  Hiding the field, filtering the record out, changing the password, disabling public files, or stopping the link takes the file back at once.  Quarantined files are never served.

## Turning a link off

Choose {{ui:shareView.stop}}, or turn off {{ui:shareView.publish}}, and Riosoma asks "{{ui:shareView.stopTitle}}"  "{{ui:shareView.stopBody}}"  The page then says "{{ui:shareView.unavailable}}" and "{{ui:shareView.unavailableHelp}}" to anyone who opens the old address.

A link also stops working when its view, its table, or its database goes to the trash, so deleting a shared view doesn't leave its link behind.

## Too many requests

Public pages are counted by the address they come from, so one busy site can't crowd out the rest of the server.  A page that runs into the limit says "{{ui:shareView.rateLimited}}" and works again a minute later.  The limit is 600 requests a minute, and an administrator can change it.
