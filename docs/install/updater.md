# Updates and the updater

Riosoma checks a signed feed of releases once a day and tells the owner and admins when a newer one is out, with its notes, in the app.  With Docker Compose, the optional updater lets the owner update from Settings in one click.  Everywhere else, the notice shows the exact steps for your kind of install, the same ones as its guide's upgrade section.

## The update feed

The server fetches `RIOSOMA_UPDATE_FEED_URL` (`https://hub.riosoma.com/updates.json` unless set) once a day, and whenever an admin asks.  Checking sends nothing about the server.  The feed is signed with Ed25519, and the server trusts it only when:

- a key this release carries signed it.  The feed names its key, and a release can carry more than one, so the key can change without a gap.
- it was signed in the last 14 days.
- it's no older than the last feed the server trusted, so an old copy can't be replayed.

Anything else is ignored, and Settings, Updates says why.  Each release in the feed names its version, date, notes, whether it's a security release, the oldest version that can update straight to it, and its image digest for `linux/amd64` and `linux/arm64`.

A release with no signing key trusts no feed, so it shows no notices, and Settings, Updates says so.

The Riosoma hub serves the newest `updates.json` uploaded by a release to its feed bucket, with a five-minute public cache and an ETag. It holds no signing key and changes none of the signed bytes. Until the first feed is uploaded, it answers 404.

Release maintainers sign a payload with `node tools/sign-feed.mjs payload.json updates.json key-id`. The private Ed25519 key comes only from `RIOSOMA_FEED_SIGNING_KEY`, as PKCS#8 PEM, base64url PKCS#8 DER, or a raw 32-byte base64url seed. The tool writes the envelope and never prints the key. Public verification keys are distributed separately with server and updater releases.

To keep the server from reaching out at all, set `RIOSOMA_UPDATE_CHECKS=off`.  To serve the feed from somewhere else, such as a mirror inside your network, copy it unchanged and point `RIOSOMA_UPDATE_FEED_URL` at the copy.  The signature still has to verify.

`RIOSOMA_INSTALL_METHOD` decides which steps the notice shows.  The Compose file and the Helm chart set it, and the server recognizes the cloud platforms and plain Docker by itself.

## The updater (Docker Compose)

The updater is a small service in `deploy/updater/`, with no dependencies beyond Node, that runs from the Riosoma image beside the server.  It talks to the Docker Engine API over the Docker socket, and Riosoma talks to it over an internal Compose network the two share with nothing else, with a token the two share.

When the owner chooses a release, Riosoma records the update, then hands the updater the signed feed, the version, and the update's ID.  The updater trusts nothing else it's told, and takes one update at a time.  It checks the feed itself:

- Its signature, with the updater's own copy of the keys.
- That it was signed in the last 14 days, and no earlier than the newest feed the updater has already trusted, which it keeps in the `updater-state` volume.  An old feed replayed can't bring back a release a later feed withdrew.
- That the version asked for is the one the server would choose: the newest release this version can update to directly, and a prerelease only for a server that already runs one.

Then it checks that the backup service's database holds the update Riosoma just recorded, so `BACKUP_DATABASE_URL` names Riosoma's database and not another one.  If any of this fails, nothing changes, and Settings, Updates says why.  Then it:

1. Pulls the release's image for this machine's platform by its digest, from the registry `RIOSOMA_IMAGE` names, and checks the image is that release.  The image names its connector service's image by digest in its `io.riosoma.connectors.digest` label, which the feed's digest vouches for, so the updater pulls that one too, from the registry the running connector service came from, and checks it's the same release.  If the Compose file has no connector service yet, the update stops here, with nothing changed, and Settings, Updates says to update the Compose file first.
2. Stops Riosoma.
3. Backs up the database with the backup service, into the `backups` volume like the nightly dumps.
4. Replaces the connector service with its new image, keeping its settings, networks, and volumes, and waits for it to answer `/healthz` with the new version.  It keeps no data, so it needs no backup of its own.
5. Starts the new image with the old container's settings, networks, and volumes, and asks it for `/healthz` from inside the container until it answers with the new version, for up to `UPDATER_HEALTH_SECONDS` (600 unless set).  Only that answer counts.  Docker's own health status is left out, since it can call a new version unhealthy while a large database's migrations are still running.
6. Removes the old containers, and writes the new images to `RIOSOMA_IMAGE` and `RIOSOMA_CONNECTORS_IMAGE` in `.env`, pinned by digest, so the next `docker compose up -d` keeps them.
7. Replaces itself with the same new image, so the keys and fixes a release brings reach the updater too.

If the new version doesn't answer in time, the updater removes it, puts the old connector service back, restores the backup, and starts the old container again.  If something stops the update before the new version has started, such as Docker refusing to rename the old container, nothing is restored, since the database hasn't changed: the old container simply starts again, and the update is reported as failed with the reason.  The app shows each step while it runs, and every check, update, and rollback goes in the audit log.

If the updater runs an older release than Riosoma, for example because replacing itself failed, Settings, Updates says so and shows the steps to update by hand instead of the button.  `docker compose up -d` brings the updater up to date, since it runs the image `RIOSOMA_IMAGE` names.

### Turn it on

The updater needs the `backup` profile, since every update starts with a backup.  Add a token to `.env` and both profiles:

```bash
cd riosoma/deploy/compose
echo "RIOSOMA_UPDATER_TOKEN=$(openssl rand -hex 32)" >> .env
# Then add backup and updater to COMPOSE_PROFILES in .env, as in COMPOSE_PROFILES=postgres,caddy,backup,updater
docker compose up -d
```

Settings, Updates then shows whether the updater is ready, or what it's missing: the backup service, the Docker socket, or a Compose folder it can write to.  If you chose the database during setup rather than in `.env`, set `BACKUP_DATABASE_URL` to it, or the updater refuses to update, since the backups would miss Riosoma's database.

### What it can reach

The Docker socket gives whatever holds it full control of the machine, so the updater runs as root in its container, sits alone with Riosoma on the internal `updater` network, away from PostgreSQL, ClamAV, and the backup service, and answers only requests that carry `RIOSOMA_UPDATER_TOKEN`.  It reaches the backup service through the Docker socket, not the network.  It never pulls anything but the digest a signed feed names, from the registry your running image came from, and it takes nothing from Riosoma but the version, the update's ID, the schema it's recorded in, and the signed feed.  It mounts the Compose folder to update `.env`, and keeps its current job and the newest feed's time in the `updater-state` volume.

The first `docker compose up -d` after an update restarts Riosoma and the updater once, since Compose sees containers it didn't make itself.

### If an update stops halfway

If the updater itself stops in the middle, for example because the machine restarted, it reports the update as interrupted and does nothing more.  Check where things stand, and finish by hand:

```bash
docker compose ps -a                        # stopped ...-before-... containers are the old versions
docker compose run --rm --entrypoint ls backup -l /backups   # the newest dump is the one taken before the update
docker compose up -d                        # starts the image .env names
```

If the new version won't start, restore the backup taken before the update and set `RIOSOMA_IMAGE` and `RIOSOMA_CONNECTORS_IMAGE` back, as [Upgrades, backups, and rollbacks](upgrades.md) and [Docker Compose](docker-compose.md#upgrades) show, and remove any container named `riosoma-...-before-...` or `connectors-...-before-...` once the old version is running.

### Testing with your own feed

To try the updater end to end before a release is out, sign a feed with an Ed25519 key you make for the test, and have both sides trust that key instead of the ones the release carries.  These two settings are for testing only.  Never set them on a server people use, since whoever holds a key they name can offer that server any image.

- `RIOSOMA_UPDATE_FEED_KEYS_FILE`, on the Riosoma service, names a JSON file of keys in the format of `deploy/updater/feed-keys.json`: a list of `{ "id", "publicKey" }`, each public key its 32 bytes in base64url.  The server won't start if the file can't be read or holds anything else.
- `UPDATER_FEED_KEYS_FILE`, on the updater service, names the same file for the updater.

The Compose file passes neither, so set them, and mount the file into both containers, in a `compose.override.yaml` next to it.  The updater copies both containers' settings and mounts when it replaces them, so the test keys last through an update.

## Anonymous usage counts

The owner can also turn on anonymous usage counts, during setup or in Settings, Usage counts, which shows the exact JSON before they choose.  Only counts go, weekly, to `RIOSOMA_TELEMETRY_URL`: the version, the install method, databases and tables by size range, which features are on, and roughly how often each was used that week, in ranges such as 10 to 99.  They carry a random install ID, made when the owner turns counts on and deleted when they turn them off.  Set `RIOSOMA_TELEMETRY=off` to keep them off whatever the owner chooses.

The hub stores only that payload, one row per install ID and week. Sending the same week again replaces its row. It stores no request IP or headers. Maintainer statistics show totals for the completed week, versions, install methods, and feature counts behind a secret bearer token. The payload has no operating-system field; the platform summary uses install methods. Point `RIOSOMA_TELEMETRY_URL` at your own receiver to keep counts elsewhere.

Bug reports use a separate, off-by-default organization setting in Feedback. The hub receives a random install ID, a fingerprint of the redacted description, version, platform, title, and redacted description. It stores the text, fingerprint, platforms, versions seen, report count, and daily limit counters, and files public issues in `adachis/riosoma` with the `bug` and `from-installs` labels. Screenshots and sender details never go to the hub. Set `RIOSOMA_HUB_URL=off` to block this path, or point it at another hub. Together with `RIOSOMA_UPDATE_CHECKS=off` and `RIOSOMA_TELEMETRY=off`, this turns off all three upstream paths.
