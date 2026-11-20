---
id: passkeys-and-two-step-sign-in
title: Passkeys and two-step sign-in
summary: Sign in with your fingerprint, face, or screen lock, and protect your account with a second step and recovery codes.
area: account
order: 1
level: simple
related: [sign-in, sign-in-policy, single-sign-on]
routes: [/settings/security, /settings/*/security, /admin/*/security]
anchors: [settings.security]
sections: [settings.security=passkeys]
---

A password on its own can be guessed or stolen.  A second step protects your account even then: after your password, Riosoma also asks for something only you have, a passkey or a code from an app on your phone.  Someone who learns your password still can't sign in as you.

Set this up in {{ui:shell.nav.settings}}, then {{ui:mfa.nav.security}}.

## Passkeys

A passkey signs you in with your fingerprint, your face, or your device's screen lock, with no password to type.  Your device keeps the secret part of the passkey.  Riosoma keeps only a matching public part that can check it, so there's nothing stored on the server that anyone could use to sign in as you.

To add one, choose {{ui:mfa.settings.addPasskey}}, give it a {{ui:mfa.settings.passkeyNameLabel}} that tells your passkeys apart, such as "Work laptop", and follow your browser's prompts.  Many passkeys are kept by your phone's or computer's password manager, which shares them with your other devices.  Add one on each device that doesn't share them.

Each passkey shows when you added it and when you last used it.  The rename icon opens {{ui:mfa.settings.renameTitle}}, and the remove icon offers {{ui:mfa.settings.remove}}.  Each icon has a tooltip that includes the passkey’s name.

To sign in with a passkey, choose {{ui:mfa.signIn.passkey}} on the sign-in page, or pick it from the suggestions under the email field when your browser offers it.  A passkey is a whole sign-in on its own, so it never asks for a second step.

If your server's address doesn't use https, the page says "{{ui:mfa.settings.passkeysOff}}"  In a browser that can't use passkeys, it says "{{ui:mfa.settings.passkeysUnsupported}}"  Either way, an authenticator app works instead.

## Authenticator apps

An authenticator app on your phone shows a new six-digit code every 30 seconds.  To set one up:

1. Choose {{ui:mfa.settings.appSetUp}}.
2. Scan the QR code with the app.  If you can't scan it, type the {{ui:mfa.app.secretLabel}} shown under it into the app instead.
3. Type the code the app shows into {{ui:mfa.app.code}} and choose {{ui:mfa.app.turnOn}}.

You can have one authenticator app at a time.  Each code works once, and only for a minute or so.

## The second step

Once you have a passkey or an authenticator app, signing in with a password or an emailed link takes one more step.  Riosoma shows {{ui:mfa.step.title}} and asks for your passkey, or for a code from your app.  The choices under it switch to another way, such as {{ui:mfa.step.otherRecovery}}.  {{ui:mfa.step.startOver}} goes back to the sign-in page.

You have 10 minutes to finish.  Wrong codes count toward the same limit as wrong passwords, as {{doc:sign-in}} describes.

Single sign-on, such as with a Google or Microsoft account, doesn't use Riosoma's second step.  That account's own sign-in handles it.

## Recovery codes

Recovery codes are for the day your phone is lost or your passkey is out of reach.  Riosoma makes 10 of them when you add your first passkey or authenticator app.  Each one works once, in place of a second step.

Riosoma shows the codes only once, right then.  It keeps only a scrambled copy of each, the way it keeps your password.  A scrambled copy can check a code you type, but it can't be turned back into the code, so nobody, not even an administrator, can look the codes up later.  Save them before you close the window: {{ui:mfa.codes.copy}} copies them, and {{ui:mfa.codes.download}} saves them in a text file.  Keep them somewhere safe and apart from your phone, such as a password manager or a printed page.

{{ui:mfa.nav.security}} shows how many codes you have left.  {{ui:mfa.settings.newCodes}} makes a fresh set of 10 and stops the old ones working, so use it when you're running low, or if you think someone else has seen them.

A code looks like `7kq2m-x9d4f`.  When you type one, capitals, spaces, and the hyphen don't matter.

## Removing a second step

{{ui:mfa.settings.remove}} takes a passkey off your account, and {{ui:mfa.settings.appOff}} turns off the authenticator app.  Turning off the app, or removing your last second step, first asks you to confirm it's you with a passkey, an app code, or a recovery code.  That way, someone at a computer you left signed in can't take your protection away.

## When your organization requires it

Your organization may require a second step of its administrators, or of everyone.  If you need one and don't have one, the next time you sign in, Riosoma shows {{ui:mfa.enroll.title}} and asks you to add a passkey or an authenticator app before you go on, then shows your recovery codes.  Settings reminds you too: "{{ui:mfa.settings.required}}"

## If you lose your second step

Sign in with a recovery code.  If you've lost those too, ask an administrator to reset your second steps.  That clears your passkeys, your app, and your codes, so you can sign in with your password and set up new ones.

## Passwords and sessions

Open {{ui:mfa.nav.security}}, then {{ui:auth.sessions.title}}, to see your active sessions.  Each row shows its browser, system, approximate last activity, and sign-in method.  Older sessions may show {{ui:auth.sessions.method.unknown}} because the server did not record their method.  {{ui:auth.sessions.current}} marks the session you are using now.  Choose {{ui:auth.sessions.signOut}} to end one session, or {{ui:auth.sessions.endOthers}} to keep only the current one.  Ended sessions cannot make another request, and their live connections close.

Under {{ui:auth.reset.save}}, enter your current password and a new one.  {{ui:auth.sessions.endOthers}} starts selected.  Keep it selected to end your other sessions when you change the password, or clear it to keep them.  A forgotten-password reset always ends every earlier session, including the one that requested it.  It keeps your second steps required.

You can bookmark `/settings/account/security/sessions` and `/settings/account/security/password` to return to these controls.
