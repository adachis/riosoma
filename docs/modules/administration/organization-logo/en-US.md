---
id: organization-logo
title: Your organization's logo
summary: Show your own logo while keeping the platform identity clear.
area: administration
order: 7
level: standard
anchors: [branding.settings.logo, settings.organization.appearance]
related: [themes, org-units]
routes: [/settings/organization-appearance, /settings/*/organization-appearance, /admin/*/organization-appearance]
sections: [settings.organization.appearance=choosing-the-organization-logo]
---

## Choosing the organization logo

Owners and administrators with the People role can open {{ui:branding.settings.title}} and choose {{ui:branding.settings.upload}}.  Use an SVG or PNG no larger than 256 KB.  SVGs are checked before storage, and files with scripts, external references, or unsupported active content are refused with a reason.

Choose {{ui:branding.settings.compact}} for narrow screens.  {{ui:branding.settings.match}} draws the logo in the current theme's ink color.  {{ui:branding.settings.keep}} preserves its colors on a theme surface.  Preview both light and dark surfaces before choosing {{ui:settings.draft.save}}.  {{ui:settings.draft.discard}} restores the stored logo, and {{ui:branding.settings.remove}} restores Riosoma's logo after saving.

Use a transparent PNG with {{ui:branding.settings.match}}.  For a logo with a solid background, choose {{ui:branding.settings.keep}}.

Your logo appears in the shell, on the sign-in screen when the installation has one organization, and while the app loads.  A quiet Riosoma mark stays in the footer and beneath the sign-in card.  Help, documentation, setup, updates, and errors retain Riosoma's identity.  Rio always uses the Riosoma mascot.

Logo changes are audited and can be undone while their stored state still matches the change.  Organization archives include the logo and compact mark, and check them again during import.
