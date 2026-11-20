---
id: forms
title: Collecting records with a form
summary: Ask for selected fields in a form, share it by public link, and save each submission as a record.
area: databases
order: 13
level: simple
related: [views, fields, attachments, automations, public-view-links, booking-pages]
anchors: [database.views.add, database.views, grid, forms.public.theme, view.settings.form]
demo: forms
sections: [view.settings.form=designing-the-form]
---

A form presents selected fields as questions.  Use it for requests, signups, or other information that is easier to enter one question at a time.  Each submission creates a new record in the form's table.  Choose {{ui:database.views.add}}, then {{ui:view.type.form}}, to create one.

## Designing the form

Choose {{ui:form.edit}} to change the form.  Set {{ui:form.title}} and {{ui:form.description}} to explain what people should enter.  In {{ui:form.fields}}, choose the fields to ask about.  Computed fields, such as formulas and autonumbers, are filled in automatically and cannot be questions.

For each question, set {{ui:form.label}} to use wording other than the field's name, and add {{ui:form.help}} when an example or explanation would help.  Turn on {{ui:form.required}} to prevent submission with that answer empty.  Removing a question leaves its field in the table.

Use {{ui:form.submitLabel}} to customize the submit button and {{ui:form.thankYou}} to set the message shown after a successful submission.  {{ui:form.allowAnother}} offers a fresh form afterward.  Leave custom text empty to use the default button and message.  Choose {{ui:form.done}} when ready to fill out the form.

## Showing questions conditionally

In {{ui:form.edit}}, set a question's {{ui:form.showIf}} to an earlier text, number, checkbox, or select question.  Set {{ui:form.matches}} to the answer that reveals it.  Text matches exactly, including capitalization.  A multiple select matches when it includes that choice.  Blank answers never match, and usable field defaults count as answers.  Choose {{ui:form.alwaysShow}} to remove the condition.

A hidden question is neither required nor submitted.  Changing an earlier answer clears any answers that become hidden, including dependent questions farther down the form.  The server rejects attempts to submit hidden answers.  If a trigger field is unavailable or restricted, its dependent questions stay hidden too.  Keep conditional questions after their triggers when reordering.  Removing a trigger question clears conditions that directly reference it.

When a checkbox question appears again, its usable field default returns.  Clearing a visible checkbox saves an unchecked answer.  The {{ui:form.matches}} picker offers all configured select choices, including choices in a cascade.  Removing a choice leaves conditions that match it dormant.  Other form settings can still change, and restoring the choice makes its conditions usable again.

These rules also apply at the public form's /f/:formId link and at the database view's existing address.  Integrations can replace the form settings with `form` in the REST view update or the `update_view` tool.  Rio can change the same settings through view commands.  Each settings change has an audit event and one undo action.

## Ordering questions without dragging

Drag a question to move it.  With its move control focused, Alt+Up and Alt+Down move the question using the keyboard.  The question also has up and down buttons that you can reach with Tab and activate with Enter or Space.  These changes affect the form's question order, not the table's field order.

## Submitting answers

Move between answers with Tab and Shift+Tab.  Complete the required questions, wait for any file uploads to finish, and choose {{ui:form.submit}} or your custom button label.  Missing or invalid answers are marked so you can correct them.

In a line-item question, an invalid cell keeps what you typed and prevents submission until you correct it.  Saving another cell does not clear that error.  Use {{ui:lineItems.add}} to add a line, and press Enter in a cell to save that cell without submitting the form.  An invalid time answer also prevents submission until you correct it.  Public numeric questions follow the field's setting for negative values.

After a successful submission, the form shows its confirmation message.  If enabled, {{ui:form.another}} clears the answers for a new submission.  Submitting adds a record rather than updating a previous response.

## Sharing a form by link

A form can also take answers from people who don't use Riosoma, such as customers or event guests.  They open a public link and answer without an account.

In the form view, choose {{ui:forms.public.share}}, then turn on its {{ui:forms.public.share}} switch.  Choose {{ui:forms.public.copy}} to copy the {{ui:forms.public.link}}, and send it however you like.  The dialog also counts the responses the link has brought in.  Sharing takes the {{ui:share.role.creator}} or {{ui:share.role.owner}} role, and forms on synced tables can't be shared.

The public form asks the same questions in your words, but questions about people, linked records, and attachments stay private, since answering them would show or store more than a stranger should.  The dialog lists any questions it leaves out.

Each response adds a record, credited to {{ui:history.system}} in the record's history, and starts any automation that watches the form.  To keep out junk, a form takes at most 20 responses an hour from the same internet connection, a limit your administrator can change.  Someone who leaves the form open for more than a day sees "{{ui:forms.public.ticket}}"

Choose a {{ui:publicTheme.label}} to give the public form its own look.  It wins over the database's theme on the form's page, and {{ui:publicTheme.inherit}} follows the database again.  The theme is part of the form's settings, so it saves at once, can be undone, and comes along when the database is copied.

To stop taking responses, choose {{ui:forms.public.stop}} and confirm.  The link stops working at once.  Sharing again makes a new link, so the old one never comes back.

If someone submits a form after you stop sharing it, they see "{{ui:forms.public.unavailable}}" and their response is not recorded.

## Editing a submitted response

In {{ui:form.edit}}, turn on {{ui:forms.edit.allow}} to give public submitters a private {{ui:forms.edit.open}} link on their confirmation screen.  It is off by default.  Set {{ui:forms.edit.days}} from 1 to 365 days.  The default is 30 days, and links always expire.  Changing the lifetime affects new links.

Turn on {{ui:forms.edit.offerEmail}} to let submitters optionally request their link by email.  Email is offered when outgoing mail and a public server address are configured.  Anyone with the link can edit that one response, so keep it private.

Opening the link fills the same form with the response's current visible answers.  Conditional questions still follow their earlier answers.  Hidden answers are neither disclosed nor overwritten.  Revealing a previously hidden question starts it empty, with checkboxes unchecked and ready to save.  Choose {{ui:forms.edit.save}} within 15 minutes.  Reopening a valid link starts a fresh session.  Clearing a visible answer clears its value, without reapplying field defaults.  An unchanged signature keeps its original signer and signing time.  Record locks, record rules, field permissions, and validation still apply, and a refused save explains why.  Editing does not start another payment.

In {{ui:forms.public.share}}, choose {{ui:forms.edit.revoke}} to invalidate every existing edit link and open edit session immediately.  New submissions can still receive new links.  Turning off response editing or stopping public sharing also refuses edits.

Every successful edit is audited as coming from the submitter's link.  People who can edit the table can choose {{ui:forms.edit.undo}} in the record's history.  Undo restores only accessible values that still match the response edit, preserving later changes and honoring locks and rules.

## Taking a payment

Use {{ui:payments.required}} to collect a fixed price or a price from a single select question, optionally multiplied by a quantity.  Visitors pay through Stripe Checkout, and verified webhooks update the protected payment result fields.  Responses still belong to no one, as on any form.  See [Taking payments](../payments/en-US.md) for setup, minimum prices, and refunds.

When response editing is enabled, public forms and forms on published sites show the private edit link on the confirmation screen before checkout.  Keep the link, then choose {{ui:forms.edit.continuePayment}}.  The edit link shows the answers that set the price, the single select option and the quantity, without letting them change, so a response always matches what it was charged.  Every other answer can still be edited.  Saving payment settings that stop pricing by one of those questions ends the edit links already sent for that form, the same as {{ui:forms.edit.revoke}}.

## Embedding and supporting files

In {{ui:forms.public.share}}, turn on {{ui:shareView.embedOn}}, list up to 20 exact origins under {{ui:shareView.sites}}, and choose {{ui:shareView.sitesSave}}.  Use {{ui:shareView.copyEmbed}} to copy the frame code.  Empty lists allow only same-origin frames.  Wildcards and paths are rejected.  Organization administrators can disable external embedding at /settings/public-sharing.

Choose {{ui:publicSharing.formFiles}} to offer existing files from the form's table as downloads.  Only the selected files are published, and only after an administrator enables {{ui:publicSharing.allowFiles}}.  Their signed links expire after one hour by default.  Removing a selected file, stopping sharing, or disabling public files revokes access immediately.  Quarantined files never appear.

## Arranging questions

Choose {{ui:form.edit}}, then drag a question.  Mouse dragging starts after a small movement.  On touch screens and with a pen, press and hold before moving.  With its move control focused, press Space, use Up or Down, and press Space to drop.  Escape cancels.  Other questions stay still until you drop, and the change is one undo step.
