---
id: kanban
title: Working with a kanban board
summary: Arrange records in stacks and move work between stages or people.
area: databases
order: 10
level: simple
related: [views, fields, attachments, conditional-colors]
anchors: [database.views.add, view.settings.kanban]
demo: kanban
sections: [view.settings.kanban=choosing-stacks-and-cards]
---

A kanban board shows records as cards in stacks.  Use it to follow work through stages or see which person owns each item.  Choose {{ui:database.views.add}}, then {{ui:view.type.kanban}}, to add one to a table.

## Choosing stacks and cards

Set {{ui:kanban.stackedBy}} to a {{ui:field.type.singleSelect}} field or a {{ui:field.type.user}} field that allows only one person.  Each option or person gets a stack.  Records with no value go in a separate stack.

Open {{ui:kanban.cards}} to choose an attachment field for {{ui:kanban.cover}}.  Use {{ui:kanban.coverFit.crop}} to fill the cover area or {{ui:kanban.coverFit.fit}} to show the whole image.  {{ui:kanban.hideEmpty}} hides stacks with no records.

The view's filters, sorts, and visible fields control which cards appear, their order within stacks, and what they show.  See {{doc:views}} for those shared settings.  Settings save as you change them and apply to everyone using the view.

## Moving records

Drag a card into another stack to change the record's selected option or assigned person.  This changes the record in every view.  Open a card to edit its other fields, or use {{ui:kanban.newCard}} within a stack to create a record with that stack's value.

With a card focused, press {{keys:views.moveLeft}} or {{keys:views.moveRight}} to move it to an adjacent visible stack.  You can also open the card's menu and choose its destination.  Without a sort, drag within a stack to arrange cards, or press {{keys:views.moveUp}} or {{keys:views.moveDown}} on a focused card.  Each board saves its own order.  When a sort is present, remove it through {{ui:view.toolbar.sort}} to arrange cards by hand.

## On a phone

A phone shows one stack at a time, across the whole screen, with its name and count at the top.  Swipe sideways, or use {{ui:kanban.previous}} and {{ui:kanban.next}}, to go from one stack to the next.  To move a card by touch, press and hold it until the other stacks appear above the board, then drag it onto the one you want.  The card's menu works too, and so does holding a stack's header to reorder the stacks.

## Arranging stacks

Drag stack headers to reorder them.  For the keyboard alternative, open a stack's menu and choose {{ui:kanban.stack.left}} or {{ui:kanban.stack.right}}.  {{ui:kanban.stack.hide}} hides a stack without deleting its records.  The hidden-stack menu lets you show it again.

## Drag feedback and undo

A highlighted target shows where a card or stack will land.  Keep the pointer near a board edge to scroll sideways.  On a touch screen, press briefly before moving, or swipe right away to scroll.  Other cards stay in place until release.  Escape cancels, and each completed drag is one undo step.

Locked records, locked or restricted grouping fields, calculated values, and read-only Data Source values cannot be moved.  The target explains a refusal before release.  {{doc:undo}} explains how to undo a saved move.
