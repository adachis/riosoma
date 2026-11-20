---
id: org-units
title: Organizational units
summary: Give departments, schools, or regions their own people, their own admins, and stricter settings of their own.
area: administration
order: 6
level: advanced
related: [scim-provisioning, sign-in-policy, export-and-import]
routes: [/settings/org-units, /settings/*/org-units, /admin/*/org-units]
anchors: [settings.org.units]
sections: [settings.org.units=make-the-first-unit]
---

Organizational units are departments, schools, or regions inside the organization, arranged in a tree up to eight levels deep.  Each person is placed in one unit, or in none, which means the organization itself.  A unit can have admins of its own, who look after its people and its settings, and settings of its own, within limits the organization sets.

Units stay out of sight until someone makes the first one.  Until then, no unit filters, unit lists, or unit settings appear anywhere, for anyone.

## Make the first unit

The organization's owner, or an admin with the People role, makes the first unit.  Open the palette and search for {{ui:palette.cmd.orgUnits}}, then choose the plus button for {{ui:orgUnits.create}}, give the unit a name, and choose where it sits under {{ui:orgUnits.parent}}.  Once the first unit exists, {{ui:settings.nav.orgUnits}} is in {{ui:shell.nav.settings}} for the owner, every admin, and every unit admin.

Choose a unit in the tree to see its policy, its people, and its admins.  {{ui:orgUnits.edit}} renames a unit or moves it somewhere else in the tree.  The delete icon opens {{ui:orgUnits.delete.title}} to remove a unit: its people and the units below it move up to its parent, or to the organization, and its admins stop being admins.  Their roles are never passed up to the parent.

Long names shorten in the tree.  Point at a name to read it in full, or select the unit to read its complete name above its settings.

## Place people

Under {{ui:orgUnits.people.title}}, pick someone in {{ui:orgUnits.people.add}} and choose {{ui:orgUnits.people.place}}.  Placing someone in a unit moves them out of wherever they were.  The organization's owner is never placed in a unit, so no unit's settings can lock them out.

People lists, including {{ui:settings.nav.people}} and the people you can share a database with, can be narrowed with {{ui:orgUnits.filter}}.  Choosing a unit shows the people in it and in the units below it.

## Unit admins

Under {{ui:orgUnits.admins.title}}, pick a member, check the roles under {{ui:orgUnits.admins.roles}}, and choose {{ui:settings.draft.save}} in the save bar at the bottom of the page.  The roles are the same scoped roles the organization gives: People, Security, Data Sources, AI, Integrations, and Audit.  Saving no roles removes the admin.

A unit admin's roles reach the unit and every unit below it, and nothing else:

- They look after the people placed there.  They never reach the owner, anyone with an organization admin role, or another admin of their own unit or a unit above it.
- Their Security role reaches only databases that people in their units own on their own, and their Data Sources role only the sources those people made.  A database owned together with someone outside, or shared with everyone as its owner, gets no unit administration at all.
- Administering people never opens their work.  A unit admin sees a database only when it's shared with them, as anyone would.
- They can make units inside their own, but only an admin of a unit above can rename, move, or delete a unit, or choose its admins.  They can give or take away only the roles they hold above that unit, so nobody gives anyone more than they have.
- Deleting a unit takes, above it, every role an admin inside it holds, and the standing to remove each of its own values.  Moving a unit takes the standing to remove the values it leaves behind.  Either is refused unless the admin reaches everyone placed in the unit and in the units below it.
- A database filed in a folder leaves the folder it was in, so a unit admin can file only databases whose current folder is theirs to change too.
- The organization's own settings, other units, and everything outside their units stay out of reach.  Every admin screen checks this on the server, whatever the screen offers.

## Policy

A selected unit's {{ui:orgUnits.policy.title}} keeps its space while stored settings load.  Long explanations and {{ui:orgUnits.policy.allowedThemes}} scroll within their reserved areas, so the sections below stay in place.  Use Tab to reach an explanation or a theme choice, then use the arrow keys or Page Down to read more.

Each setting starts from the organization and passes down through every unit to the people in it.  A unit changes a setting only where the organization allows it, under {{ui:orgUnits.organization.title}}.  Each setting there has a box: {{ui:orgUnits.organization.overrideStricter}} for security settings, and {{ui:orgUnits.organization.overrideAny}} for preferences.  All of them start unchecked.

Choose the allowed themes under {{ui:orgUnits.policy.allowedThemes}} and a starting theme under {{ui:orgUnits.policy.defaultTheme}}, then use {{ui:settings.draft.save}} or {{ui:settings.draft.discard}}.  Choosing the current theme closes its picker and leaves that value unchanged.

| Setting | Who changes it | How a unit can change it |
|---|---|---|
| {{ui:orgUnits.policy.requireMfa}}, {{ui:orgUnits.policy.requireSso}} | Security | Only to require it |
| {{ui:orgUnits.policy.passwordMinLength}} | Security | Only longer |
| {{ui:orgUnits.policy.sessionMaxDays}}, {{ui:orgUnits.policy.sessionIdleDays}} | Security | Only shorter |
| {{ui:orgUnits.policy.publicLinks}}, {{ui:orgUnits.policy.externalSharing}}, {{ui:orgUnits.policy.calendarFeeds}}, {{ui:orgUnits.policy.reportOutsideRecipients}}, {{ui:orgUnits.policy.syncOut}}, {{ui:orgUnits.policy.automationSms}} | Security | Only to turn it off |
| {{ui:orgUnits.policy.guestInvitations}} | People | Only to turn it off |
| {{ui:orgUnits.policy.feedbackPublishing}} | Integrations | Only to turn it off |
| {{ui:orgUnits.policy.aiEnabled}}, {{ui:orgUnits.policy.aiFields}}, {{ui:orgUnits.policy.aiDiagnose}} | AI | Only to turn it off |
| {{ui:orgUnits.policy.allowedThemes}}, {{ui:orgUnits.policy.guestLevel}} | People | Only fewer themes, or a lower level |
| {{ui:orgUnits.policy.defaultTheme}}, {{ui:orgUnits.policy.defaultLevel}}, {{ui:orgUnits.policy.defaultLocale}} | People | Either way |

Under a unit's {{ui:orgUnits.policy.title}}, each setting says where its value comes from, such as {{ui:orgUnits.origin.organization}}, and why it can't change there when it can't.  Change what you may and choose {{ui:settings.draft.save}} in the save bar at the bottom of the page.  {{ui:orgUnits.inherit}} drops the unit's own value.  The organization sets its own values for sign-in, sharing, and themes on the same screen, and the rest on their own settings screens, such as AI and the sign-in policy.

Each value a unit sets remembers who set it: the organization, or the unit whose admin did.  Only an admin at that level or above can change or remove it, and clearing a unit's policy leaves every value set from above.  When the unit that set a value is deleted, or a move leaves it no longer above, the value counts as set by the nearest unit that was above it and remains, or by the unit it's on when none does.  It never becomes the organization's, so it reaches nobody new, admins who could change it still can, and the policy screen shows where it now comes from.

A unit's values apply only to the people its admins could act on themselves.  The owner, the organization's admins, and the admins of that unit or a unit above follow the organization's policy, and the values a level above them set.  So a unit admin can't reach anyone through policy they couldn't reach directly.

A setting the organization tightens later always wins over an older unit value that has become looser, and so does unchecking its box.  The unit's value stays saved but no longer applies, and the screen says so.

### How policy applies

- Everything is worked out again on each request, so a person who moves, or a setting that changes, applies at once.  A session longer or idler than the person's unit now allows ends, and so does one without a second step or single sign-on their unit now requires.  A session stops counting as proven that way once the person removes their last second step, or the provider they signed in through, or their link to it, is removed or turned off.
- Sessions can't be set shorter than a day, or to end after less than an hour idle.  The owner is held only to the server's own session limits.
- When a unit requires both single sign-on and a second step, a provider sign-in is followed by a Riosoma second step.  Single sign-on can be required only once the organization has an identity provider turned on, and the last one can't be turned off or deleted while it's required: turn the requirement off first.  If none is on anyway, such as after an import, the requirement waits, and the policy screens say so.  Guests are never held to single sign-on.
- Personal access tokens and apps' tokens stop working while their person's policy requires a second step or single sign-on they haven't set up.
- A password shorter than the person's minimum no longer signs them in.  A sign-in link or a passkey still does.  The owner is never held to a password length or single sign-on, so the organization always has a way in.
- Public links, forms, and booking pages pause while the person who shared them is somewhere public links are off, and work again when that changes.  Calendar feeds, reports to outside addresses, text messages from automations, and AI fields check the person behind them each time they run.

### Presets

Under {{ui:orgUnits.preset.title}}, choose {{ui:orgUnits.preset.open}}, {{ui:orgUnits.preset.balanced}}, {{ui:orgUnits.preset.strict}}, or {{ui:orgUnits.preset.regulated}}, and choose {{ui:orgUnits.preset.preview}} to see each change it would make.  Choose {{ui:orgUnits.preset.apply}} to stage the permitted changes, then choose {{ui:settings.draft.save}} in the bottom bar to store them.  {{ui:settings.draft.discard}} cancels the draft.  Anything a unit can't loosen stays as it is.

## Place people from the directory

Organization admins with both the Security and People roles can have provisioning place people by their department in the directory.  Under {{ui:orgUnits.mapping.title}}, map each department to a unit and choose {{ui:orgUnits.mapping.add}}.  Departments match whatever their case, and spaces around them don't count.

Once a mapping exists, provisioning decides the unit of everyone it manages, right away and whenever the directory changes them: a mapped department places them in its unit, and any other department, or none, takes them out of every unit.  Provisioning never fails because of it, and a directory that turns someone off always suspends them.  Their unit can't be changed by hand while mappings exist.  People the directory doesn't manage stay wherever an admin puts them.  Removing every mapping hands placement back to admins and leaves everyone where they are.

## Activity

{{ui:orgUnits.audit.title}} lists every change to units, placements, unit admins, and policies, with what each was before and after.  Organization admins with the Audit role see all of it.  A unit admin with the Audit role sees only what happened in their own units.

## Export and import

An organization archive carries the units, their policies, the organization's unit policy, each person's unit, and each person's unit admin roles.  People imported from an archive get their unit and their unit admin roles when they accept the invitation sent from the import review.  Organization admin roles never come back through an archive.

## Moving units by dragging

Drag a unit's named row onto another unit to change its parent.  Drop at the end of the tree to move it to the organization.  Units remain alphabetical within each parent.  With its move control focused, press Space, use Right to enter the unit above or Left to leave a parent, and press Space to drop.  Escape cancels.

The proposed move checks your authority, inherited policies, and tree depth before it can finish.  The message explains a refused move.  {{ui:common.undo}} reverses a completed move when the affected units have not changed again.
