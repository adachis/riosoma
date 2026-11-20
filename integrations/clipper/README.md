# Riosoma browser clipper

The Manifest V3 extension saves the current page's title, URL, selected text, and an optional screenshot of its visible area.  It uses an existing table and explicit field mapping.  It creates no table or migration.

## Build and load

1. Run `pnpm --filter @riosoma/clipper build` from the repository root.  One build works with every Riosoma server, so nothing about your server goes into it.
2. In Chrome's extensions page, enable developer mode, choose Load unpacked, and select `integrations/clipper/dist`.
3. For Firefox, copy `dist/manifest.firefox.json` over `dist/manifest.json`.  Open the browser's debugging page, choose This Firefox, then Load Temporary Add-on, and select that manifest.  Rebuild before loading the Chrome version again.
4. Open the extension on a regular web page.  Copy the displayed redirect address into a public OAuth app in Riosoma settings.  Each browser installation needs its own exact redirect address.  Allow `schema.bases:read`, `data.records:read`, and `data.records:write`.
5. Enter your Riosoma address and the app ID, then choose Sign in.  The address uses HTTPS, or `http://127.0.0.1` and a port for local development.  The first time, the browser asks to let the clipper reach that address.  If the popup closes while it asks, open it again and choose Sign in.
6. Choose the database and table, and map title, URL, and selected text to three distinct writable text fields.  Map the screenshot to an attachment field if needed.  Choose Save page.

The selection is captured when the popup opens.  You can edit it before saving.  A screenshot is captured only when Save page is selected, and only if the original tab and URL are still active.  Internal browser pages cannot be clipped.  Use Open record to review the saved record.  Closing and reopening the popup starts a new clip.

## Permissions and privacy

`activeTab` grants temporary access to the page opened through the extension action.  `scripting` is required to read its selected text.  `storage` saves the address, destination, and app ID locally and tokens in session storage.  `identity` performs OAuth with fresh S256 PKCE, state, issuer, and exact callback checks.  The background process completes sign-in if the popup closes.  Closing the browser ends the local session.  Sign out also revokes its grant.

The extension asks for no website access when it's installed.  Sign in asks for the one address you entered, through the browser's optional host permission prompt, and nothing is sent there until you allow it.  Chrome grants that address and port.  Firefox match patterns can't carry a port, so Firefox grants that host on any port.  The background process sends tokens only to the address that issued them and only on the API paths the clipper uses.  Changing the address ends the session.

The CSP allows bundled scripts and styles, prohibits remote code and inline scripts, and allows connections only over HTTPS or to `127.0.0.1`.  A content security policy can't name an IPv6 address, so the clipper doesn't accept `[::1]`.  No browsing history, clipboard, persistent content script, or general website permission is requested.  No client secret is stored.

Screenshot uploads stage bytes through the bearer-authenticated file route, using existing field checks, scanning, limits, and storage.  The record is then created through the command bus with the uploaded attachment ID.  A failed upload creates no record.  A failed record write can leave an unattached file for the server's existing cleanup.  An uncertain network result is not automatically retried.  Check the table before retrying a save whose response was lost.

Record writes inherit authorization, audit events, reader-specific realtime updates, and undo.  Existing API, MCP, and Rio record tools can read or change the resulting record within the same access rules.

## Language and theme

The popup follows the browser's language when the app has a translation, and uses American English otherwise.  Its strings are Lingui messages in the app's own catalogs, and the build takes the store name and description in `_locales` from the same catalogs.  The popup wears the app's default theme through the `--rio-*` contract, in the theme's dark color scheme when the system prefers dark.  Theme fonts aren't bundled, so text uses the theme's fallback system fonts.

## Navigation and accessibility

The destination and field mappings have a `#clip?...` link.  Help uses `#help`.  Neither link contains credentials or page contents.  Every control has a label, status updates use a live region, Enter in a field does not submit the clip, and the layout fits a 320-pixel viewport.  Preferences are not rewritten merely because a stored destination is no longer visible.

## Tests

Run `pnpm --filter @riosoma/clipper test` for popup logic, addresses and host permissions, both manifests, PKCE, callbacks, refresh rotation, upload failures, languages, and destination links.  Run `pnpm --filter @riosoma/e2e exec playwright test tests/w-clipper.spec.ts --config clipper.config.ts` for the built extension in Chromium.  The spec loads a copy of the build with the test server's address already granted, since a headless browser can't show the permission prompt, and checks the popup's own request.  It uses the real background process and network requests, and supplies browser capture and OAuth window results locally.  It requires no account and makes no sound.

## Release checks

- Load the Chrome build and the Firefox build.  In each, sign in to an HTTPS server and to `http://127.0.0.1` with a port, and save a page with a screenshot.
- Confirm Firefox loads `manifest.firefox.json` without warnings.  The build already refuses a Firefox match pattern that carries a port.
- Store signing and publishing to either store wait for the owner.
