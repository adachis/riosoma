---
id: profile
title: Your profile
summary: Change your display name, picture, and confirmed email address.
area: account
order: 2
level: simple
related: [sign-in, people-roles-and-lifecycle]
routes: [/settings/profile, /settings/*/profile, /admin/*/profile]
anchors: [settings.profile]
sections: [settings.profile=edit-your-name-and-picture]
---

## Edit your name and picture

Open {{ui:settings.nav.profile}} in {{ui:shell.nav.settings}}.  Update {{ui:profile.name}}, then choose {{ui:settings.draft.save}} in the bottom bar.  {{ui:settings.draft.discard}} restores your saved profile.  The page is also available at [Profile](/settings/profile), and settings search finds your name, picture, and email controls.

Use {{ui:profile.picture.upload}} to choose a PNG, JPEG, or WebP under 2 MB.  In {{ui:profile.crop.title}}, adjust {{ui:profile.crop.horizontal}}, {{ui:profile.crop.vertical}}, and {{ui:profile.crop.zoom}} with the keyboard or pointer.  Choose {{ui:profile.crop.use}}, then save the page.  {{ui:profile.picture.remove}} stages removal.  Without a picture, your initials appear.

Saved changes reach open pages, including presence, comments, mentions, history, and sharing.  Pictures are normalized to square PNGs and served only to people allowed to read your identity.  Your installation's upload and virus-scanning policies still apply.

Fields your organization manages show {{ui:profile.field.managed}} and cannot be edited here.  Ask your administrator to change them in your directory or sign-in provider.

## Change your email address

Your {{ui:profile.email}} is read-only.  If email delivery is available and your organization does not manage it, choose {{ui:profile.email.change}}, enter {{ui:profile.email.new}}, and choose {{ui:profile.email.send}}.  Open the emailed link while signed in as the same person, then choose {{ui:profile.email.confirm}}.  The link expires after 15 minutes and works once.  Requesting another link replaces the old one.

Your existing address stays in use until confirmation succeeds.  Your old address receives a notice after the change.  If email changes are unavailable, contact your administrator.

A name-only save offers {{ui:people.actions.undo}} while the saved name and picture remain unchanged.  Picture changes have no undo because the previous bytes are removed.
