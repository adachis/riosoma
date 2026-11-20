---
id: gallery
title: Browsing records in a gallery
summary: Show records as cards with images and a few useful details.
area: databases
order: 11
level: simple
related: [views, attachments, fields, conditional-colors]
anchors: [view.settings.gallery]
sections: [view.settings.gallery=setting-up-cards]
---

A gallery shows records as a grid of cards.  Use it when images help you recognize items, such as a product catalog, a reading list, or a collection of design references.  Choose {{ui:database.views.add}}, then {{ui:view.type.gallery}}, to create one.

## Setting up cards

Open {{ui:gallery.cards}} and choose an attachment field for {{ui:gallery.cover}}.  The first image in that record's attachment order supplies the cover.  Choose {{ui:gallery.cover.none}} for cards without covers.

Under {{ui:gallery.coverFit}}, choose {{ui:gallery.coverFit.crop}} to fill the image area or {{ui:gallery.coverFit.fit}} to preserve the whole image.  {{ui:gallery.size}} offers {{ui:gallery.size.small}}, {{ui:gallery.size.medium}}, and {{ui:gallery.size.large}}.

The primary field supplies the card's title.  Use {{ui:view.toolbar.hide}} to choose the other fields shown on cards.  {{ui:view.toolbar.filter}} narrows the records, and {{ui:view.toolbar.sort}} changes their order.  Everyone who opens this view sees its saved settings.

## Opening and adding records

Select a card to expand its record and edit its fields.  Changes also appear in the table's other views.  {{ui:gallery.newRecord}} creates a record and opens it for editing.

## Using the keyboard

Focus a card and use the arrow keys to move through the gallery.  Home goes to the first card, End goes to the last, and Enter or Space opens the focused record.

Without a sort, drag a card onto the left or right half of another card to place it before or after that card.  The insertion bar shows the position, and the sides reverse in right-to-left layouts.  {{keys:views.moveUp}} and {{keys:views.moveDown}} move the focused card in the saved order.  The order belongs to this gallery and is shared with everyone who opens it.  Remove {{ui:view.toolbar.sort}} to arrange sorted cards by hand.

On a touch screen, press briefly before dragging.  Moving right away scrolls instead.  A highlighted target and a screen-reader announcement identify the destination or explain why it is unavailable.  Escape cancels, other cards stay in place until release, and one undo step reverses a completed move.  Locked records and locked views cannot be rearranged.

To change which image appears first, reorder the files in the attachment field as described in {{doc:attachments}}.
