---
id: choosing-items
title: Choosing from long lists
summary: Find an item, hide groups, and choose with the keyboard in large pickers.
area: getting-started
order: 8
level: simple
related: [palette, airtable-import, other-tools-import]
---

Large database, table, field, member, group, template, and source pickers include {{ui:ui.picker.filter}}.  Type any part of a name to narrow the list.  Accents do not need to match.  Member pickers also match email addresses.  A combo box filters through its own text field and shows all available choices when reopened.

Group buttons show how many matching items they contain.  When there are at least two named groups, choose a group button to hide or show its items.  Pickers with saved preferences remember that choice in this browser.  Filtering temporarily expands every group so hidden items remain searchable.  Clearing the filter restores your saved groups.  A single group stays expanded.  When a picker has no natural groups, its items appear under {{ui:ui.picker.all}} and cannot be collapsed.

Pickers for repeated choices show {{ui:ui.picker.recent}} first.  Recent choices stay in this browser and appear the next time you open the picker.  Choosing an item keeps the current list in place.  Items that are no longer available never appear just because you chose them before.

Use Up and Down to move through the list and Enter to choose.  Type in the filter to narrow it again.  Enter in a nonempty filter chooses the first available match without submitting the surrounding form.  If that match is already selected in a picker that accepts several choices, it stays selected.  Enter in an empty filter keeps your choices.  Escape clears the filter first and then dismisses the picker without clearing selections.  Counts of visible matches are announced to screen readers.  In a picker that accepts several choices, filtering keeps the choices you already made.

Dialog titles and action buttons stay visible while their contents scroll.  Long menus and pickers scroll inside their panels on phones and larger screens.  Very large lists render the visible rows as you scroll, so thousands of choices remain usable.

In {{ui:sources.add}}, source kinds are options in a list.  Use {{ui:ui.picker.filter}} to find a kind, then choose it with Enter or a tap.  The sync wizard names its filter for the source, such as {{ui:synced.wizard.search}}.  Tab reaches a list’s scroll area even when its options keep keyboard focus in the filter.
