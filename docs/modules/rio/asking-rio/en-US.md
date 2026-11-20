---
id: asking-rio
title: Asking Rio
summary: Ask about your data in your own words, and let Rio find, count, or build things for you.
area: rio
order: 0
level: simple
anchors: [rio.open, rio.input, rio.send, settings.rio]
related: [rio, ai-footprint, undo]
demo: asking-rio
sections: [settings.rio=what-to-ask]
routes: [/settings/rio, /settings/*/rio, /admin/*/rio]
---

Rio answers questions about your data.  Choose {{ui:rio.ai}} in the header, type a question in your own words, and choose {{ui:rio.send}}.

## What to ask

Ask Rio to find records, count them, explain how a table is set up, or build something for you, such as a table, a view, a form, a dashboard with tiles, an interface with pages and blocks, or an automation draft.  Rio reads only what you can read, and does only what you could do yourself.

New here?  Open {{ui:rio.ai}} and ask what to try first.  Rio suggests a few actions for the screen you're on and offers relevant Show-me demos.

Messages can contain up to 8,000 characters.  If a pasted message is longer, Rio keeps the full draft and explains the limit.  Shorten it before choosing {{ui:rio.send}}.  Shift+Enter adds a line without sending.

Choose {{ui:rio.stop}} to stop a reply and keep the text already received.  If a reply fails, your question returns to the composer for editing and resending with {{ui:rio.send}}.  A newer draft you have already started stays in place.

For wide warehouse tables, name the table and the columns your question needs.  Rio can read specific columns or continue through field pages, including columns near the end of a 500-field table.  Field permissions and data classification apply to every page.  Reading several schemas together shares the space available in the conversation.

When you ask to see records, Rio can show compact cards with the primary field and up to three details.  Ask for the fields that help answer your question, including fields hidden in a view that you still have permission to read.  Without a field choice, the details follow the view's visible columns.  The block names the table and database and includes a record count.  Open a record from its link, or hover over a shortened value to read it in full.  Wider panels show a table with a focusable scroll region.  Records read to answer other questions stay out of the chat unless showing them helps answer your request.

## Before Rio changes anything

Choose {{ui:ai.autonomy}} in [your personal Rio settings](/settings/ai/rio/autonomy), under AI, and use the page's {{ui:common.save}} bar to save your choice.  {{ui:settings.rio.ask}} shows every change for your approval.  {{ui:settings.rio.previewBig}} lets Rio change up to 20 records right away and previews larger changes.  {{ui:settings.rio.instant}} lets Rio make supported changes right away with a receipt.  Deletes and external actions always ask for approval.

Your organization sets the highest choice allowed.  Choices above it are disabled with {{ui:settings.rio.limited}}.  Rio uses the lower of your saved choice and that cap in chat and routine approvals.  If an admin lowers the cap below your choice, your personal page explains the limit and the setting Rio currently uses; your saved choice stays the same.  Until you choose, Rio follows the organization's cap.  Routines still wait for approval before changing records, and {{ui:settings.rio.ask}} also requires their full review instead of approval in one click.

When Rio previews a change, choose {{ui:rio.plan.apply}} or {{ui:rio.plan.dismiss}}.  Whatever Rio does, {{ui:rio.receipt.undo}} takes it back, and it's in your undo history too.

From Home, ask Rio to make a project tracker, a book club reading list, or a simple CRM.  Rio proposes a database in the open folder or your home.  Inside a database, Rio proposes tables unless you ask for a new database.  A fitting starter can supply the starting structure, which Rio adjusts to your request.

New databases always wait for approval.  Choose {{ui:rio.plan.preview}} to inspect each table's fields, views, and samples.  Clear {{ui:rio.plan.creation.samples}} to skip sample records.  Choose {{ui:rio.plan.apply}} to save and open the database, or {{ui:rio.plan.dismiss}} to decline.  The receipt's {{ui:rio.receipt.openDatabase}} reopens it.  Its {{ui:rio.receipt.undo}} asks before moving the whole database to the trash, with current counts and other people's changes shown for review.  Choose {{ui:undo.major.moveToTrash}} to continue, or {{ui:undo.major.keep}} to keep it.  Folder access and your organization's sharing policy apply when proposing, previewing, and approving the database.

After Rio reads record text, comments, history, library descriptions or guidance, knowledge passages, web results, or connected tool results, changes wait for {{ui:rio.plan.apply}} even with instant autonomy.  This approval requirement continues in later turns of the conversation.  Instructions inside that content cannot grant approval.  Review the proposed changes with {{ui:rio.plan.preview}} before applying them.  Follow-up web searches and memory changes are blocked after reading that content.  Use {{ui:rio.new}} for a direct request.  Routines also keep record changes and unapproved recipients or websites waiting for their owner's approval.

## Preview a plan

Choose {{ui:rio.plan.preview}} to see a database plan in the same interface you use every day.  The preview opens a separate sandbox.  Nothing you try there is saved or sent as a command.  Its address reopens the plan, and you can switch between the proposed changes with the buttons at the top.

Choose {{ui:rio.plan.preview.close}} to leave everything as it was, or {{ui:rio.plan.apply}} to save the proposed changes.  Apply checks your permissions and the commands again against the current database.  One {{ui:rio.receipt.undo}} takes back the whole plan.  Previews read only the targeted views and blocks, with up to 200 records across the whole preview.  Larger or slow sections show an unavailable message.  Dashboard numbers and charts use all records you can read.

On a phone, Rio's sheet waits out of sight while a preview or record card is open so the destination's keyboard controls keep focus.  Closing the card, or closing or applying the preview, brings Rio back with the same conversation, draft, and place in the transcript.  Full-page records keep Rio visible, including when your preferred record layout is a card.

Record previews follow the view's manual placement, groups, and pinned records.  Group headers count and summarize the sampled records in the preview.  If an approval response is lost after saving, Rio recovers the receipt and {{ui:rio.receipt.undo}}.  Reopening a conversation keeps completed undo marked {{ui:rio.receipt.undone}}.

Review {{ui:rio.plan.details}} before applying an automation, interface, or button plan.  A button plan names the automation it runs and shows its published steps.  These settings come from the validated commands and include triggers, recipients, destinations, and executable content.  If someone edits a dashboard, interface, or automation after the plan was proposed, ask Rio for a new plan.

Rio creates automations as unpublished drafts and saves changes to existing automations as drafts.  A person must publish a draft before its changes can run.  Rio cannot publish or turn an automation on.  Deletes, button runs, and configurations that use external services always ask for approval, regardless of autonomy settings.  Restore tables, fields, views, and interfaces yourself because restoring them can reopen public access.

## Past conversations

Rio stays open while you navigate, including when you follow a link in a reply on a phone.  Close Rio, press Escape while focus is in the panel, or choose the launcher to close it.  On a phone, choose {{ui:rio.close}} to see the page you opened.  Reopen Rio to continue at the same place.

Your active conversation stays with you when you change pages or databases, close and reopen Rio, reload, or open another tab in the same session.  It is saved to your account.  A quiet divider shows when your database or table changes, and your next request uses that page's context.

Your unsent draft and {{ui:rio.tier.everyday}} or {{ui:rio.tier.power}} choice survive a reload in the same tab and sign-in.  Starting or opening another conversation clears the draft.  A fresh sign-in starts with an empty draft and {{ui:rio.tier.everyday}}.

Choose {{ui:rio.new}} in the header to start an empty conversation on purpose.  {{ui:rio.history}} keeps your earlier conversations.  Opening one makes it active again.  A fresh sign-in starts a new conversation and keeps the previous one in history.  Navigation, database changes, and idle time do not start new conversations.

When a conversation uses about three quarters of the selected model's context window, Rio warns that it will start forgetting the earliest messages.  Choose {{ui:rio.compact}} to summarize decisions, open questions, changes, and useful IDs.  Later requests use the summary and recent turns.  Earlier messages stay visible, marked as summarized.  Compaction shows its own footprint line and keeps the conversation's approval restrictions.  You can also choose {{ui:rio.new}}, or keep chatting while Rio trims older history automatically.

The notice follows the history it measured.  If you navigate to Home or another database, {{ui:rio.compact}} still summarizes that history after checking your access again.  The summary applies to requests in its original database.

When the list is long, use {{ui:ui.picker.filter}} to find part of a conversation's title.  {{ui:ui.picker.recent}} puts conversations you recently opened first.  Use the arrow keys to move through matches and Enter to open one.

When Rio isn't turned on for your organization, an administrator can turn on AI in Settings.

On narrow tablets, the conversation panel covers the right part of the page.  Use {{ui:rio.close}} to return to the full page.
