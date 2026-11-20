---
id: interfaces
title: Building interfaces for your records
summary: Make pages of lists, record details, numbers, charts, text, filters, and buttons so people can work with records without the tables.
area: databases
order: 27
level: simple
related: [dashboards, views, forms, editing, trash-and-favorites]
anchors: [interfaces.section, interfaces.add, interface.designer]
demo: interfaces
sections: [interface.designer=editing-a-page]
routes: [/*/interfaces/*]
---

An interface is a set of pages you build from blocks, so people can find, read, and change records without working in the tables themselves.  A page might list open requests, show the details of the one someone picks, count what's overdue, and offer a button that opens a form for a new request.

## Adding an interface

Interfaces are listed under {{ui:interfaces.section}} in a database's sidebar.  Choose {{ui:interfaces.add}} to make one.  It starts with one empty page, named "{{ui:interfaces.page.first}}", and the interface is named "{{ui:interfaces.untitled}}".  Its menu in the sidebar has {{ui:database.sidebar.rename}} and {{ui:interfaces.delete}}.  Drag interfaces into the order you like, or hold Alt and press Up or Down.

People with the {{ui:share.role.creator}} or {{ui:share.role.owner}} role build interfaces.  Everyone else who can open the database uses them as they are.

## Editing a page

Choose {{ui:interfaces.edit}} to change the interface, and {{ui:interfaces.done}} when you're finished.  While you edit:

- {{ui:interfaces.editor.add}} puts a new block on the page.  Pick its {{ui:dashboards.tile.kind}}, give it a {{ui:dashboards.tile.title}} if you like, set it up, and choose {{ui:interfaces.editor.save}}.
- Each block's menu has {{ui:interfaces.block.edit}}, {{ui:interfaces.block.duplicate}}, and {{ui:interfaces.block.delete}}.
- Drag a block to move it, or drag its bottom corner to resize it.  Blocks in the way move down to make room, and Escape cancels a drag.
- With the keyboard, press Tab to reach a block's move and resize control.  The arrow keys move the block, and Shift with the arrow keys resizes it.  The block's menu also offers {{ui:sortable.menu.up}}, {{ui:sortable.menu.down}}, and {{ui:sortable.menu.to}}.

Blocks sit on a grid 12 columns wide.  On a phone they stack in one column, in reading order.  While {{ui:interfaces.edit}} is active, press and hold a block, then drag it into a gap to put it between its neighbors, or above or below the list to put it first or last.  A short swipe scrolls.  Its Up and Down arrow keys move it through the stack.

Pages appear as tabs above the blocks.  While you edit, {{ui:interfaces.page.add}} adds one, and each tab's menu has {{ui:database.sidebar.rename}}, {{ui:interfaces.page.duplicate}}, and {{ui:interfaces.page.delete}}.  Hold Alt and press Left or Right to move a tab.  An interface holds up to 20 pages, and a page up to 50 blocks.

Changes save as you make them and apply for everyone.  Cmd+Z (Ctrl+Z on Windows and Linux) undoes them, as described in {{doc:undo}}.

## Kinds of blocks

- {{ui:interfaces.block.records}} lists the records of one {{ui:dashboards.tile.table}}, in the order of the {{ui:dashboards.tile.view}} you choose and narrowed by its filter.  Add conditions under {{ui:view.toolbar.filter}} to narrow it further.  Choose up to 20 {{ui:interfaces.records.fields}}, and show the records as a {{ui:interfaces.records.list}} or a {{ui:interfaces.records.table}}.  The block reads 50 records at a time, and {{ui:interfaces.records.more}} reads the next 50.  Turn off {{ui:interfaces.records.showFieldNames}} for lists and cards to show values only, with the first selected field as each record's heading, while table column headings stay visible.
- {{ui:interfaces.block.record}} shows the fields of the record someone picks in a records block on the same page.  Choose that block under {{ui:interfaces.record.source}}, and use {{ui:interfaces.fields.add}} to pick fields and put them in order, or leave the list empty to show every field.  People who can edit records edit them right there.
- {{ui:interfaces.block.number}} and {{ui:interfaces.block.chart}} work out a value or a chart from a table's records, with the same settings as a dashboard's tiles.  See {{doc:dashboards}} for each one.
- {{ui:interfaces.block.text}} shows a {{ui:interfaces.text.heading}} or a {{ui:interfaces.text.paragraph}}.  A paragraph understands a little Markdown: `**bold**`, `*italics*`, `-` for a list, and `[text](https://example.com)` for a link.
- {{ui:interfaces.block.filter}} narrows the page's records blocks for its table.  A {{ui:interfaces.filter.choice}} offers a field's choices, the people who can open the database, or a checkbox's two states, and {{ui:interfaces.filter.all}} shows everything again.  A {{ui:interfaces.filter.search}} finds records whose field contains what someone types.  Under {{ui:interfaces.filter.narrows}}, pick the records blocks it narrows, or leave them all clear to narrow every records block for that table.
- {{ui:interfaces.block.button}} shows a button with the {{ui:interfaces.button.label}} you give it.  {{ui:interfaces.button.form}} opens one of the table's form views in a dialog, where people who can add records fill it in, as described in {{doc:forms}}.  {{ui:interfaces.button.url}} opens an `http` or `https` address in a new tab.

## Using an interface

Pick a record in a records block to select it, with a click or by moving through the records with the arrow keys.  With {{ui:interfaces.records.showFieldNames}} off, use Tab to reach each record's heading and Enter or Space to select it.  If its first selected field is empty, or no fields are selected, the heading shows "{{ui:record.untitled}}" so you can still select the record.  Other empty values leave no gaps.  Record blocks that follow that records block show it.  The page's address changes to include the record, so you can bookmark it or share it with someone who can open the database.

What you choose in filter blocks narrows the page only for you, and never changes the interface for anyone else.

## What each person sees

Riosoma reads every block for the person looking at it, with that person's access, so an interface never shows anyone records they couldn't open themselves.  When a block's table, view, or field is deleted, or you don't have access to it, the block shows a message instead: "{{ui:interfaces.block.unavailable}}"  If a block can't load, choose {{ui:interfaces.block.retry}}.

Deleting an interface deletes it for everyone, and you can restore it for 30 days, as described in {{doc:trash-and-favorites}}.


## Custom code

Choose {{ui:interfaces.block.code}} under {{ui:interfaces.editor.add}} to build a block with {{ui:interfaces.code.html}}, {{ui:interfaces.code.css}}, and {{ui:interfaces.code.javascript}}.  Each source accepts up to 50,000 characters.  {{ui:interfaces.code.preview}} updates while you type.  Tab indents, Shift+Tab outdents, and Escape followed by Tab moves focus out of the editor.  Use responsive HTML and CSS, visible focus styles, and accessible labels for your controls.

Code runs in an isolated frame.  It cannot read the page's cookies, storage, or document, make network requests, open popups, or navigate the parent page.  Keep styles and scripts in the block itself.  Code may use inline images with data URLs.

WebRTC is unavailable in custom code, including data channels.  Put event handlers in {{ui:interfaces.code.javascript}}, since script tags and inline event handlers in HTML cannot run.  Renaming, moving, or resizing a block preserves its unsaved input and script state.  Changing its HTML, CSS, JavaScript, or language starts a fresh frame.

The `rio` bridge returns promises.  A `blockId` identifies a records block on the same page, and every read uses the current reader's access:

- `rio.records(blockId, offset = 0)` returns up to 100 records with the page's filters, their table ID, and paging information.
- `rio.selected(blockId)` returns the selected record, or `null`.
- `rio.open(blockId, recordId)` opens a readable record in a dialog and updates its deep link with `&detail=record`.  Record details blocks following the records block also show that record.
- `rio.change(blockId, recordId, values)` proposes field values by field ID.  The reader reviews the values under {{ui:interfaces.code.proposal}} and chooses {{ui:interfaces.code.apply}} or {{ui:interfaces.code.dismiss}}.  Approved changes use the reader's role, field permissions, and record rules.  They are audited and undoable like other record changes.

Preview allows reads only.  Save the block to use opening and changes.  Code cannot change interface settings.  Rejected calls carry a message key in their error.  The editor's address can be bookmarked with `?editor=<blockId>`, and `?editor=new` opens a new block.

## Editing page JSON

While editing an interface, choose {{ui:interfaces.json.title}}.  The editor shows the complete page, including its ID, name, blocks, and layout.  Keep the page ID and use unique block IDs.  Contract and block-link errors appear in the editor, and the server checks table, view, and field references when saving.

Choose {{ui:interfaces.json.save}} to save the page as one audited, undoable change, or {{ui:field.dialog.cancel}} to discard your draft.  If someone changes the page while you edit, reopen the editor to start from their version.  The page address with `?editor=json` opens this editor directly for creators and owners.  On phones, the editor fits the dialog and the sources scroll within it.

## Arranging pages and fields

While editing, drag a page to change the navigation order, or drag a field in a record block to change its field order.  On touch screens, press and hold before moving.  Focus the item's move control, then press Space to pick it up.  The arrow keys choose its destination, Space drops, and Escape cancels.  Fields unavailable to you retain their stored positions.  {{ui:interfaces.fields.add}} still adds a field to the end.

Dragging a block previews only that block.  Other blocks move into their new positions when you release it.  Each drop saves immediately as one undo step.  Touch uses the same move and resize controls.

## Published navigation

Open {{ui:sites.publish}}, and drag the named rows under {{ui:sites.pages}} to arrange the site's pages.  Focus a page's move control and press Space to pick it up.  Up or Down changes its position, Space drops, and Escape cancels.  Alt with Up or Down moves immediately.  On touch screens, press and hold the page before moving.  Choose {{ui:sites.save}} to publish the configured order.

## Bands, disclosure, and record sections

Set {{ui:interfaces.band}} on text, hero, image or video, records, number, chart, and button blocks.  {{ui:interfaces.band.none}} keeps the existing background.  {{ui:interfaces.band.quiet}}, {{ui:interfaces.band.accent}}, and {{ui:interfaces.band.inverse}} use the theme's accessible colors.  Consecutive rows with the same band join into one full-width band on the published page, with content at the usual page width.  A row with different bands uses no band.  A block spanning rows joins those rows when deciding the band.  The designer previews the selected colors.

Choose {{ui:interfaces.records.accordion}} under {{ui:interfaces.records.display}} to make each record a disclosure.  The first selected field is the question, and the remaining fields are the answer.  {{ui:interfaces.records.showFieldNames}} controls their field names.  Tab reaches a question, and Enter or Space opens it.  Disclosures work with scripts off and print with their answers visible.

Choose {{ui:interfaces.records.sections}} to turn records into page sections.  The first selected field supplies the heading, and the remaining fields supply paragraphs.  Headings and paragraphs preserve line breaks.  {{ui:interfaces.records.showFieldNames}} controls their field names.  {{ui:interfaces.records.sectionCover}} supplies an image or video from an attachment field, and {{ui:interfaces.records.altField}} supplies its description.  {{ui:interfaces.records.linkField}} supplies a web address, and {{ui:interfaces.records.linkLabelField}} supplies its button label.  Empty or unsafe addresses show no link.  Words and media alternate sides on wide screens, and words come first on phones.  The records keep the view's filter, order, and paging.  Description and button-label fields show people and linked records by name, just as selected fields do.

## Looping clips and enlarged pictures

Choose {{ui:sites.videoFile}} under {{ui:interfaces.media.type}} for a hero or image or video block.  {{ui:interfaces.media.playback}} defaults to {{ui:interfaces.media.controls}}.  {{ui:interfaces.media.loop}} plays a muted, inline loop without controls.  It also applies to videos in record sections.  A reader requesting reduced motion sees a still poster with controls to start playback.  Looping clips always stay muted.  With scripts off, the native controls remain available.  Published heroes, looping clips, and section videos reserve a widescreen frame when neither dimensions nor a poster are available, so loading the clip keeps the following content in place.

Turn on {{ui:interfaces.media.enlarge}} for an image or video block showing an image.  Press the picture to open it at full size, use Escape or {{ui:interfaces.media.enlarge.close}} to close it, and focus returns to the picture.  The control is labeled {{ui:interfaces.media.enlarge.open}} for screen readers.  With scripts off, the picture's link opens the original image.
