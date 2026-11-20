# Source driver storage

Admin-installed drivers, for Teradata, Db2, and Informix, load in the server itself, not in the connector service, which carries only the drivers Riosoma ships.  They live in `RIOSOMA_DRIVERS_DIR`.  When unset, this is the `drivers` folder inside `RIOSOMA_CONFIG_DIR`, normally `/config/drivers`.  Only the server exposes installation routes.  Workers load installed code from that same directory.

Compose keeps `/config/drivers` in the existing persistent config volume.  The Helm chart mounts its persistent config claim at `/config`, so its drivers survive restarts and upgrades too.  Keep persistence enabled when using drivers.  Multiple replicas and separate workers must mount the same storage, with ReadWriteMany when they run on different nodes.

## What an installed driver can reach

An installed driver is the vendor's own code, and it runs with the server's file access.  It can read whatever the server's account can read, including `/config`, which holds the sealed database profile and, when `RIOSOMA_SECRET_KEY` isn't set, the secret key that unseals it, and on Linux the server process's own settings.  It can also write to the drivers folder.  That is why Riosoma installs only the vendor drivers in its catalog, at the exact versions and hashes the catalog pins, and never anything an administrator names.  Riosoma has no separate account for drivers.  An instance that must keep vendor code away from its secrets should leave `RIOSOMA_DRIVER_INSTALLS=off`.

Each connection runs its driver in a separate process that starts with only the program path, language, and time zone.  For Db2 and Informix it also gets `IBM_DB_HOME` and the system's library path, both pointing at the IBM client installed with the driver, plus `DB2CLIINIPATH` and `DB2DSDRIVER_CFG_PATH` when the server has them, for an administrator's own client configuration.  An `IBM_DB_HOME` set on the server is ignored, so a driver never loads another copy of IBM's client.  No `RIOSOMA_` setting reaches it, and its temporary files and home folder are a private folder removed when it stops.  Whatever the driver says in an error has the source's secrets and every secret the server holds taken out before a test step or sync shows it.

## How much space drivers need

A driver takes its unpacked size for its one active version.  Teradata's catalog version unpacks to about 279 MiB: 197 MiB for `teradatasql` and 82 MiB for `koffi`, as the npm registry records them.  IBM's driver for Db2 and Informix unpacks to about 127 MiB on x86-64 Linux and 64 MiB on a Mac with Apple silicon, most of it IBM's client.  While an update installs, the new version sits beside the old one, and one archive of at most 96 MiB waits to be unpacked, so a Teradata update briefly needs about 654 MiB in all and an IBM update about 351 MiB.  Before downloading, Riosoma checks that the drivers folder has room for the new version's unpacked size plus 96 MiB, about 375 MiB for Teradata and 224 MiB for IBM on Linux, and refuses with both amounts when it doesn't.  An offline upload checks for its own size plus the driver's unpacked size.

Once an update is active, Riosoma removes the version it replaced, so only one version of each driver stays on disk.  A sync or test already connected with the old version keeps it until that connection closes, or until the server next starts, and then it goes too.  At start, the server also removes anything an install left when the server stopped part way, such as an unfinished version, a downloaded or uploaded archive, or a manifest that never took effect.

The Helm chart's default 1Gi claim holds both drivers and an update of either, about 781 MiB at the most.  Raise `persistence.size` before installing more drivers, allowing each driver's unpacked size plus room for the largest one's update.

## IBM's client for Db2 and Informix

Db2 and Informix use `ibm_db`, which loads IBM's Data Server Driver for ODBC and CLI through a native add-on.  Installing it takes, for the server's own platform only:

- the `ibm_db` package and the three small packages it loads, from the npm registry, checked against the registry's hashes
- IBM's client, v12.1.4, from IBM's own download folder, checked against the SHA-256 recorded when the catalog pinned it
- the package's prebuilt add-on for that platform, taken out of the `build.zip` inside the package the way `ibm_db`'s own installer takes it, and checked against its own pinned SHA-256

No package script runs and nothing is compiled.  The few links inside IBM's archive, like `libdb2.so` naming `libdb2.so.1`, are written as copies of the file they name in the same folder, and any other link refuses the archive.

| Platform | Client archive | SHA-256 |
| --- | --- | --- |
| x86-64 Linux (`linux-x64`) | `v12.1.4/linuxx64_odbc_cli.tar.gz` | `77b754d19be2cd5c55f6feb8bd951c2b17aa6646289944855612c5a2ac555f55` |
| Mac with Apple silicon (`darwin-arm64`) | `v12.1.4/macarm64_odbc_cli.tar.gz` | `188adacc6a6efd2381f5315bac16b42f0c719ea8c2fce0a1f7a8950e68f84011` |

Both archives are under `https://public.dhe.ibm.com/ibmdl/export/pub/software/data/db2/drivers/odbc_cli/`.  IBM has replaced files in these folders in place before.  If it does again, the hash no longer matches and the install refuses until a Riosoma release pins the new file.  An offline install uploads the `ibm_db` package, its three dependencies, and the one client archive for the server's platform, and the Drivers screen lists exactly those.

IBM ships no client for Linux on arm64, and the other platforms IBM ships aren't pinned here, so on an arm64 Linux server, or any other platform, the Drivers screen shows IBM's driver as not supported by this server's platform and its install button stays off.  A Db2 or Informix source there reports a missing driver.  Run Riosoma on x86-64 Linux for Db2 and Informix.

IBM's client writes its diagnostic log and a small cache inside its own folder in the drivers folder, `db2dump` and `cfgcache`, so that folder has to stay writable by the runtime's user, as it is by default.

IBM's connection string reads each value as written up to the next semicolon and has no way to escape one, so a Db2 or Informix password, user, or database name with a semicolon can't be sent.  The source's test says so at its authentication step, before the driver starts.

## Offline installs

An air-gapped instance uploads each archive the catalog lists, one request per archive, and then installs from them.  Each upload streams to disk as it arrives, hashed and counted on the way.  It stops at the first byte past 96 MiB, and a hash other than the catalog's leaves nothing behind.  One upload may take up to 15 minutes.  Uploaded archives serve the next install and are removed with it, whatever its result, and at the server's next start.

## Locks

Only one install, upload, or removal of a driver runs at a time.  Each takes a lock, a `.<driver>.lock` folder in the drivers folder that records the host, process, and time that took it.  A lock whose process has stopped, including one from before the server restarted after a crash, is taken over by the next change, or by the server as it starts.  A lock from another host, or one whose owner can't be read, is taken over once it's an hour old, which is longer than any install or upload can run.  No shell is needed to clear a lock.  A server restarted in the same container or pod clears the one its earlier run left as it starts, and any other lock clears itself after the hour.

## Backups and upgrades

Include the entire driver directory and the application database in backups.  The directory holds versioned artifacts and an atomic active manifest.  The database’s audit log records license acceptance, installation, and removal.  Stop installs during backup so these remain consistent.  Preserve ownership for the runtime’s nonroot user when restoring.  Never populate the directory with unreviewed code.

Set `RIOSOMA_DRIVER_INSTALLS=off` to block installation and updates, including offline uploads.  The existing drivers still load.  The runtime image contains no driver packages, package manager, or compiler.

The Dockerfile copies IBM’s supporting shared libraries from a pinned Debian 13 stage into the Debian 13 distroless runtime.  It retains the nonroot user and adds no executables.  The eight libraries add about 2.5 MiB to the image.  Installing IBM’s driver inside the built x86-64 image, then testing and reading Db2 and Informix sources from it, works with nothing else added.
