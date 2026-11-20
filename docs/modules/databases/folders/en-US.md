---
id: folders
title: Organizing files in folders
summary: Make nested folders, share their contents, and move files with access in view.
area: databases
order: 5
level: simple
related: [sharing]
---

Open {{ui:home.myFiles}} to organize the databases and folders you make.  Choose {{ui:home.folders.new}}, enter a name, and save.  Open a folder to make another inside it, up to 10 levels deep.  The folder path takes you back to its parents, and the address can be copied to open the same folder later.

{{ui:home.shared}} shows folders and databases shared with you directly or through a group.  Organization-wide sharing does not put an item here.  {{ui:home.recent}}, {{ui:home.favorites}}, and {{ui:trash.open}} are available beside it.

Choose {{ui:home.folders.share}} in a folder's menu to give a person, group, or your organization a role.  Sharing reaches every nested folder and database.  A person's highest direct or inherited role applies, and inherited roles change in the folder where they were granted.  Only owners can share folders.

Choose {{ui:home.folders.move}} from an item's menu to move it with a keyboard or on a phone.  You can also drag a database or folder onto another folder.  A database has one parent folder.  Moving a database requires its owner role, and the destination requires an editor role or higher.  When moving reduces someone's access, review the names and choose {{ui:home.folders.confirmMove}} to continue.

Open databases recheck access after folder changes.  People who lose access stop receiving live records, including when they open a database during a move.  Connections that check for changes periodically also check access before sending those changes.

The {{ui:database.share}} list names an inherited grant's folder only when you can open that folder.  Otherwise, it shows {{ui:share.fromPrivateFolder}}.  The grant still applies to the database.

{{ui:home.folders.trash}} moves a folder and its contents to Trash together.  {{ui:home.folders.restore}} brings them back together.  Items that were already in Trash stay there.  After a change, {{ui:home.deleted.undo}} reverses it when the affected items have not changed again.

## Shortcuts

Open the menu beside a dashboard, interface, view, or form, and choose {{ui:home.shortcuts.add}}.  The shortcut opens that target directly.  You can also drag its name onto {{ui:shell.nav.home}}, or drop it onto a home folder in another window.

A shortcut keeps working when its target is renamed or moved.  It follows the target's access, so sharing a folder never grants access to a shortcut's target.  When you cannot open the target, home shows {{ui:home.shortcuts.unavailable}} without its name.  Deleting the target moves its shortcuts to {{ui:trash.open}}.

Choose {{ui:home.folders.move}} from a shortcut's menu to place it in a folder.  This also works with a keyboard and on a phone.  Removing a shortcut leaves its target in place.  {{ui:home.deleted.undo}} reverses a change when the shortcut has not changed again.

## Tags

Choose {{ui:home.tags.manage}} on home to create tags and apply them to databases or folders.  Select an {{ui:home.tags.item}}, then check the tags it should have.  Shared tags are visible to everyone who can open the item, and applying them requires edit access.  Private tags belong only to you and need only read access.  Their dashed border and {{ui:home.tags.private}} label distinguish them without relying on color.

The palette includes red, orange, yellow, green, blue, purple, and gray.  Organization owners and people administrators can add, edit, and remove named hex colors under {{ui:home.tags.palette}}.  Editing the palette leaves existing tag colors as they were.

The {{ui:home.tags.title}} section lists the tags you can see.  Choose one to filter home to all accessible databases and folders with that tag.  Each tag has a shareable address at `/home/tags/<tagId>`.  Private tags and inaccessible items stay hidden when someone else opens that address.  The command palette also finds tags by name.

Tab moves between controls, Space changes a tag checkbox, and Escape closes the tag dialog.  These controls are available on phones.  Home navigation wraps above the file list whenever its container is narrow, including beside an open right panel.

Home shortcuts, tags, assignments, and palette colors stay in the original organization when an organization archive is moved to another installation.

Changes requested in chat follow your approval setting and your organization's limit.  Moving shortcuts or tags to Trash, removing tag assignments, and changing the organization palette always require approval.  Review the plan and choose {{ui:rio.plan.apply}} to continue, or {{ui:rio.plan.dismiss}} to leave home unchanged.  After a change, {{ui:rio.receipt.undo}} reverses it when the affected items have not changed again.

## Dragging and arranging

Drag an item's body with a mouse.  On touch screens and with a pen, press and hold before moving.  Moving immediately scrolls instead.  Select several items with their checkboxes to move them together.  Drop onto a folder card, a folder in the sidebar, or {{ui:trash.open}}.  Each drop has one {{ui:home.deleted.undo}} action.  In {{ui:home.favorites}}, drag the items to choose the order.

With the item’s move control focused, press Space, use the arrow keys, and press Space again to drop.  Right enters the folder above, Left leaves a folder, and Escape cancels.  A message explains when a destination is unavailable.  Moves that change access require review through {{ui:home.folders.move}}.

Inside a database, choose the plus button named {{ui:database.sidebar.addFolder}} in a section’s header.  Drag tables, dashboards, automations, interfaces, or scripts into folders in their section.  Folders can nest.  Double-click a folder name, press F2 on its row, or choose {{ui:database.sidebar.rename}} in its menu.  Enter saves {{ui:database.sidebar.folderName}}, and Escape cancels.  The disclosure icon expands or collapses its contents.  Long names have a tooltip with the full name.  The sidebar stays still until the drop, and other people see the saved arrangement.

The name stays in its editor while saving.  If the save fails, your draft stays available so you can retry with Enter or cancel with Escape.

Choose {{ui:database.sidebar.deleteFolder}} in a sidebar folder’s overflow or context menu to remove it.  A folder with contents explains the result before you confirm.  Its contents move to the folder's parent in the same undoable change.

{{ui:home.myFiles}} accepts drops that move items to the top level.  {{ui:home.shared}}, {{ui:home.recent}}, and {{ui:home.favorites}} filter the listing and do not accept filing drops.  Opening another section or folder clears the selection.  A refused selection names the items you cannot move, and items already in the destination stay where they are.

Recent, Shared with me, and tag lists show items from different folders.  Their list positions do not change where items are filed.  Drop on a folder, {{ui:home.section.mine}}, or {{ui:trash.open}} to move an item.  Favorites stores its own personal order.

Every movable item’s menu offers {{ui:sortable.menu.up}}, {{ui:sortable.menu.down}}, and {{ui:sortable.menu.to}}.  The menu uses the same permissions and drop rules as dragging.  Rows with editable controls show a leading grip on hover or keyboard focus.  It stays inside the row’s padding, including in right-to-left layouts.  A folder’s menu also offers {{ui:database.sidebar.newFolderInside}}.  Home folders support the same inline rename shortcuts.  Use the leading disclosure control to open a Home folder’s existing page.
