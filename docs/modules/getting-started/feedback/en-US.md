---
id: feedback
title: Sending feedback
summary: Tell your organization's admins that something's broken, share an idea, or ask a question, from wherever you are.
area: getting-started
order: 5
level: simple
related: [palette, notifications, welcome]
anchors: [settings.feedback, settings.my.feedback]
sections: [settings.feedback=for-admins-the-feedback-inbox, settings.my.feedback=replies]
---

When something's broken, or you wish Riosoma did something it doesn't, say so from wherever you are. Your organization's admins read everything sent this way. It stays in your organization unless an admin reviews and sends a bug report through an enabled publishing path.

## Sending it

There are three ways in:

- open {{ui:shell.personalMenu}} at the end of the top bar, then choose {{ui:shell.helpMenu.feedback}}
- search for {{ui:palette.cmd.feedback}} with {{keys:palette.open}}
- press {{keys:feedback.open}}, even while you're typing in a cell

Choose what it is, {{ui:feedback.kind.broken}}, {{ui:feedback.kind.idea}}, or {{ui:feedback.kind.question}}, write your message, and choose {{ui:feedback.send}}.  For something broken, say what you were doing, what you expected, and what happened instead.  You can send up to 20 an hour.

## The screenshot

A picture of the page often says more than words.  Choose {{ui:feedback.screenshot.take}} and Riosoma draws one in your browser, with every cell value, record name, field value, email address, and anything typed in a field blurred out before it leaves the page.  Pictures and charts become plain boxes.  You see the screenshot before it's sent, and {{ui:feedback.screenshot.remove}} takes it off.  If your browser can't draw it, choose {{ui:feedback.screenshot.upload}} to add an image of your own, up to 2 MB.

## What goes with it

Under {{ui:feedback.context.title}} the dialog lists what's sent with your message, exactly as it's sent: the page you were on, with any record's ID left out, the version of Riosoma, your browser and platform, your theme and language, and the last few errors the page ran into.  Errors keep what they said and where, never the values they were working with.

## Replies

When an admin replies, you hear about it under the bell and by email.  To stop the emails, turn off {{ui:notifications.settings.feedbackReply}} in Settings, under {{ui:notifications.settings.title}}.  Everything you've sent, where it stands, and every reply are in Settings, under {{ui:settings.nav.myFeedback}}.

## For admins: the feedback inbox

Owners, and members given the feedback admin role, read feedback in Settings, under {{ui:settings.nav.feedback}}.  A count beside it says how many are new.  The newest come first, and you can narrow the list by {{ui:feedback.inbox.kind}} and {{ui:feedback.inbox.status}}.  Each one shows its message, its screenshot, and, under {{ui:feedback.inbox.context}}, the context it came with.

- {{ui:feedback.reply.send}} answers the sender in the app and by email, and marks something new as {{ui:feedback.status.seen}}.
- {{ui:feedback.inbox.status}} moves it between {{ui:feedback.status.new}}, {{ui:feedback.status.seen}}, and {{ui:feedback.status.done}}.
- {{ui:feedback.delete}} removes it with its screenshot and replies.

Deleting a person's account deletes everything they sent.  The audit log records each piece sent, each reply, each change of status, each deletion, and each bug report, and never anyone's words.

### Bug reports on GitHub

Feedback never leaves the organization on its own.  An organization can let its admins turn something broken into a GitHub issue, and that's off to start with.  An owner or an admin with the integrations role turns it on under {{ui:feedback.github.title}}, with {{ui:feedback.github.enabled}}, the {{ui:feedback.github.repository}} as `owner/name`, and a {{ui:feedback.github.token}}.  Use a fine-grained token for that one repository with Issues set to read and write, and Contents set to read and write too if you'll send screenshots.  The token is stored sealed and never shown again.

With that on, broken things in the inbox have {{ui:feedback.github.send}}.  It shows exactly what will be sent, word for word: the message and the context, never the sender's name, and never the screenshot unless you tick {{ui:feedback.github.screenshot}}.  A screenshot goes into the repository as a file under `.github/feedback-screenshots/`, and the issue shows it.  Riosoma looks through the repository's 100 most recently updated open issues first, and when one has a close title, you can add the report to it as a comment instead of choosing {{ui:feedback.github.open}}.

A GitHub Enterprise server works too.  Set `RIOSOMA_GITHUB_API_URL` to its API address, such as `https://github.example.com/api/v3`.  Calls to GitHub go through the same guard as webhooks, so an address on a private network is refused unless `RIOSOMA_AUTOMATIONS_ALLOW_PRIVATE_HOSTS` allows it.

### Upstream software bugs

Under {{ui:feedback.hub.title}}, an owner or integrations admin can enable {{ui:feedback.hub.enabled}}.  It starts off and shows an example of every field before you save.  The switch stays in the page draft until you choose {{ui:settings.draft.save}} in the footer.  Choose {{ui:settings.draft.discard}} to restore the stored choice.  Nothing is sent automatically.  For a broken report, {{ui:feedback.hub.send}} shows the exact redacted JSON and asks an admin to confirm it is a software bug and safe to publish.

Only a random install ID, the description's fingerprint, version, platform, title, and redacted description go to the hub.  A version that isn't a release version goes as `custom`.  The text loses email addresses, URLs, network addresses, recognizable secrets, quoted values, and long numbers.  Redaction cannot recognize every personal detail, so read the preview.  Screenshots, sender details, page paths, and browser errors never go upstream.  The bug-report install ID is separate from the optional usage-count ID and stays the same for this server.

The hub stores the redacted text, first platform, versions seen, fingerprint, and count.  It files the first fingerprint as a public issue in `adachis/riosoma` with `bug` and `from-installs`, then combines later reports and adds at most one count-and-versions comment per UTC day.  The issue shows the description, version, platform, and fingerprint as code blocks, and each comment shows its count and versions the same way, so mentions, links, and formatting in a report stay plain text.

The hub accepts at most 10 reports per install per UTC day, and at most five reports a minute from one network address.  Past either limit, {{ui:feedback.hub.send}} fails with a message to try again later, and nothing is stored.  Across all installs, the hub files at most 20 new issues and posts at most 50 comments per UTC day.  A comment the cap holds back is added with a report on a later day.  Reports beyond the issue cap are stored with no issue URL yet.  A stored report gets its issue when a maintainer files it, or when another report with the same redacted description arrives on a later day with room under the cap.  A lost GitHub answer is held for maintainer review to avoid duplicate issues.  The inbox records the issue URL when the hub returns one.  Daily limit counters are removed on the next day's accepted report, while report history and weekly usage payloads stay until maintainers delete them.

Named credentials, including `access_token`, `refresh_token`, and `client_secret`, are removed from the preview and rejected by the hub if they arrive unredacted.  When an accepted report has no issue URL yet, the inbox marks it pending.  Choose {{ui:feedback.hub.refresh}} to check for its eventual issue URL.  Refreshing checks the original fingerprint without submitting another report, adding to its count, or creating another issue.

Your operator can set `RIOSOMA_HUB_URL` to another hub or `off` to block upstream bugs. With Compose, pass it through a local override file. Update checks and usage counts are separate: point `RIOSOMA_UPDATE_FEED_URL` and `RIOSOMA_TELEMETRY_URL` elsewhere, or turn them off with `RIOSOMA_UPDATE_CHECKS=off` and `RIOSOMA_TELEMETRY=off`.
