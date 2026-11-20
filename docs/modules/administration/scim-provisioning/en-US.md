---
id: scim-provisioning
title: Provisioning people and groups
summary: Connect Okta or Microsoft Entra to create, update, suspend, and group people automatically.
area: administration
order: 5
level: advanced
related: [single-sign-on, saml-single-sign-on, sign-in-policy]
routes: [/settings/scim, /settings/*/scim, /admin/*/scim]
anchors: [settings.scim]
sections: [settings.scim=prepare-the-connection]
---

SCIM 2.0 lets your identity provider manage people and groups.  An organization owner or administrator with the Security role configures it in {{ui:shell.nav.settings}} → {{ui:scim.title}}.  Each token reaches one organization.  Provisioning creates ordinary members without administrative roles and gives them addresses only on the organization's verified domains.  It takes over an existing member only as the section on people outside provisioning describes, and never the owner, a guest, or someone another organization shares.

## Prepare the connection

The lists under {{ui:scim.tokens}}, {{ui:scim.unmanaged}}, and {{ui:scim.domains}} keep their height while saved entries load.  Scroll within a list to reach additional entries.  With the list focused, the arrow keys and Page Down scroll it, and Tab moves to its controls.

1. Configure the organization's single sign-on connection and its allowed email domains.
2. Under {{ui:scim.domains}}, select that connection, enter an allowed domain, and choose {{ui:scim.challenge}}.  Publish the displayed TXT record in the domain's DNS, and choose {{ui:scim.verifyDomain}}.  Generate a new challenge if more than one day passes before verification.  Verify every domain your people's addresses use: provisioning refuses an address on any other domain, or on a domain its connection no longer lists or that's turned off, with a 400 error that names the domain.  Only one organization on the server can verify a domain, and a second is refused with a message saying so.
   Keep the TXT record published.  Riosoma checks every verified domain daily and shows how many checks in a row failed.  After three failed checks in a row the domain is no longer verified, and the organization's owner and Security administrators are notified.  Publishing the same record again within a day, and choosing {{ui:scim.verifyDomain}}, verifies it again.
3. Give the provisioning token a descriptive name, choose {{ui:scim.create}}, and save the token in your provider.  It is shown once.  The list shows who created each token and when it was last used, and {{ui:scim.rotate}} immediately replaces a token.  {{ui:scim.revoke}} immediately disables it.  A token stops working when the person who created it is suspended or removed, with an audit event for each such token, so create the token as someone who will stay.
4. Copy {{ui:scim.baseUrl}} exactly as displayed.  The service lives under `/scim/v2` on your Riosoma server.  Use the server's public HTTPS address.
5. Consider enabling {{ui:scim.dryRun}} while checking mappings.  Proposed changes appear in the audit log under the token's name, and the response has an `X-SCIM-Dry-Run` header.  No people, groups, sessions, or memberships change.  Token usage and audit records are still saved.  A previewed account does not exist for later requests, so turn dry run off before testing a complete provisioning cycle.

The first single sign-on links a provisioned person by email only when the provider verifies the email, email linking is enabled, and that connection's domain has been verified for the organization.  Later sign-ins use the provider's issuer and subject.  An unverified domain refuses the first link with an explanation on the sign-in screen.  A sign-in whose email the provider didn't verify gets the same no-account answer whoever holds the address, so it reveals nothing about who is provisioned or suspended.

## Okta

In your application's provisioning integration, enable SCIM and supply these fields:

| Okta field | Value |
|---|---|
| SCIM connector base URL | The displayed {{ui:scim.baseUrl}} |
| Unique identifier field for users | `userName` |
| Authentication mode | HTTP Header |
| Authorization | The token shown when you created it |

Test the connection, enable creating users, updating user attributes, and deactivating users, and assign a test person.  Enable group push for the groups you want Riosoma to manage.  Okta first probes for an existing person with a `userName eq` filter and sends group membership changes through PATCH.

See Okta's [SCIM integration guide](https://developer.okta.com/docs/guides/scim-provisioning-integration-prepare/main/) for the provider's setup requirements.

## Microsoft Entra

Open the enterprise application's Provisioning page and select Automatic provisioning:

| Entra field | Value |
|---|---|
| Tenant URL | The displayed {{ui:scim.baseUrl}} |
| Secret Token | The token shown when you created it |

Test the connection, review the attribute mappings, assign a test person and group, and start provisioning.  Entra's default mappings work as they are: userName from the user principal name, and the work email from mail.  Riosoma also accepts Entra's capitalized operation names, its booleans sent as the strings `"True"` and `"False"`, and the attributes it sends that Riosoma doesn't store, such as titles and phone numbers, which it ignores.

See Microsoft's [SCIM provisioning guide](https://learn.microsoft.com/entra/identity/app-provisioning/use-scim-to-provision-users-and-groups) for the provider's setup requirements.

## Attribute mappings

| SCIM attribute | Riosoma field or behavior |
|---|---|
| `userName` | The directory's login name, such as a user principal name.  It's unique in the organization without regard to case, and `userName` filters match it |
| `emails` | The primary address, else the `work` address, else `userName` when it's an address, is the person's email.  It must be on a domain verified for the organization |
| `displayName` | Person's displayed name |
| `name.givenName`, `name.familyName`, `name.formatted` | Stored profile names, used for the displayed name when displayName is absent |
| `externalId` | Directory identifier, preserved and unique within the organization and resource type |
| `active` | False suspends immediately and revokes sessions, API tokens, calendar feed addresses, and the provisioning tokens the person created.  True restores the account, requiring a new sign-in, new API tokens, and new feed addresses.  Null, a PUT that leaves it out, and a PATCH that removes it keep the person as they are |
| Enterprise `department`, `employeeNumber` | Read-only profile fields under {{ui:scim.profile}}, shown to members and administrators but never to guests |
| Enterprise `manager` | A person's Riosoma ID in the same organization, sent as `manager.value` or as the bare ID |
| Group `displayName` | Group name, unique within the organization without regard to case |
| Group `members[].value` | IDs of people this directory provisioned.  `members[].type`, when sent, is `User` in any case |

People and groups show {{ui:scim.managed}} in {{ui:settings.nav.people}}.  Their provisioned fields are read-only.  Use a database's sharing dialog to assign a group role.  In {{ui:scim.folders}}, place databases in a folder and assign group roles that apply to each database.  Changing a folder requires sharing permission on all affected databases.  Only the organization's owner, and people in a group the folder makes an owner, can change a folder's group roles.  A database's sharing dialog lists the roles its folder gives, read-only, with the folder's name.  Group roles never reach guests.  Identity-provider membership changes immediately change the access these roles provide.

Provisioning can suspend or delete any person it manages, including administrators.  It never changes the organization's owner, who is never a provisioned person, and answers 409 for any attempt.  While a person is suspended, the public view links and public forms they shared answer 410 Gone, and a form takes no answers.  They work again if the person is reactivated.  The link's or form's share settings show it paused and name the person, and someone else who may share it can choose {{ui:shareView.shareAgain}}, which keeps the same address and makes them its sharer.

Deleting a person suspends them by default, keeping their data and ownership.  {{ui:scim.deleteAction}} can instead remove the account and its grants.  Removing an account does not delete its databases or records.  Before the account goes, each database only that person owned, with no other owner directly or through a group or folder, gets the organization's owner as its owner, with an audit event for each.  Their public links and forms stop for good.  Deleting a group removes its membership and grants, while preserving people and data.

A deleted person stops appearing in SCIM reads.  Reprovisioning restores that same person, preserving ownership, only when the directory sends the same `externalId`, or when neither the request nor the deleted account has an `externalId` and the email matches.  A request that reuses a suspended person's `userName` with a different `externalId` answers 409 with `uniqueness` and a detail saying the name belongs to a deactivated account, so a new directory identity never gets another person's account.  Remove that account in {{ui:settings.nav.people}} before the name can be used again, as the next section describes.  Setting `active` to `true` after a PATCH deactivation also restores access, but previously revoked sessions and API tokens remain revoked.

## Removing a deactivated account

The organization's owner and People administrators can remove the account of a deactivated person provisioning manages, whether the directory deleted or deactivated them.  In {{ui:settings.nav.people}}, choose {{ui:people.remove}} beside the person and confirm.  It does what a directory's delete does when {{ui:scim.deleteAction}} removes accounts: the person's access and the provisioning tokens they created end, each database only they owned gets the organization's owner as its owner, their public links and forms stop for good, and the account goes, while their records stay.  The audit log records `people.account.removed` naming the administrator.  Their `userName` is free afterward, so the directory can create the new identity.  Active people, the organization's owner, members provisioning doesn't manage, and accounts another organization shares can't be removed this way.  Removal can't be undone.

## People outside provisioning

{{ui:scim.unmanaged}} lists the members who joined by invitation or single sign-on and aren't managed by provisioning.  Suspending or deleting them in the identity provider doesn't reach them in Riosoma.  When the provider creates a person whose email is one of these members' addresses, on a verified domain, provisioning takes that member over instead of answering 409: the same account, with its data and access, is managed from then on, and the audit log records `scim.users.adopted`.  The owner, guests, and people another organization shares are never taken over.

## Protocol and troubleshooting

Every endpoint requires the bearer token, including discovery.  Requests and responses support `application/scim+json`.  Lists use one-based `startIndex` and `count`, with a maximum of 1,000 results per page.  User filters support `userName`, `externalId`, `emails.value`, and `displayName`, with `eq`, `co`, `sw`, `pr`, `and`, `or`, and parentheses, and value paths such as `emails[type eq "work"].value eq "alex@example.com"`.  Group filters support `displayName`, `externalId`, and `members[value eq "..."]`.  Identifiers compare exactly, and names and emails compare without regard to case.  Reads and writes honor `attributes` and `excludedAttributes`, such as `excludedAttributes=members`.

PATCH ignores attributes Riosoma doesn't store, as POST and PUT do, and ignores `id`, `meta`, and `schemas` in a replace without a path.  A replace of a complex attribute, such as `name` or the enterprise extension, changes only the sub-attributes it names and leaves the rest unchanged, as RFC 7644 section 3.5.2.3 describes.  A multi-valued attribute replaced without a filter is replaced whole.  The value filters in one PATCH may make at most 1,000,000 comparisons, counted as operations times values times comparisons, and a PATCH past that answers 400 with `invalidValue`.  A replace whose filter matches nothing answers 400 with `noTarget`.  An add or remove whose filter matches nothing succeeds, and an add such as `emails[type eq "work"].value` creates the value it names.

Duplicate values return 409 with `uniqueness`.  Invalid filters, values, and paths return 400, as do NUL characters and unpaired surrogates anywhere in a request.  Resources outside the token's organization return 404.  Invalid or revoked tokens return 401.  Each token allows 120 requests per minute, with a 429 response and `Retry-After` header when that limit is reached.  Bulk requests, sorting, password changes, nested groups, and ETags are not supported, as the discovery response reports where applicable.

The protocol follows [RFC 7643](https://www.rfc-editor.org/rfc/rfc7643) and [RFC 7644](https://www.rfc-editor.org/rfc/rfc7644).  Provider field labels may change, so consult the provider's provisioning documentation if its console differs.
