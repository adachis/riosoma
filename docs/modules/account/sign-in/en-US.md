---
id: sign-in
title: Signing in and out
summary: Sign in with a password, an emailed link, a passkey, or another account, and sign out when you're done.
area: account
order: 0
level: simple
anchors: [auth.signIn]
related: [setup, single-sign-on, passkeys-and-two-step-sign-in]
---

## With a password

Enter your email address and password, then choose {{ui:auth.signIn.submit}}.

After 10 wrong passwords or second-step codes in 15 minutes, Riosoma pauses sign-ins for that email address for a little while.  The pause protects your account from someone guessing.  Wait, then try again, or sign in with a link instead.

## With an emailed link

Choose {{ui:auth.link.request}} and enter your email address.  Riosoma sends a link that signs you in once and expires after 15 minutes.  If you didn't ask for one, you can ignore the email.  This option appears only when the server can send email.

If you started from a link to a page in Riosoma, signing in takes you back to that page.  An emailed sign-in link keeps that destination even when you open it in another browser.  Addresses on other sites are refused.

## With a passkey

If you've added a passkey, choose {{ui:mfa.signIn.passkey}}, or pick your passkey from the suggestions under the email field when your browser offers it.  Then use your fingerprint, your face, or your device's screen lock.  There's no password to type, and no second step.  This option appears only when the server supports passkeys.

## The second step

If you've added a passkey or an authenticator app, signing in with a password or an emailed link takes one more step: Riosoma asks for your passkey, or for a code from your app.  {{doc:passkeys-and-two-step-sign-in}} explains how to add one, and what to do if you lose it.

## With another account

If your organization set it up, the sign-in page has a button for each other way to sign in, such as with a Google or Microsoft account.  Choose one, sign in there, and you come back to Riosoma signed in.  The first time, Riosoma connects that account to your Riosoma account when both use the same email address, or makes you a new account if your administrator allows it.

If the page says "{{ui:sso.noAccount}}", there's no Riosoma account for you yet.

## Signing out

Choose {{ui:shell.signOut}} at the top of the screen.  Your session on that device ends right away, and going back in the browser won't reopen it.

Sessions also end on their own after 7 days without use, and after 30 days no matter what.  Your administrator may set different limits.

If a session ends while you are working, {{ui:auth.session.resumeTitle}} opens over your page.  Sign back in with your password or passkey, then submit your changes again.  Your unsaved input stays on the page.  For an emailed link or another account provider, choose {{ui:auth.session.anotherTab}}, finish signing in there, and return to choose {{ui:auth.session.check}}.  Signing in as a different person or organization reloads the page to keep accounts separate.

Grid edits stay visible while you sign back in.  Riosoma checks your database access again before you can save them.  Choose {{ui:database.save.retry}} to save the waiting changes, or make your next edit to save them together.  Signing in alone does not send those edits.

## Forgotten passwords

Choose {{ui:auth.reset.forgot}} on the sign-in page, enter your email address, and choose {{ui:auth.reset.send}}.  The screen gives everyone the same answer.  If your account uses a password, the email opens {{ui:auth.reset.title}}.  The link works once, expires in 30 minutes, and is replaced by a newer request.  You can paste a password.  Passwords can be up to 1,024 characters long, and longer passwords are refused without truncating them.

Using a reset link ends every earlier session for your account.  Sign in again afterward.  Your passkeys, authenticator app, and recovery codes still apply.  Riosoma emails you a notice when your password changes.  Contact your organization’s administrator if you did not request the reset or make the change.

If your account uses only your organization’s sign-in, the email points you there.  If password reset is turned off, contact an administrator.  Deactivated accounts receive no email.

When email is not set up, the screen explains both ways back in.  An administrator with People access can create a one-time link for another person.  If you are the only owner and cannot sign in, the server operator can run the recovery command described in {{doc:sign-in-policy}}.
