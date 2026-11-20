---
id: attachments
title: Adding and managing attachments
summary: Keep files with a record, preview them, and change their order.
area: databases
order: 9
level: simple
related: [fields, gallery, undo, public-view-links, connected-accounts]
---

An {{ui:field.type.attachment}} field keeps files with each record.  Use it for photos, documents, recordings, or other material that belongs beside your data.  A cell can hold several files.

## Adding files

Open the attachment cell and choose {{ui:files.add}} to select files from your computer.  You can also drop files into the open attachment panel, or paste files from the clipboard while focus is inside it.  Paste with ⌘+V on Mac or Ctrl+V on Windows and Linux.

## Adding from a cloud drive, the camera, or the screen

Choose {{ui:files.addFrom}} for the other ways to add files.  The menu lists only what works here:

- **Dropbox, Box, and Google Drive**, once an admin has set them up.  The first time, Riosoma asks you to connect your account, in a small window from the drive itself.  Dropbox and Box open in Riosoma's own picker: open folders, search the whole drive, and pick as many files as you like, even from different folders, then choose {{ui:drives.picker.add}}.  With the keyboard, the arrow keys move through the list, Space picks a file, and Enter opens a folder.  Google Drive opens Google's own picker, and Riosoma sees only the files you pick there.
- **Google Docs, Sheets, and Slides** have no file of their own, so Riosoma asks what to turn them into: {{ui:drives.format.pdf}}, which it chooses unless you change it, or {{ui:drives.format.office}}.
- **{{ui:files.addFrom.camera}}** uses your camera.  On a phone it opens the camera app.  On a computer it shows what the camera sees, and {{ui:files.camera.shutter}} takes the picture.
- **{{ui:files.addFrom.screen}}** asks your browser which screen, window, or tab to share, keeps one picture of it, and stops sharing right away.  Drag across the picture to keep part of it, or choose {{ui:files.screen.whole}}, then {{ui:files.screen.add}}.  With the keyboard, the arrow keys move the area, and Shift with an arrow key resizes it.

Files from a drive are copied into Riosoma, so they stay with the record even if they change or go away in the drive.  Each copy shows its progress, and {{ui:files.cancel}} stops it without leaving anything behind.  Copied files follow the same size limit and virus scanning as uploads.  {{doc:connected-accounts}} explains how to see and disconnect the accounts you connected.

## Adding from a web address

Choose {{ui:files.addFrom}}, then {{ui:files.url.title}}, to copy a file from a direct HTTPS link.  Enter its {{ui:files.url.address}} and, optionally, a {{ui:files.url.filename}}, then choose {{ui:files.url.add}}.  Links that need a sign-in, include credentials, or lead to private networks are refused.  The server checks every redirect and enforces the upload limit.  The dialog stays open with an explanation when a download fails.  A successful copy appends to the record's files, follows the configured virus scanning, and can be undone.  Its address in the app can be bookmarked to reopen this picker for the same record and field; the source URL is never put in the app's address.

## Finding an image

Choose {{ui:files.addFrom}}, then {{ui:files.search.title}}.  Enter {{ui:files.search.query}} and choose {{ui:files.search.search}}.  Results show their source site and a license when the search service reports one.  Check that site's usage terms, then choose the image's title to copy it into the record.  The server checks the download's address, redirects, size, and image content, and quarantines the attachment for virus scanning when enabled.  The source address and reported license stay in the attachment's metadata.

Image search uses the organization's SearXNG service and respects classification, access, and AI settings.  When web search is off or SearXNG isn't configured, the picker explains why it is unavailable.  Organization admins can choose {{ui:files.search.settings}} to configure it.

## Scanning documents

Choose {{ui:files.addFrom}}, then {{ui:files.scan.title}}.  Choose {{ui:files.scan.capture}} to photograph a page with your camera, or {{ui:files.scan.choose}} to use your device's photo picker.  Phones can open their camera through that picker.  If camera access fails, the photo picker remains available.

Riosoma detects the page edges.  Drag the four corner handles to adjust them, or focus a handle and use the arrow keys.  Hold Shift for larger adjustments.  Choose {{ui:files.scan.color}} or {{ui:files.scan.bw}} under {{ui:files.scan.mode}}, then {{ui:files.scan.addPage}} to correct the perspective and keep that page.  Repeat for up to 30 pages.  Use {{ui:files.scan.earlier}}, {{ui:files.scan.later}}, and each page’s delete icon to arrange the pages, then choose {{ui:files.scan.save}}.  Cropping and PDF creation run entirely in your browser; the finished PDF uploads as one attachment.

Bookmark the open image-search or scanning picker to reopen it for the same record and attachment field.  Captured pages and search terms aren't saved in the link.

## Upload progress and problems

Each upload shows its progress.  Wait for it to finish before relying on the attachment.  If an upload fails, use {{ui:files.retry}} when available, or {{ui:files.dismiss}} to remove the failed attempt.  Files over the upload limit need to be made smaller before uploading.

## Previewing and downloading

Select a file to open its preview.  Images appear in the preview, and audio and video have playback controls.  For an image, {{ui:files.openOriginal}} opens the original file.  PDFs and text files offer {{ui:files.openInNewTab}}.  Other files offer {{ui:files.download}}.  You can save an opened original with your browser's download controls.

Use {{ui:files.previous}} and {{ui:files.next}}, or the Left and Right arrow keys, to move between files.  Arrow keys keep their playback behavior when audio or video controls have focus.  Escape closes the preview.

## Reordering and removing

Drag a file onto another file to change the order.  With a file focused, Alt+Up and Alt+Down move it without dragging.  The first image can become a card's cover in a gallery or kanban view.

Use a file's remove button to take it out of the cell.  Removing an attachment or deleting its record retains the stored file so that undo can restore it.  Files already attached to records are not removed by the cleanup for abandoned uploads.  Uploads that were never attached are eligible for cleanup after one day.

When a file shows {{ui:files.checking}}, it is quarantined until its virus scan passes.  You cannot download, preview, share, or export it yet.  Files containing a virus are removed, and their entries show the detected signature.

## Arranging and dropping files

Drag a file’s body in its cell editor or expanded record to change its order.  On touch screens and with a pen, press and hold before moving.  With the file’s move control focused, press Space, use Up or Down, and press Space to drop.  Escape cancels, and each completed drop can be undone.  The other files stay still while dragging.

Drop files from your computer onto an attachment cell or its expanded record to upload them.  The highlighted drop zone shows {{ui:files.drop}}.  A locked or unavailable cell explains why it cannot accept the files before you release them.  Upload progress appears in the cell editor.

The file’s menu offers {{ui:sortable.menu.up}}, {{ui:sortable.menu.down}}, and {{ui:sortable.menu.to}} without dragging.  The plus button named {{ui:files.add}} adds files, and the remove icon keeps its tooltip and accessible name.
