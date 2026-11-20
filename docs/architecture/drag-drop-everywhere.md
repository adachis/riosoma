# Arranging lists and containers

The shared sortable list and tree keep neighboring items in place until a drop.  Item bodies use a mouse movement threshold and a stationary hold for pen and touch.  Editable rows reveal one shared grip at inline start on hover and keyboard focus.  Keyboard pickup, cancellation, announcements, and menu destinations share the existing drop rules.  Spatial designers share pointer handling, preserve their existing arrow-key movement and resizing, and commit pointer drops immediately.

| Place | What drags now | What you changed |
|---|---|---|
| Database sidebar | Tables, dashboards, automations, interfaces, scripts, and nested folders | Replaced native item dragging with shared trees.  Per-entry parent and position changes share one command group.  Folder deletion reparents its contents, and inverses preserve unrelated peer edits. |
| Views | Desktop tabs and the phone view list | Added shared sorting with locked views kept in place.  No view-folder model exists. |
| Home | Databases, folders, shortcuts, selections, and favorites | Added shared dragging onto folder cards, sidebar folders, and Trash, with command preflight and grouped undo. |
| View rules | Filters, sorts, groups, colors, hidden fields, and choices | Confirmed the existing shared components cover these lists.  Group rules use the sort editor. |
| Attachments | Files in cell editors, expanded records, and interface details | Uses shared sorting and retains desktop file upload. |
| Linked records | Selected records in cell editors and expanded records | Added shared sorting while preserving the selected identifiers and unavailable-record placeholders. |
| Form builder | Questions | Replaced native dragging with shared sorting and retained the existing move buttons.  There is no separate form-section model. |
| Record layouts | Fields in interface record-detail blocks | Added shared sorting while preserving stored identifiers hidden from the current viewer.  Expanded records offer card or panel presentation, not a section designer. |
| Published sites | Pages in site navigation | Added shared page sorting in publishing settings.  Page moves update the publishing draft.  Publishing saves the configured order through the existing publishing flow. |
| Interfaces | Blocks and page tabs | Added shared page sorting and shared spatial dragging.  Blocks other than the active block remain still until release. |
| Dashboards | Tiles | Enabled phone layout editing.  Shared spatial dragging handles touch and pen, commits one pointer drop immediately, and keeps neighboring tiles still during preview. |
| Automations | Steps within each path and switch paths | Added shared sorting and immediate draft commits for drops.  Existing canvas notes retain their separate spatial controls. |
| Routines | No independent editable step list | Routine details display saved steps without an ordering editor. |
| Reports and documents | No independent section designer | Report scheduling and template configuration do not expose an ordered section collection. |
| Organization units | Units onto new parents or the organization root | Added shared trees, authoritative preflight, stored commands, guarded undo, audit metadata, realtime notices, and selection deep links.  Siblings remain alphabetical. |
| Other settings | No meaningful user-controlled order | Policy settings, notification preferences, and administrative tables do not apply in a user-selected sequence. |
| Desktop files | Attachment cells, attachment panels, and import drop zones | Added a clear attachment-cell target and refusal feedback.  Existing panel and import upload paths remain available. |
| Knowledge | Desktop documents into library upload and replacement forms | Added a visible drop zone with the file picker's formats and size limit, selected filename announcements, and validation before submission through the existing command bus. |
| Other record views | Existing record-view interactions | Retained grid row operations, kanban card and stack moves, chronological date controls, and sort-driven gallery order.  Calendar rescheduling changes dates rather than an independently stored list order. |
| Line items | Rows inside a parent record | Hidden child tables store real records. Drag a row number, or press Alt+Up or Alt+Down, to change the ordered parent link. |

## Storage and access decisions

Sidebar folders belong to their existing sidebar section.  Folder structure and item parents use the database settings object, and item positions keep their existing storage.  Database archive copies remap folder and item identifiers together.

Migration 0086 adds favorite positions to the existing per-user database state.  It creates no table.  Favorites remain personal.  New favorites append at the end, and tied existing positions are normalized server-side by one move action.

Home selection drops use one atomic command with all selected actions and one inverse.  Only Home's own command route accepts several actions in one command, and the public API, tools, and plans send one action at a time.  Hover preflight authorizes and reads proposed ancestry without locks, temporary writes, or record scans.  The final command remains authoritative.  A drop that changes inherited access directs the person to the existing move review.  Organization-unit moves retain the editor's authority, policy, cycle, and depth checks.

Recent, Shared with me, and tag views refuse in-list filing because their roots are filters.  Folder cards, sidebar folders, My files, and Trash remain explicit destinations.  New native shortcuts cannot drop onto Trash or filtered navigation links.  Single-action home commands and their undo remain uncapped, including restoring a large folder.  The cost limit applies only to batches with more than one action.  Shared shortcut creation and moves notify the destination folder's readers, while personal shortcuts notify only their owner.

Shared sorting retains clipped pointer collision bounds and destination anchors across peer edits.  External destinations require a release inside their bounds.  Editable row controls retain Option and arrow-key editing.  Immediate refusal messages clear on blur or the next key press, and asynchronous preflight updates revalidate the current destination before release.

All new reads use the area's existing access layer.  Move reviews and Home audiences ask `AccessScope`, whose one role statement answers `databaseRole` and `folderRole` for one person and the same question for every member at once, including the label gate that keeps guests out of closed databases.  It finds grants through each resource's own ancestors, so its work follows the grants that apply rather than every grant in the organization.  Renaming or sharing a folder notifies that folder's readers, and other Home commands notify the readers of what they change, with all of a command's notices sent in one statement.  Favorite and private-tag notices target their owner, and favorites wait only on that person's other favorite changes, never on Home or database locks.  A unit move sends members one notice and each guest in the moved units their own.  Legacy notices still invalidate cached access checks.  Existing database sessions carry schema, view, record, and designer changes to peers.  The existing command contracts expose the new arrangement data through the API and the tools that already accept those commands.

No view folders, form sections, independent record-layout sections, line-item model, or report-section designer were introduced.  Knowledge drop zones use the existing file-backed libraries.
