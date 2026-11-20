---
id: custom-domains
title: Custom domains for public pages
summary: Publish forms, view links, booking pages, signing pages, and sites on a domain your organization controls.
area: administration
order: 6
level: advanced
related: [scim-provisioning]
routes: [/settings/custom-domains, /settings/*/custom-domains, /admin/*/custom-domains]
anchors: [settings.custom.domains]
sections: [settings.custom.domains=add-and-verify-a-host]
---

An organization owner or administrator with the Integrations role manages domains in {{ui:shell.nav.settings}} → {{ui:customDomains.title}}.  Your server operator must first configure a proxy that accepts custom hosts and manages HTTPS certificates.  See [Custom domain installation](../../../install/custom-domains.md).

## Add and verify a host

1. Enter a plain {{ui:customDomains.host}}, such as `forms.example.org`, of up to 237 characters.  Do not enter a URL, port, or wildcard.
2. Choose {{ui:customDomains.forms}}, {{ui:customDomains.views}}, {{ui:customDomains.bookings}}, {{ui:customDomains.signing}}, and {{ui:sites.kind}} as needed.  All but {{ui:sites.kind}} are selected initially, and at least one must remain selected.
3. Choose {{ui:customDomains.add}}, then {{ui:settings.draft.save}} in the save bar at the bottom of the page.  Add the displayed {{ui:customDomains.txtName}} and {{ui:customDomains.txtValue}} to your DNS provider.
4. Point the host at {{ui:customDomains.target}} using {{ui:customDomains.targetType}}.  Ask your server operator for the proxy's public address when an apex domain needs an A or AAAA record instead of a CNAME.
5. Wait for DNS to update, then choose {{ui:customDomains.verify}}.  Another organization on this instance cannot verify the same host while yours holds it.

Your pages don't appear on a host until it's verified.  Until then, visiting it opens Riosoma's main site, as any other name pointed at the server does.  Your organization can have up to 50 domains added at once, unless your server operator set a different limit.

Keep the TXT record published.  Riosoma checks it daily, and a failed check leaves the domain serving while it tries again the next day.  After three failed checks in a row the domain stops, and the owner and Integrations administrators get a notification.  A domain also stops if more than a day passes without a check.  Correct the DNS record and verify again to restore it.  Changing the selected page kinds stays in the page draft until you choose {{ui:settings.draft.save}} in the save bar.

## Public links

New links use the earliest-added verified domain that serves their page kind.  If none qualifies, links use the main Riosoma address.  Bookings use the chosen domain for cancellation links, and signature invitation emails use the signing domain.

Visitors are always anonymous on a custom domain.  Their Riosoma session does not grant access there.  The domain serves only your organization's public pages, and unrelated routes return 404.  A password-protected view still asks for its password and keeps access only for the open tab.

## Remove a domain

Choose {{ui:customDomains.remove}} and confirm.  Its pages stop immediately, and new links fall back to another eligible domain or the main address.  Ask your operator to remove any explicit proxy mapping, Kubernetes Ingress entry, and unused certificate.  Adding, verifying, failing verification, changing page kinds, and removing domains are recorded in the audit log.

A domain assigned to a published site serves that site at its root.  Its other public page kinds become unavailable while it is assigned, so a new domain serves no site until you select {{ui:sites.kind}}.  Only the owner or an administrator with the Integrations role assigns a domain to a site, from {{ui:sites.publish}} in an interface they can share.  Anyone else who publishes the site again keeps the domain it has.  Each domain can serve one site.  Unpublishing the site releases its domain at once, and clearing {{ui:sites.kind}} here stops the domain serving a site without touching the site itself.
