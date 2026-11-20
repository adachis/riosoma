---
id: drivers
title: Installing source drivers
summary: Review a vendor license and install a pinned driver on your instance.
area: data-sources
order: 15
level: advanced
anchors: [sources.drivers, settings.source.drivers]
related: [connections]
routes: [/settings/source-drivers, /settings/*/source-drivers, /admin/*/source-drivers]
sections: [settings.source.drivers=installing-drivers]
---

## Installing drivers

Open {{ui:settings.nav.sources}} in settings, then {{ui:sources.drivers.title}}.  Owners and administrators with the Data Sources role can install and remove drivers.  An installed driver is shared by every organization on the instance.

Choose {{ui:sources.drivers.review}}, read the full license, and select {{ui:sources.drivers.accept}} only when you have authority to accept it.  {{ui:sources.drivers.install}} records your identity, the license text’s hash, and the time in the audit log before the server downloads anything.  A changed license must be accepted again.

The server installs only catalog artifacts whose bytes match their pinned hashes.  Package scripts never run.  A platform that cannot load a driver cannot install it.  An installed driver runs with the server’s own access to its files, which is why only these vendor drivers can be installed.

Before downloading, the server checks that there’s room for the unpacked driver, and says how much it needs when there isn’t.  Once an update is installed, the version it replaced is removed, as soon as no sync or test that started with it is still running.

For an air-gapped instance, choose {{ui:sources.drivers.offline}} and supply every archive listed, including the driver’s runtime libraries.  Use the exact versions shown.  Each archive uploads on its own and is checked against its hash as it arrives, and then goes through the same archive checks as a download.

{{ui:sources.drivers.remove}} removes the driver from persistent storage.  Sources using it then report a missing driver.  An available catalog update appears here after upgrading Riosoma.  Installation records and existing drivers survive application upgrades when the deployment retains its driver volume.

An operator can set `RIOSOMA_DRIVER_INSTALLS=off` to refuse both downloads and uploads.  Already installed drivers continue working and can still be removed.

Db2 and Informix run on x86-64 Linux servers and on Macs with Apple silicon.  Their driver brings IBM’s own client, from IBM’s download folder, and the driver’s native add-on for this server, both checked against pinned hashes.  IBM ships no client for Linux on arm64, so on an arm64 Linux server the driver shows as unsupported and can’t be installed.
