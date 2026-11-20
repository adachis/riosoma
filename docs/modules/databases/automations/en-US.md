---
id: automations
title: Automating routine work
summary: When something happens in a database, update or add records, send email, or call another app on your behalf.
area: databases
order: 19
level: standard
related: [forms, comments-and-history, linked-records, trash-and-favorites]
anchors: [automations.section, automations.add, database.tables, automation.canvas, automation.steps]
demo: automations
sections: [automation.canvas=moving-around-the-canvas, automation.steps=steps]
routes: [/*/automations/*]
---

An automation watches for something to happen in a database, such as a new record or a form response, then runs its steps: updating a record, adding one, sending an email, or calling another app.  It runs on the server, so it keeps working when nobody has the database open.

People with the {{ui:share.role.creator}} or {{ui:share.role.owner}} role build and change automations.  Everyone else who can open the database can see them and how they ran, without the controls.

## Adding an automation

Automations are listed under {{ui:automations.section}} in a database's sidebar, with a filled dot beside each one that's on.  Choose {{ui:automations.add}} to make one.  It starts off, named "{{ui:automations.untitled}}", so nothing happens until you're ready.  Change its {{ui:automations.name}} at the top of its page.

An automation reads from top to bottom: what starts it, any conditions, and then its steps.

## What starts it

Under {{ui:automations.trigger}}, choose one of these:

- {{ui:automations.trigger.recordCreated}} in the {{ui:automations.trigger.table}} you choose.
- {{ui:automations.trigger.recordUpdated}}.  Check the fields to watch under {{ui:automations.trigger.fields}}, or leave them all unchecked to react to {{ui:automations.trigger.anyField}}.  A formula, lookup, rollup, or count changes when a field it's worked out from changes.
- {{ui:automations.trigger.recordMatches}}.  Choose a {{ui:automations.trigger.view}} to use its filter, or {{ui:automations.trigger.noView}}, and add conditions of the trigger's own below it.  The automation runs when a record goes from not matching to matching, including a new record that matches right away.  A record that already matches doesn't start it again until it stops matching and then matches once more.
- {{ui:automations.trigger.formSubmitted}} through the {{ui:automations.trigger.form}} you choose, including answers sent through a public link.  This choice needs a form view in the database.
- {{ui:automations.trigger.schedule}}.  Under {{ui:automations.schedule.every}}, choose a number of hours, days, or weeks.  Daily and weekly schedules run at the time under {{ui:automations.schedule.at}}, and weekly ones on the day under {{ui:automations.schedule.weekday}}, in the {{ui:automations.schedule.timeZone}} you choose.  They keep that time when clocks change for daylight saving.  Hourly schedules run on the hour.  If the server was down when runs were due, it makes one run when it's back instead of catching up on each one it missed.
- {{ui:automations.trigger.webhook}}.  Another app starts the automation by sending JSON to its {{ui:automations.webhook.address}}, which {{ui:automations.webhook.copy}} copies.  Anyone with the address can start the automation, so share it only with the app that needs it.

## Conditions

To run the steps for only some records, choose {{ui:automations.conditions.add}}.  Conditions under {{ui:automations.conditions}} work like a view's filter.  They're checked against the record that started the automation just before the steps run, and when it doesn't match, the run is skipped.  Schedules and webhooks don't start with a record, so they can't have conditions.

## Steps

Choose {{ui:automations.step.add}} under the last step, or the small add button above a step to put one before it, and pick what the step does.  Steps initially connect in order within each path.  Hand wiring chooses the execution paths.  Each list can hold up to 25 steps, with up to 100 steps across the automation.

- {{ui:automations.step.updateRecord}} changes a record.  Under {{ui:automations.step.record}}, choose {{ui:automations.step.triggerRecord}}, or a record an upstream step created.  Record and value pickers follow the wires, and their step numbers match the cards even when you arrange the cards in a different order.
- {{ui:automations.step.createRecord}} adds a record to the {{ui:automations.trigger.table}} you choose.
- {{ui:automations.step.sendEmail}} sends a message.  Put addresses in {{ui:automations.step.to}} with commas between them, or insert an email or person field to use the addresses it holds.  Then write the {{ui:automations.step.subject}} and {{ui:automations.step.body}}.  A message can use a little Markdown, such as `**bold**`, lists, and links.  One run emails 50 people at most, and sending needs the server's email to be set up.
- {{ui:automations.step.callWebhook}} sends a request to another app.  Enter its {{ui:automations.step.url}}, the {{ui:automations.step.method}} it expects, any {{ui:automations.step.headers}} as one `Name: value` per line, and a {{ui:automations.step.json}} if it needs one.

For the record steps, choose {{ui:automations.step.setField}} for each field to fill in, and type what goes in it.  Fields Riosoma fills in itself, such as formulas, can't be set.

If rewiring makes a saved {{ui:automations.step.record}} source unavailable, its name stays visible.  Reconnect its upstream path, or choose another record source before publishing.

The buttons on each step move it ({{ui:automations.step.moveUp}}, {{ui:automations.step.moveDown}}), copy it ({{ui:automations.step.duplicate}}), or remove it ({{ui:automations.step.delete}}).  Changes save to the automation's draft as you make them, and nothing that runs changes until you publish, as described in [Drafts and publishing](#drafts-and-publishing).  When a step uses something that was deleted, its card says "{{ui:automations.problem.missing}}"  A step moved above the step that makes its record says "{{ui:automations.problem.order}}"

## Branches and loops

Choose {{ui:automations.step.if}} to check the record with the filter builder.  The {{ui:automations.path.then}} path runs when it matches, and {{ui:automations.path.otherwise}} runs when it does not.  Choose {{ui:automations.step.switch}} to compare {{ui:automations.switch.value}} with the literal value on each path.  The first matching path runs, or {{ui:automations.path.otherwise}} when none matches.  Comparisons are exact, including capitalization.

Each path has its own {{ui:automations.step.add}} control.  Paths can contain other branches or loops, up to five levels deep.  Labels identify each colored port, so color is never the only way to follow a path.  Values from a step inside one path stay available to later steps in that path.

Choose {{ui:automations.step.repeat}} and set {{ui:automations.loop.listInput}} to a multi-value field, a JSON array, or an earlier step's array of records or values.  Inside the loop, `{{item}}` holds the current item, `{{item.name}}` reads an object's name, and `{{index}}` starts at zero.  An inner loop uses its own item and index, then restores the outer loop's values afterward.  To update each record in a list, choose {{ui:automations.step.updateRecord}}, set {{ui:automations.step.record}} to {{ui:automations.loop.item}}, and choose the record's table.

{{ui:automations.loop.cap}} defaults to 1,000.  It counts items across all loops in the run, including nested loops, and accepts values from 1 through 10,000.  A loop that would exceed the remaining allowance fails before its items run.  This setting is saved with the automation's draft and published version.  Open {{ui:automations.versions.diff}} in the draft bar to compare nested steps, paths, wait settings, and notes before publishing.

## Waiting

Choose {{ui:automations.step.wait}} and select {{ui:automations.wait.duration}}, {{ui:automations.wait.untilDate}}, or {{ui:automations.wait.untilCondition}}.  Durations and timeouts are in seconds.  A date can come from a field or an earlier step.  A date without a time means midnight UTC.  A date already in the past continues immediately.

A condition wait watches the record that started the automation.  Record changes prompt another check, and the worker also checks periodically until {{ui:automations.wait.timeoutSeconds}} expires.  If the condition still does not hold, the run fails at the wait step.

Waiting releases the worker while keeping the run's path, loop items, and deadline in PostgreSQL.  Restarts and newer published versions do not replace that saved configuration.  A failure handled through an error wire keeps its recorded outcome and recovery path when the wait wakes or a later failed step resumes.  In {{ui:automations.runs}}, open a run marked {{ui:automations.run.waiting}} and choose {{ui:automations.run.cancel}} to stop it.  Canceling is undoable while the run remains canceled.

Before continuing, the run checks its person's current access to the data earlier steps could read.  If field or record rules limit that access, it fails and turns the automation off without repeating completed steps.  Saved script results can contain data from any table, so a restriction anywhere in the database prevents their reuse.

## Moving around the canvas

Use {{ui:automations.canvas.zoomIn}}, {{ui:automations.canvas.zoomOut}}, {{ui:automations.canvas.fit}}, and {{ui:automations.canvas.reset}} to adjust the view.  Drag the canvas background or scroll to pan.  With the canvas focused, arrow keys pan, plus and minus zoom, and zero restores actual size.  Tab reaches each step, path, and control.  On a phone, paths stack vertically.

{{ui:automations.canvas.minimap}} lists the steps and notes.  Selecting one moves focus to it and adds a linkable location to the page address.  The {{ui:automations.runs}} and {{ui:automations.versions}} tabs also keep their location in the address.

Choose {{ui:automations.canvas.addNote}} to annotate the canvas.  Notes save in the draft and published version, and never execute.  Write in {{ui:automations.canvas.note}}, then focus {{ui:automations.canvas.moveNote}} and use the arrow keys to place it.  {{ui:automations.canvas.removeNote}} removes it through the same undoable draft change as other edits.

{{ui:automations.simulate}} walks the chosen paths and each loop iteration without sending anything, keeping record changes, or actually waiting.  Run history keeps each executed path's {{ui:automations.run.input}} and output.  {{ui:automations.test.step}} on a branch or loop checks that step's decision or list without executing its children.

## Posting to Slack

Choose {{ui:automations.step.slack}}.  In your Slack app's settings, enable Incoming Webhooks, add a webhook to the workspace, and choose the channel.  Paste the resulting address from `hooks.slack.com` into {{ui:automations.messaging.webhookUrl}}.  See [Slack's incoming webhook setup](https://docs.slack.dev/messaging/sending-messages-using-incoming-webhooks/) for the workspace setup steps.

Write the {{ui:automations.step.body}} with text and inserted field values.  Token values cannot add Slack mentions or formatting.  Slack's formatting delimiters in token values appear as visually similar Unicode characters because Slack does not provide a backslash escape for them.

The address is sealed when saved and appears as {{ui:automations.messaging.saved}}.  Use {{ui:automations.messaging.replace}} to enter another address.  Saved addresses cannot be read back, and duplicated steps need their own address.

## Posting to Teams

Choose {{ui:automations.step.teams}}.  Teams takes posts through a workflow made in the channel, which someone in the channel sets up once:

1. In Teams, open the channel's More options, and choose Workflows.
2. Choose the template that posts to a channel when a webhook request is received, called Send webhook alerts to a channel in most places, name it, and choose Next.
3. Pick the team and the channel, choose Add workflow, and copy the address it shows.

See [Teams' webhook workflow setup](https://support.microsoft.com/en-us/workflows/send-messages-in-teams-using-incoming-webhooks) for more.

Paste the address into {{ui:automations.messaging.webhookUrl}} and write the {{ui:automations.step.body}}.  Riosoma accepts HTTPS addresses on subdomains of `environment.api.powerplatform.com`, where workflows made since late 2025 answer, and of `logic.azure.com` and `webhook.office.com`, for older ones.  It sends an Adaptive Card containing the text, with markup in token values escaped.  The address is sealed and shown as {{ui:automations.messaging.saved}}, with {{ui:automations.messaging.replace}} to change it.  Anyone who has the address can post to the channel, so keep it to yourself.

A workflow answers as soon as it has the post and puts it in the channel a moment later.  When a message never shows up though the run succeeded, open the workflow's run history in Power Automate, which says why.

## Sending email through Microsoft 365

When your server sends its email through Microsoft 365, {{ui:automations.step.sendEmail}} works the same way.  Messages come from the mailbox the server's operator chose, and replies go to that mailbox.  Microsoft 365 limits how much one mailbox sends, about 30 messages a minute and 10,000 recipients a day, so an automation that emails many people at once can reach it.  Messages past the limit wait until Microsoft takes them again, or fail if that takes too long.

## Posting to Discord

Choose {{ui:automations.step.discord}}.  In the server's channel settings, open Integrations, create a webhook for the channel, and copy its URL.  Paste it into {{ui:automations.messaging.webhookUrl}}.  The address must use `discord.com` or `discordapp.com` under `/api/webhooks/`.

Write the {{ui:automations.step.body}} with text and tokens.  Token markup is escaped, and all allowed mentions are disabled, so a record cannot notify everyone or a role.  The address is sealed and shown as {{ui:automations.messaging.saved}} after saving.  Choose {{ui:automations.messaging.replace}} to change it.

## Sending a text message

Choose {{ui:automations.step.sms}}.  SMS costs money, including tests, and longer messages can incur charges for multiple segments.  SMS starts off for the entire organization.  An owner or security admin can turn on {{ui:automations.messaging.enable}} in the SMS step.  Turning it off prevents subsequent sends, including test runs.

In the Twilio console, find the Account SID and auth token, and obtain a phone number capable of sending SMS.  Enter them under {{ui:automations.messaging.accountSid}}, {{ui:automations.messaging.authToken}}, and {{ui:automations.messaging.from}}.  The auth token is sealed, appears as {{ui:automations.messaging.saved}}, and can only be replaced.  Trial accounts can require a verified recipient.

Under {{ui:automations.step.to}}, enter an E.164 number, starting with `+` and the country code, or insert a token for a phone field.  The sending number and the filled recipient must both be E.164.  Write the {{ui:automations.step.body}} with text and tokens, up to 1,600 characters after values are filled in.  Messages that exceed the limit fail without sending.  See the [Messages API documentation](https://www.twilio.com/docs/messaging/api/message-resource) for provider requirements.

For all four messaging steps, {{ui:automations.test.step}} tests only that step and sends a real message after confirmation.  Requests use the same time, size, and private-network limits as webhook steps.  Rate limits and server errors are retried twice.  A provider can accept a message before returning an error, so a retry may deliver a duplicate.  Run history keeps the provider's status and recognized error code, without the message body, webhook address, or auth token.  A successful request means the provider accepted it, not that the recipient received it.

## Running a script

Choose {{ui:automations.step.script}} to run JavaScript with mapped values from the trigger or earlier steps.  To run a script by hand instead, with questions along the way, see {{doc:scripts}}.  Add each {{ui:automations.script.inputName}}, then insert its value with the same token picker as other steps.  A mapping containing one token keeps its JSON type.  The script reads these values from the frozen `input` object.

For example, map `count` to a number field, then write:

```javascript
const nextCount = Number(input.count ?? 0) + 1
await console.info(nextCount)
await output({ count: nextCount })
```

Later steps can insert the script's {{ui:automations.script.output}}.  Use `steps.<stepId>.output.count` inside a token to read the example's `count` property.  The last awaited `output(value)` sets the result, which must serialize to JSON.

The script can await these operations:

- `console.log`, `console.info`, `console.warn`, and `console.error` capture messages in the run's {{ui:automations.script.logs}}.
- `fetch(url, init)` calls an HTTPS address.  The optional `init` object accepts `method`, `headers`, and a string `body`.  Methods are GET, POST, PUT, and PATCH.  The response has `status`, a headers object, `text()`, and `json()`.  Private addresses and all redirects are refused, and responses are limited to 64 KB.
- `records.find(tableId, { filter, limit })` reads records in this database.  Filters use the same field IDs, operators, and groups as view filters.  The default limit is 20, and the maximum is 100.
- `records.create(tableId, values)` and `records.update(tableId, recordId, values)` write values keyed by field ID and return `recordId` and `tableId`.  Values use their stored JSON types.  Writes use the automation's permissions, audit trail, and broadcasts, and cannot write signatures or computed fields.
- `sleep(milliseconds)` pauses within the same deadline.

Scripts cannot access the server, files, modules, or other network APIs.  Every run starts with a separate sandbox.  Script text is limited to 64 KB, inputs to 100 mappings, logs to 64 KB, and bridge calls to 1,000 with 1 MB of total request data.  Output defaults to 256 KB, memory to 64 MB including the WebAssembly heap, and the deadline to five seconds including waits.  The operator can set `RIOSOMA_AUTOMATIONS_SCRIPT_OUTPUT_KB` up to 1,024, `RIOSOMA_AUTOMATIONS_SCRIPT_MEMORY_MB` from 16 to 128, and `RIOSOMA_AUTOMATIONS_SCRIPT_TIMEOUT_MS` from 10 to 10,000.  Invalid settings use the defaults.

Each script runs on a thread of its own, so a script that keeps working doesn't hold up anyone else's requests, and it is stopped within a second of its deadline whatever it is doing.  All of one run's scripts share five minutes of running time, so a script inside {{ui:automations.step.repeat}} can't multiply its own deadline, and a run that uses the five minutes up fails at the script it was on.  The time a script waits for its turn doesn't count, and a run that continues after a wait keeps what it had left.  A server runs at most four automation scripts at a time for one organization, and eight in all.  Others wait their turn, and a published run always gets its turn.  A test or a simulation is refused when 16 scripts from the same organization are already waiting, and each person can have two tests or simulations with scripts under way at a time.  A third is refused until one of them finishes.

Tab indents selected lines by two spaces, and Shift+Tab outdents them.  Press Escape, then Tab to leave the field.  The editor shows the cursor's line and column and marks a failed test's error line.  {{ui:automations.test.step}} runs only that script and shows its inputs, logs, output, and duration.  It performs real writes and requests, and completed writes remain if a later operation fails.  Only people who can change the automation can read its script, mappings, and captured values.

## Filling in values

The add button beside each box, {{ui:automations.token.insert}}, puts in a value that's filled in each time the automation runs:

- a field of {{ui:automations.step.triggerRecord}}, or a {{ui:automations.token.link}}
- a field of a record an earlier step created or updated
- {{ui:automations.token.now}}
- for webhooks, {{ui:automations.token.body}}.  Type the path to it after the dot, with dots between names, such as `order.email`.  A number picks from a list, so `items.0.name` is the first item's name.

When a box holds just one inserted value and it comes from the same kind of field, the value is copied as it is, so a date stays a date and an option becomes the option with the same name.  Anything else is read the way you'd type it: numbers, dates such as 2026-10-15, yes or no for a checkbox, options by name, and people by name or email address.  Options have to exist in the field already.

## Drafts and publishing

An automation runs its published version.  Once someone changes it, the changes go to a draft instead, and the top of its page says {{ui:automations.draft.badge}} until they're published.  Everyone who can change the automation works on the same draft and sees each other's changes as they're made.  Tests run the draft, so you can try your changes before anything that runs changes.

{{ui:automations.draft.publish}} and {{ui:automations.test.whole}} wait for your latest edits to save.  If the server refuses a save, your edits stay on screen, and publishing or testing stops until they are accepted.

- {{ui:automations.draft.publish}} checks the draft against the database and makes it the published version, the one that runs.  A draft that uses something deleted since it was saved can't be published until it's fixed.
- {{ui:automations.draft.discard}} throws the draft away, after asking, and leaves the published version as it is.
- Changing the draft back to what's published leaves nothing to publish, so the badge goes away.

Each publish gives the automation a new version number.  The {{ui:automations.versions}} tab lists the version marked {{ui:automations.versions.live}} and the ones it replaced, the last 20, with when each was published and by whom.  {{ui:automations.versions.restore}} brings any of them back as the draft, to look over and publish again.  Restoring one when there's already a draft replaces the draft, after asking.  Publishing, discarding, and restoring can all be undone, and undoing a publish makes the version before it run again.  Undoing anything else, such as an edit to the draft, a rename, a move, or turning it on or off, never changes what's published, so it can't take back a publish someone made since.  An undo or redo that turns the automation back on makes it act as you, as turning it on does.

A Slack, Teams, or Discord address or a Twilio token stays saved while the published version, the draft, or a kept version uses it.  Publishing, discarding a draft, and letting go of an old version let go of any that nothing uses anymore, so undoing a change from before then may ask you to enter one again.

A new automation starts as its first published version, with no draft.  Automations made before versions were kept became version 1.

## Turning it on, and who it acts as

When it's ready, turn on the switch at the top of its page.  While it's off, the switch reminds you: "{{ui:automations.turnOnNote}}"  Once it's on, the switch names the person it runs as.  The switch turns the published version on or off, whether or not there's a draft.

You can turn {{ui:automations.on}} to {{ui:automations.off}} even while draft edits are invalid.  Those edits stay on screen so you can correct them before publishing.

An automation always acts as a person: whoever turned it on, or whoever last published a change while it was on.  That way it can never do more than that person could do themselves.  A run keeps that person along with the version it runs, so one person's version never runs with another's access.  Its changes follow the same rules as edits in the app, appear for everyone right away, and show in each record's history under that person's name.  Steps that change records need the {{ui:share.role.editor}}, {{ui:share.role.creator}}, or {{ui:share.role.owner}} role, and email and webhook steps need access to the database.

If that person loses the access a step needs, for example because their account was deactivated, the database is no longer shared with them, or their role no longer lets them edit records, the automation turns itself off instead of acting for someone who can't.  Its page says why, with a {{ui:automations.turnOn}} button.  Turning it back on makes it act as you.

An automation's own changes never start it again.  They can start other automations, but only five in a row, so one change can't set off an endless chain.  A routine changes records only through plans its owner approves, and those changes start automations just as that person's own changes would.  See {{doc:routines}}.

## Testing

Tests run what's on the cards: the draft when there is one, or the published version.  Choose {{ui:automations.test.step}} on a step card to test only that step.  Earlier steps and later steps do not run.  The panel shows the inputs it will use.  When the latest completed run contains every value the step needs, the test uses those recorded trigger values and earlier outputs, even if the source records have changed since then.  It uses them only from a run that acted as you, since a run that acted as someone else read with their access.

For a nested step, the test uses its last executed occurrence on the same branch and loop path.  The item, index, and earlier outputs all come from that occurrence.  When that path did not run, or the step moved to another path, enter samples for the missing values.

When the latest run cannot supply every value, enter the missing values in the sample fields.  Text is accepted directly, and JSON preserves numbers, booleans, lists, objects, and null.  Trigger values can fall back to the trigger's own test sample: the newest matching record or the last webhook call.  An update step also needs the ID of the record to change.  Missing values prevent the step from running and appear in the result.

Choose {{ui:automations.test.runStep}} after reviewing the inputs.  The in-app confirmation explains what the step will do.  Side effects are real: a test can create or update records, send messages, incur SMS charges, or call other apps.  Script writes remain even if the script later fails.  A single-step test acts as you, the person testing, as a whole test does, so it never does more than you could do yourself, whoever the automation acts as.  Single-step tests ignore the automation's trigger conditions and never start other automations.

The result shows the resolved inputs, output, script logs, and any error.  It also appears under {{ui:automations.runs}}, marked {{ui:automations.run.stepTest}}, and a test of the draft is marked {{ui:automations.run.draft}}.  Like the draft itself, tests of it are listed only for people who can change the automation.

Choose {{ui:automations.test.whole}} in the header to run all steps together, as you, even while the automation is off.  If the automation starts with a record, choose one under {{ui:automations.test.record}}, or keep {{ui:automations.test.newest}}.  Conditions still apply, so a record that does not meet them is skipped.  A whole test of a webhook automation reuses the last call its address received.  Whole tests also have real side effects and appear in history marked {{ui:automations.run.test}}.

## Simulating a run

Choose {{ui:automations.simulate}} in the header to walk the whole automation without sending or saving anything.  If it starts with a record, choose one under {{ui:automations.simulate.record}}, or keep {{ui:automations.test.newest}}.  A webhook automation takes a {{ui:automations.simulate.body}}, or uses the last call its address received when you leave it empty.  A schedule has nothing to choose.

{{ui:automations.simulate.step}} moves one card at a time, and {{ui:automations.simulate.run}} goes on to the end.  As the walk reaches each card, the line into it lights up and the card shows what passed through it:

- The trigger shows its record's values.
- {{ui:automations.conditions}} shows which conditions the record meets and, under {{ui:automations.simulate.branch}}, whether the walk goes on to the steps or stops there.  A condition on a field hidden from you is left out, as a view's filter leaves it out for you, and shows as hidden.
- A step that changes records shows each change with its {{ui:automations.simulate.before}} and {{ui:automations.simulate.after}} values, including fields worked out from the ones it changes, such as formulas.  Nothing is saved, but later steps see the changes as if they had been made.  A new record shows the number an auto number field would give it, without taking that number, so the next real record still gets it.
- A step that sends an email, posts a message, or calls a webhook shows what it would send, with every value filled in, and sends nothing.  The steps after it see a stand-in answer, status 200 with an empty body.
- A script runs in its sandbox as usual.  Its record changes are worked out and shown instead of saved, and `fetch` sends nothing and answers with status 200 and an empty JSON object, `{}`.  `records.find` reads records as they are, without the simulation's own changes.

The walk follows a failed step's error wire when one is connected, and stops at the first failure without a recovery path.  It says why the step failed.  It also stops after 100 record changes, and the records it changes stay locked until it ends, so someone else changing one of them waits a moment.  {{ui:automations.simulate.reset}} clears it.  Changing the automation while a simulation is showing asks you to start over, since the simulation no longer matches.

A simulation reads and changes records with your access, not the access of the person the automation acts as, so it never shows you anything you couldn't see yourself.  Lookups and counts add up only the linked records you can see.  When a real run would read differently, for example because a rule hides a field from you or locks one you can't change, the panel says so.  Simulations never appear under {{ui:automations.runs}}, never count toward the 60 runs a minute, and never start other automations.  An address on a private network is refused only when it's written as one, since looking a name up would reach outside Riosoma.  Simulating needs the same role as testing.

## Diagnosing a run

When a run fails or is skipped, open it under {{ui:automations.runs}} and choose {{ui:automations.diagnose}}.  Rio reads the failed step's settings, what it was given, its error, and the steps before it, and explains in plain words what went wrong and why.  For a skipped run, it also reads which conditions the record meets now.

Rio never reads values you can't see.  A run reads as the person the automation acts as, so when a rule limits what you can see anywhere in the database, Rio reads none of the run's values, not even ones you can see, since a linked record's name or a count can come from records a rule keeps from you.  It reads only the automation's settings, with the values typed into them held back, what went wrong, and the fields' names and types, and the answer says so.

Whoever asks, a webhook step's settings often hold its own passwords and keys, so Rio reads its address only up to the path, its headers by name, and its body without the values typed into it.  When a fix gives back a setting as Rio read it, the setting keeps what it has.

Stored webhook inputs receive the same protection after a step is removed or changed to another kind.  Diagnose uses the run's saved settings or its published version, and still removes request credentials when those settings are no longer available.

When a change to the automation would fix it, Rio offers one {{ui:automations.diagnose.fix}}, with each setting it changes before and after.  Nothing changes until you choose {{ui:rio.plan.apply}}, which saves the change to the automation as one action, and {{ui:rio.receipt.undo}} takes it back in one step.  If the automation changed since the diagnosis, the fix no longer applies, so diagnose the run again.  {{ui:rio.plan.dismiss}} sets it aside.

Each diagnosis shows the model, how many tokens it used, and what it cost when the price is known, and it counts toward the organization's AI budget.  Diagnose needs Rio to be on with an AI provider, and an admin can turn it off in AI settings with {{ui:ai.diagnose}}.  Diagnosing needs the same role as changing the automation.

## Runs

The {{ui:automations.runs}} tab lists the runs from the last 30 days, newest first.  Each shows whether it's {{ui:automations.run.queued}}, {{ui:automations.run.running}}, {{ui:automations.run.succeeded}}, {{ui:automations.run.failed}}, or {{ui:automations.run.skipped}}, what started it, when, and how long it took.  Open a run to see what each step did and what went wrong.  {{ui:automations.runs.more}} loads older runs.

- A step that fails stops the run, and the steps after it are skipped.
- A run is skipped when its record doesn't meet the conditions or was deleted, or when the automation was turned off or deleted before the run began.
- A run fails without running anything more when the automation comes to act as someone else partway: after a rerun, a resumed run, or a button's run was queued, while a run waits at a step, or before a run is picked up again after a restart.  {{ui:automations.run.rerunAction}} runs what's published now.
- Each automation starts at most 60 runs a minute.  The rest wait their turn.
- A webhook has to answer within 10 seconds with a success code, and addresses on private networks are refused.  Only people who can change the automation see what a webhook answered.
- Each run shows the version it ran, since what's published can change between runs.

## Running a run again

People who can change an automation can open a run and start it again.  The new run acts as the person the automation runs as, not whoever asked, waits its turn under the limit of 60 runs a minute like any other run, and says which run it came from.  The automation has to be on.  The new run keeps that person along with the version it was queued with, so if the automation acts as someone else by the time it starts, for example because someone published a change in between, it fails without running anything, and you can run it again.  Tests are never run again this way, since they're tests, and a test acts as the person testing.  Test again instead.

- {{ui:automations.run.rerunAction}} runs the published version from the start, with the same record or webhook call that started the original run.  Its conditions are checked again, so a record that no longer meets them is skipped.  Every step runs again, so records are made and messages sent a second time.
- {{ui:automations.run.resume}} appears on the step where a run failed.  The new run keeps what the steps before it did, marked {{ui:automations.run.reused}}, without making their records or sending their messages again, and goes on from the step that failed.  It uses the published version, so you can fix the step that failed, publish, and then resume.  The conditions aren't checked again, since the earlier steps may have changed the record.

Going on from a step is only safe when the steps before it are still the ones that ran, so it's refused, with the reason, when the trigger or any of those steps changed since the run, when the step is no longer there, or when the version the run used is no longer kept.  Renaming a step doesn't count as a change.

What the earlier steps did was worked out with the access of the person the run acted as, so it's also refused:

- When the automation acts as someone else now, for example because someone else turned it on or published a change while it was on.  If that happens after you resume but before the new run starts, the new run fails at that step without running it.
- When a rule limits what you can see in a table those steps read: the trigger's table, a table a record step made or changed a record in, or a table those link to.  After a script step, which can read any table, any rule in the database that limits you counts.

{{ui:automations.run.rerunAction}} is still there when resuming isn't, since it runs every step again as the person the automation acts as now.  Reruns are marked {{ui:automations.run.rerun}} in the list, and resumed runs {{ui:automations.run.resumed}}.  Open one to see when the run it came from started, to the second, on a button that opens that run in the list, loading older runs if it has to.

## Renaming and deleting

An automation's menu in the sidebar has {{ui:automations.rename}} and {{ui:automations.delete}}.  Deleting stops the automation and deletes it for everyone, and you can restore it for 30 days, as described in {{doc:trash-and-favorites}}.  A restored automation is on or off as it was, and a schedule picks up from then instead of catching up.  Drag automations to reorder them, or hold Alt and press Up or Down.

## Posting through an agent

Choose {{ui:automations.step.studioFlow}} to send `message`, optional `title`, `recipient`, and `recordUrl` to a Power Automate HTTP trigger.  The flow posts as a published agent.  The trigger address uses the same host checks, sealed storage, and retries as {{ui:automations.step.teams}}.  See {{doc:power-platform}} for setup and delivery limits.

## Arranging steps

In the step list, drag a step's named row to change its order within its path.  A step carries its branches with it.  Press Space on its move control, use Up or Down, and press Space to drop.  Escape cancels.  {{ui:automations.step.moveUp}} and {{ui:automations.step.moveDown}} remain available.  Each drop saves the draft immediately as one undo step.

## Finding records and using the results

Choose {{ui:automations.step.findRecords}}, select a table, set its filter, and choose {{ui:automations.find.limit}} from 1 through 100.  Results follow the run owner's field and record access, in record order.  The output includes `records` and `count`, with a 1 MB limit.  Choose {{ui:automations.find.records}} from this step as the list for {{ui:automations.step.repeat}}, then use `{{item.id}}` and `{{item.values.<fieldId>}}` inside the loop.  A simulation also finds records created or changed earlier in that simulation.

Live table searches refuse filters the source cannot apply exactly.  The simulator keeps discovered source rows and choices temporary.  A joined table that needs a live source refresh requires {{ui:automations.test.step}}, because its refresh changes stored data.

## Creating calendar events

Choose {{ui:automations.step.createCalendarEvent}} and select {{ui:automations.calendar.account}}.  An admin first sets up the calendar integration, and the run owner connects their account under {{ui:automations.calendar.connect}}.  For a single-tenant Microsoft application, enter its directory tenant ID in {{ui:integrations.tenant}} in integration settings.  Calendar connections are separate from drive connections.  Google Calendar needs permission to edit events, and Microsoft 365 Calendar needs delegated calendar write permission.

Leave {{ui:automations.calendar.id}} blank for the primary calendar, or enter the calendar's ID.  Fill the title, description, start, and end with text or record tokens.  Use dates alone for an all-day event, with an exclusive end date, or include a time and UTC offset, such as `2026-10-01T09:00:00-07:00`.  Record date tokens use their stored values.  The end must follow the start.  The step creates an event without inviting attendees.  The run history keeps its event ID, and undo removes the event from the same person's calendar after the rest of the undo is saved.  If the account was reconnected or the automation is in the trash, undo skips that event and still reverses the other changes.  If the calendar service doesn't answer, the undo still goes through, a message says how many events are waiting, and Riosoma keeps trying for up to two days.  If the calendar refuses, for example because the connection was revoked, or the tries run out, Riosoma stops, the event stays, and you get a notification that says why.  A redo keeps the original event instead of creating a second one, while the removal is still waiting or for 90 days after it stopped.  A redo after those 90 days creates a new event.  If a removal is under way at that moment, the redo is refused, and you can try it again a moment later.

{{ui:automations.test.step}} for a calendar step acts as you, so it uses your own connected account, and it creates a real event.  {{ui:automations.simulate}} shows the filled request with a stand-in event result and never contacts the calendar service.

## Generating documents

Choose {{ui:automations.step.generateDocument}}, select the record, and choose {{ui:automations.document.source}} and {{ui:automations.document.target}}.  Attach a Word, PDF, or Excel template to the source field on that record.  The step uses the first attachment with the selected format, after its scan clears.  Templates and generated documents are limited to 10 MB.  ZIP templates also have a 16 MB limit per inflated part and a 64 MB limit for all inflated content.

Word and Excel placeholders use double braces around a name, such as `{{customer}}`.  PDF templates use text, checkbox, or dropdown form fields with matching names.  Choose {{ui:automations.document.add}} for each name, then fill its value with text or record tokens.  PDF checkbox values are `true` or `false`.  PDF fields are flattened in the generated file.  Enter {{ui:automations.document.filename}}, and the format's extension is added when needed.

Generated documents are stored in PostgreSQL, even when uploads use another file store.  This keeps attachment bytes in the same rollback boundary as record changes and simulations.

The output includes the attachment ID, record ID, and file name.  Existing attachments stay in place.  Attaching checks the run owner's current access and record locks, produces an audit event, and supports undo.  A simulation renders and attaches only inside its temporary transaction, then discards the file and record change.

## Asking AI

Choose {{ui:automations.step.askAi}}, write {{ui:automations.ask.promptLabel}} with record tokens, and choose {{ui:automations.ask.format}}, {{ui:automations.ask.tier}}, and {{ui:automations.ask.classification}}.  Classification is self-declared by the author.  Choose the highest classification of any included value.  The organization's rules check this label, without detecting sensitive content.  Database export, external-sharing, and provider restrictions also apply.  When the database, or any table or field in it, has a label with {{ui:governance.noProviders}}, the step fails before it builds a prompt, in the simulator too, because values from earlier searches and webhooks can carry protected data.  AI access, unit policy, and the monthly budget apply to the run owner.  Organization and personal guidance also apply.  The organization’s {{ui:ai.automationAi}} switch and unit policy control AI steps, and {{ui:ai.automations.limit}} caps all calls in a run, including loops.  Calls reserve their maximum estimated cost before sending, and reservations survive worker recovery.  A model running on the organization's own hardware counts as free.  A hosted model without a known price is refused, because its cost can't be checked against the limit.

The output includes `text`, `json`, and usage with token counts, cost, and footprint when an estimate is available.  A JSON answer that cannot be parsed fails the step.  The answer can fill later steps, including branches and loops.  Review generated answers before using them in email, webhook, calendar, or messaging steps.  Calls count under {{ui:ai.feature.automations}} in the footprint report.  {{ui:automations.test.step}} for an AI step acts as you, so your own AI access, unit policy, and budget apply, and it makes a real call.  The simulator checks policy, sends no prompt, and returns empty text or an empty JSON object as its stand-in.

All four steps save as drafts, publish with the automation, and work inside branches and loops.  Their filled inputs and outputs appear in tests and run history when your access permits it.  Step links, keyboard controls, and the phone layout work the same way as for other steps.

## Connecting steps by hand

Drag a step's {{ui:automations.wire.output}} port to another step's {{ui:automations.wire.input}} port.  A live wire follows your mouse, finger, or pen.  Hold briefly before dragging with touch or a pen.  Ports show why a connection cannot land there before you release.  A refused drop leaves the draft as it was.

The {{ui:automations.wire.yes}}, {{ui:automations.wire.no}}, {{ui:automations.wire.each}}, {{ui:automations.wire.done}}, and {{ui:automations.wire.error}} ports route separate paths.  Their labels identify each color.  {{ui:automations.wire.input}} accepts one wire.  {{ui:automations.wire.merge}} accepts several, waits for the upstream decisions, and runs the step once when any incoming path is taken.  Merge paths within the same loop.  Use {{ui:automations.wire.done}} to connect the step after a loop.  An error wire continues with its connected step when an action fails.  A permission refusal still stops the run.

Drop an output wire on empty canvas to open {{ui:automations.wire.picker}}.  Pick a step to add it and connect it in one change.  Drag a connected input to another input to move its wire.  Select a wire in {{ui:automations.wire.list}}, then use {{ui:automations.wire.moveSource}} or {{ui:automations.wire.moveTarget}} to move either end.  Delete or Backspace removes the selected connection.  Its context menu also offers {{ui:automations.wire.remove}}.

For the keyboard path, Tab to an output port and press Enter or Space to start.  Arrow keys move to compatible input ports.  Enter confirms, Escape cancels, and N opens {{ui:automations.wire.picker}} to add a connected step.  Tab can reach other ports and announces why they refuse the connection.  Select a connection, choose an end to move, and use the same keys to rewire it.  Keyboard connections, pointer connections, rewires, and removals each have one undo step, and peers see the saved draft live.  Use Command+Z or Ctrl+Z to undo, and add Shift to redo.

Disconnected steps can stay in a draft.  Their cards explain whether they need an input or cannot be reached from the trigger.  {{ui:automations.draft.publish}} lists the affected step names and IDs until they are connected.  Runs and {{ui:automations.simulate}} follow saved wires, even when steps appear in a different order.  After publishing changed wires, start a new run.  A run using earlier connections cannot resume through the new ones.  Automations saved before hand wiring keep their existing ordered paths until a connection is edited.  API commands accept optional `config.connections`, containing each wire's `id`, `source`, and `target`, with a `stepId` and `port` at each end.  Omitting connections keeps the earlier ordered behavior.

## Send a notification

Add {{ui:automations.step.sendNotification}} with {{ui:automations.step.add}}.  In {{ui:automations.notification.recipients}}, choose specific people, a group, people in a person field of the triggering record, the record’s creator, or the automation’s owner—the person who created the automation.  A group uses its current membership when the step runs.

Write the {{ui:automations.notification.title}} and {{ui:automations.step.body}}.  Use the value picker to insert fields from the triggering record, values from earlier steps, or the current time.  {{ui:automations.notification.link}} defaults to {{ui:automations.notification.recordLink}}.  Choose {{ui:automations.notification.noLink}} or {{ui:automations.notification.customLink}} when another destination fits.

Each recipient’s bell, email, push, chat, and digest preferences apply.  Someone who cannot read a record gets no link or field values from it.  Derived outputs that cannot be traced to individual fields require full database access.  Access is checked again when the notification is read or delivered.

{{ui:automations.test.step}} sends a real notification after confirmation.  The simulator shows who would receive it and their rendered messages without sending anything.  Run history keeps the recipients, titles, messages, and links.  An empty recipient list, a person who was deleted or left, an invalid link, or a burst beyond the limit fails the step.  Each run can notify 50 people, and each person can receive 50 automation notifications an hour.  Undo removes the in-app notification and any pending delivery.  Messages already delivered to another channel cannot be recalled.
