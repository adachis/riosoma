# Riosoma test fleet

Riosoma syncs data from many databases and services.  This directory defines a
local fleet of real ones so the connector tests run against the engines they
will meet in production.  Everything is Docker Compose, everything is pinned,
and nothing is reachable from anywhere but this machine.

The fleet is large on purpose.  A 16 GB Colima virtual machine cannot carry all
of it at once, so every service lives behind its own profile, and the profiles
are grouped by family.  Start one service, one family, or the two or three
profiles a test needs, and stop them again.

## Prerequisites

Colima, or any Docker Engine on Linux, with about 16 GB of memory and 60 GB of
disk.  On Apple Silicon, Rosetta support has to be on, because several engines
publish amd64 images only.

```sh
colima start --cpu 6 --memory 16 --disk 60 --vm-type vz --vz-rosetta
```

Elasticsearch and OpenSearch refuse to start when the virtual machine kernel
limits mapped memory.  Set it once per virtual machine, then restart Colima.

```sh
colima ssh -- sudo sysctl -w vm.max_map_count=262144
```

The validator needs PyYAML.

```sh
pip3 install --break-system-packages pyyaml
```

## Starting and stopping

Start one service and wait for its healthcheck.

```sh
docker compose -f ops/test-fleet/compose.yaml --profile postgres16 up -d --wait
```

Start a whole family.

```sh
docker compose -f ops/test-fleet/compose.yaml --profile search up -d --wait
```

Stop it.  Add `-v` to throw the data away as well.

```sh
docker compose -f ops/test-fleet/compose.yaml --profile search down
docker compose -f ops/test-fleet/compose.yaml --profile search down -v
```

List the profiles, or check what a profile would start.

```sh
docker compose -f ops/test-fleet/compose.yaml config --profiles
docker compose -f ops/test-fleet/compose.yaml --profile sql config --services
```

Three things are worth knowing before the first run.

- Several engines are slow the first time they boot.  Db2, Informix, SeaTable,
  and ClamAV all need minutes rather than seconds.  Give `up --wait` a longer
  budget with `--wait-timeout 900`.
- Dependencies come along automatically.  Starting `pgbouncer` starts
  `postgres16`, starting `teable` starts `teable-db` and `teable-cache`, and
  starting `druid-router` does not start the rest of Druid, so use the `druid`
  profile for that.
- Profiles are sized to run a few at a time.  The Druid and Cosmos profiles
  alone want about three to four gigabytes each.

## Layout

```
ops/test-fleet/
  compose.yaml                 every service, profile, port, and limit
  validate.py                  the checker, see Validation below
  README.md                    this file
  .env.example                 license variables, empty by default
  keycloak/realm.json          one realm, one client, two users
  kong/kong.yaml               declarative config for database-less Kong
  pgcat/pgcat.toml             pgcat pool in front of postgres17
  pgbouncer/userlist.txt       credentials PgBouncer authenticates against
  prometheus/prometheus.yml    scrape config
  samba/config.yml             one SMB share and one SMB user
  searxng/settings.yml         SearXNG settings with the JSON format enabled
  trino/catalog/*.properties   Trino catalogs, tpch and postgres17
  webdav/htpasswd              credentials for the WebDAV server
```

## Credentials

One fixed pair of test values covers almost the whole fleet.

- User: `riosoma_test`
- Password: `Riosoma-Test-2026!`
- Database or bucket: `riosoma_test`, except where a service rejects the name

Nothing here is a secret, and none of it may ever point at anything real.  The
exceptions are listed per service in the tables below.  They exist because an
image hardcodes a name, uses a well-known emulator key, or has no place to set
a password at all.

## Services

The Profile column lists every profile that starts the service.  The first one
is always named after the service itself.  Ports are published on `127.0.0.1`
only, and `host→container` means the host port on the left.

### SQL

| Profile | Image | Ports on 127.0.0.1 | Credentials | Memory | Architecture | License variable | Notes |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `postgres14`, `sql` | `postgres:14.24` | 15432→5432 | riosoma_test / Riosoma-Test-2026!, db riosoma_test | 512 MB | arm64 native | - | oldest release Riosoma still connects to |
| `postgres15`, `sql` | `postgres:15.19` | 15433→5432 | riosoma_test / Riosoma-Test-2026!, db riosoma_test | 512 MB | arm64 native | - | second oldest supported release |
| `postgres16`, `sql` | `postgres:16.15` | 15434→5432 | riosoma_test / Riosoma-Test-2026!, db riosoma_test | 512 MB | arm64 native | - | the release PgBouncer fronts |
| `postgres17`, `sql` | `postgres:17.11` | 15435→5432 | riosoma_test / Riosoma-Test-2026!, db riosoma_test | 512 MB | arm64 native | - | the release pgcat and Trino front |
| `postgres18`, `sql` | `postgres:18.6` | 15436→5432 | riosoma_test / Riosoma-Test-2026!, db riosoma_test | 512 MB | arm64 native | - | volume mounts at /var/lib/postgresql, the 18 image moved PGDATA |
| `pgbouncer`, `sql` | `pgbouncer/pgbouncer:1.25.2-20260920` | 15437→6432 | riosoma_test / Riosoma-Test-2026!, db riosoma_test | 128 MB | arm64 native | - | transaction pooling in front of postgres16 |
| `pgcat`, `sql` | `ghcr.io/postgresml/pgcat:v1.2.0` | 15438→6432 | riosoma_test / Riosoma-Test-2026!, pool riosoma_test | 256 MB | arm64 native | - | transaction pooling in front of postgres17 |
| `mysql84`, `sql` | `mysql:8.4.11` | 13306→3306 | root and riosoma_test / Riosoma-Test-2026!, db riosoma_test | 1 GB | arm64 native | - | long term support release |
| `mysql97`, `sql` | `mysql:9.7.2` | 13307→3306 | root and riosoma_test / Riosoma-Test-2026!, db riosoma_test | 1 GB | arm64 native | - | innovation release |
| `mariadb11`, `sql` | `mariadb:11.8.9` | 13308→3306 | root and riosoma_test / Riosoma-Test-2026!, db riosoma_test | 768 MB | arm64 native | - | long term support release |
| `mssql2022`, `sql` | `mcr.microsoft.com/mssql/server:2022-CU27-ubuntu-22.04` | 11433→1433 | sa / Riosoma-Test-2026! | 2 GB | amd64 through Rosetta | ACCEPT_EULA | needs two gigabytes and Rosetta |
| `oracle`, `sql` | `gvenzl/oracle-free:23.26.3-slim-faststart` | 11521→1521 | SYSTEM and riosoma_test / Riosoma-Test-2026!, service FREEPDB1 | 2 GB | arm64 native | - | faststart build, first boot is still slow, plain TCP only (see the caveats) |
| `db2`, `sql` | `icr.io/db2_community/db2:12.1.5.0` | 15000→50000 | db2inst1 / Riosoma-Test-2026!, db riosoma | 3 GB | amd64 through Rosetta | LICENSE | privileged mode, three gigabytes, first boot takes minutes |
| `informix`, `sql` | `icr.io/informix/informix-developer-database:15.0.1.0.3` | 19088→9088 | informix / in4mix, the image default | 1536 MB | amd64 through Rosetta | LICENSE | privileged mode, first boot takes minutes |
| `firebird5`, `firebird`, `sql` | `firebirdsql/firebird:5.0.4` | 13050→3050 | SYSDBA and riosoma_test / Riosoma-Test-2026!, db /var/lib/firebird/data/riosoma_test.fdb | 512 MB | arm64 native | - | the official image, arm64 from 5.0 on (its 3.0 and 4.0 tags are amd64 only), wire encryption required |

### Warehouse and analytics

| Profile | Image | Ports on 127.0.0.1 | Credentials | Memory | Architecture | License variable | Notes |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `clickhouse`, `warehouse` | `clickhouse/clickhouse-server:25.8.33.6-alpine` | 18123→8123, 19000→9000 | riosoma_test / Riosoma-Test-2026!, db riosoma_test | 2 GB | arm64 native | - | native protocol on 19000, HTTP on 18123 |
| `trino`, `warehouse` | `trinodb/trino:483` | 18081→8080 | no authentication, user riosoma_test, catalogs tpch and riosoma_postgres | 2 GB | arm64 native | - | queries postgres17 through the riosoma_postgres catalog |
| `druid-zookeeper`, `druid`, `warehouse` | `zookeeper:3.9.5` | internal only | no authentication | 512 MB | arm64 native | - | internal only, Druid needs it |
| `druid-coordinator-overlord`, `druid`, `warehouse` | `apache/druid:37.0.0` | internal only | no authentication | 1 GB | amd64 through Rosetta | - | internal only |
| `druid-broker`, `druid`, `warehouse` | `apache/druid:37.0.0` | internal only | no authentication | 1 GB | amd64 through Rosetta | - | internal only |
| `druid-historical`, `druid`, `warehouse` | `apache/druid:37.0.0` | internal only | no authentication | 1536 MB | amd64 through Rosetta | - | internal only |
| `druid-middlemanager`, `druid`, `warehouse` | `apache/druid:37.0.0` | internal only | no authentication | 1 GB | amd64 through Rosetta | - | internal only, peons are separate JVMs |
| `druid-router`, `druid`, `warehouse` | `apache/druid:37.0.0` | 18888→8888 | no authentication | 512 MB | amd64 through Rosetta | - | the only published Druid port, console and query API |

### NoSQL, time series, and monitoring

| Profile | Image | Ports on 127.0.0.1 | Credentials | Memory | Architecture | License variable | Notes |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `mongodb`, `nosql` | `mongo:8.0.32` | 17017→27017 | riosoma_test / Riosoma-Test-2026!, authSource admin | 1 GB | arm64 native | - | standalone node, no replica set |
| `dynamodb`, `nosql` | `amazon/dynamodb-local:3.3.1` | 18000→8000 | any access key and secret, region us-east-1 | 1 GB | arm64 native | - | shared database file, so tables do not split by account |
| `cosmos`, `nosql` | `mcr.microsoft.com/cosmosdb/linux/azure-cosmos-emulator:vnext-EN20260907` | 18082→8081 | well-known emulator account and key | 3 GB | arm64 native | - | HTTP mode, switch PROTOCOL to https-insecure for the .NET and Java SDKs |
| `firestore`, `nosql` | `google/cloud-sdk:586.0.0-emulators` | 18083 | no authentication, project riosoma-test | 1 GB | amd64 through Rosetta | - | emulator data is temporary, it is discarded on restart |
| `couchbase`, `nosql` | `couchbase:community-8.0.2` | 18091→8091, 18092→8092, 18093→8093, 18094→8094, 18095→8095, 18096→8096, 11210 | Administrator / Riosoma-Test-2026!, bucket riosoma_test | 2 GB | arm64 native | - | SDKs also need the container address, see the caveats |
| `couchbase-init`, `couchbase`, `nosql` | `couchbase:community-8.0.2` | internal only | no authentication | 256 MB | arm64 native | - | one-shot job, it initializes the cluster and the bucket |
| `couchdb`, `nosql` | `couchdb:3.5.2` | 15984→5984 | riosoma_test / Riosoma-Test-2026! | 512 MB | arm64 native | - | single node mode is applied by couchdb-init |
| `couchdb-init`, `couchdb`, `nosql` | `couchdb:3.5.2` | internal only | no authentication | 256 MB | arm64 native | - | one-shot job, it creates the system databases |
| `neo4j`, `nosql` | `neo4j:5.26.31-community` | 17474→7474, 17687→7687 | neo4j / Riosoma-Test-2026! | 1536 MB | arm64 native | - | heap and page cache are capped to fit the limit |
| `influxdb2`, `nosql` | `influxdb:2.9.1` | 18086→8086 | riosoma_test / Riosoma-Test-2026!, org riosoma, bucket riosoma_test, token riosoma-test-influxdb-token | 1 GB | arm64 native | - | first boot runs setup and writes the fixed token |
| `influxdb3`, `nosql` | `influxdb:3.11.5-core` | 18181→8181 | no authentication | 1 GB | arm64 native | - | core reads only data written in the last 72 hours |
| `prometheus`, `nosql` | `prom/prometheus:v3.15.0` | 19090→9090 | no authentication | 512 MB | arm64 native | - | scrapes itself and both InfluxDB services |

### Search

| Profile | Image | Ports on 127.0.0.1 | Credentials | Memory | Architecture | License variable | Notes |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `elasticsearch`, `search` | `elasticsearch:8.19.22` | 19200→9200 | elastic / Riosoma-Test-2026! | 1536 MB | arm64 native | - | security on, transport TLS off |
| `opensearch`, `search` | `opensearchproject/opensearch:3.8.0` | 19201→9200 | no authentication | 1536 MB | arm64 native | - | security plugin off, plain HTTP |
| `meilisearch`, `search` | `getmeili/meilisearch:v1.54.0` | 17700→7700 | master key Riosoma-Test-2026! | 1 GB | arm64 native | - | master key doubles as the API key |
| `typesense`, `search` | `typesense/typesense:30.2` | 18108→8108 | api key Riosoma-Test-2026! | 1 GB | arm64 native | - | admin key doubles as the API key |

### Object storage and file protocols

| Profile | Image | Ports on 127.0.0.1 | Credentials | Memory | Architecture | License variable | Notes |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `minio`, `storage` | `bitnamilegacy/minio:2025.7.23-debian-12-r5` | 19100→9000, 19101→9001 | riosoma_test / Riosoma-Test-2026!, bucket riosoma-test | 512 MB | arm64 native | - | frozen public build, see the caveats |
| `azurite`, `storage` | `mcr.microsoft.com/azure-storage/azurite:3.37.0` | 20000→10000, 20001→10001, 20002→10002 | devstoreaccount1 and the well-known Azurite key | 512 MB | arm64 native | - | blob, queue, and table on 20000 through 20002 |
| `fakegcs`, `storage` | `fsouza/fake-gcs-server:1.56.1` | 14443→4443 | no authentication, bucket riosoma-test | 512 MB | arm64 native | - | HTTP only, bucket riosoma-test exists on first boot |
| `sftp`, `storage` | `atmoz/sftp:debian@sha256:75dcc29683ad479bdb99010666f2f55e99014350a1e862fe32b565845feb0fcd` | 12222→22 | riosoma_test / Riosoma-Test-2026!, home /home/riosoma_test | 256 MB | amd64 through Rosetta | - | pinned by digest, the publisher ships rolling tags |
| `webdav`, `storage` | `rclone/rclone:1.75.1` | 18090→8090 | riosoma_test / Riosoma-Test-2026! | 128 MB | arm64 native | - | rclone serves WebDAV, PROPFIND included |
| `ftp`, `storage` | `stilliard/pure-ftpd:trixie-1.0.50` | 12121→21, 30000-30009 | riosoma_test / Riosoma-Test-2026!, home /home/riosoma_test | 256 MB | amd64 through Rosetta | - | passive range 30000 through 30009 is published too |
| `samba`, `storage` | `crazymax/samba:4.23.8` | 14445→445 | riosoma_test / Riosoma-Test-2026!, share riosoma | 256 MB | arm64 native | - | clients connect with -p 14445 |

### Identity

| Profile | Image | Ports on 127.0.0.1 | Credentials | Memory | Architecture | License variable | Notes |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `keycloak`, `identity` | `quay.io/keycloak/keycloak:26.7.4` | 18180→8080 | riosoma_admin / Riosoma-Test-2026!, realm riosoma-test, client riosoma-test-client, users riosoma.reader and riosoma.writer | 1536 MB | arm64 native | - | imports keycloak/realm.json on first boot |
| `authentik`, `identity` | `ghcr.io/goauthentik/server:2026.8.3` | 19443→9443 | akadmin / Riosoma-Test-2026! | 1 GB | arm64 native | - | HTTPS on 19443, health checks use the internal HTTP port |
| `authentik-worker`, `authentik`, `identity` | `ghcr.io/goauthentik/server:2026.8.3` | internal only | no authentication | 1 GB | arm64 native | - | no port, health check inspects the process table |
| `authentik-postgres`, `authentik`, `identity` | `postgres:16.15-alpine` | internal only | riosoma_test / Riosoma-Test-2026!, db authentik, internal only | 512 MB | arm64 native | - | internal only |
| `authentik-redis`, `authentik`, `identity` | `redis:8.6.7-alpine` | internal only | no password, internal only | 128 MB | arm64 native | - | internal only |

### Secrets and gateway

| Profile | Image | Ports on 127.0.0.1 | Credentials | Memory | Architecture | License variable | Notes |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `vault`, `secrets` | `hashicorp/vault:1.21.4` | 18200→8200 | token riosoma-test-root-token | 256 MB | arm64 native | - | dev mode, in-memory, nothing persists |
| `openbao`, `secrets` | `openbao/openbao:2.7.0` | 18201→8200 | token riosoma-test-root-token | 256 MB | arm64 native | - | dev mode, in-memory, nothing persists |
| `kong`, `secrets` | `kong:3.9.3` | 18800→8000, 18801→8001 | no authentication, admin API on 18801 | 512 MB | arm64 native | - | database-less, declarative config in kong/kong.yaml |

### Mail, scanning, and automation

| Profile | Image | Ports on 127.0.0.1 | Credentials | Memory | Architecture | License variable | Notes |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `mailpit`, `mail` | `axllent/mailpit:v1.31.3` | 11025→1025, 18026→8025 | no authentication | 256 MB | arm64 native | - | 18025 is taken on the host, so SMTP is 11025 |
| `clamav`, `mail`, `misc` | `clamav/clamav:1.4.6-debian13-slim` | 13310→3310 | no authentication | 1536 MB | arm64 native | - | downloads signatures on first boot, allow five minutes |
| `searxng`, `misc` | `searxng/searxng:2026.9.25-12f8b6515` | 18889→8080 | no authentication, JSON through ?format=json | 512 MB | arm64 native | - | settings.yml enables the JSON output format |
| `n8n`, `misc` | `n8nio/n8n:1.123.82` | 15678→5678 | owner account created on first run | 1 GB | arm64 native | - | secure cookies off, the fleet is plain HTTP |

### Migration sources

| Profile | Image | Ports on 127.0.0.1 | Credentials | Memory | Architecture | License variable | Notes |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `teable`, `migration-sources` | `teableio/teable:release.2026-09-27T02-14-26Z.3273` | 13000→3000 | no default login, first run creates the account | 1 GB | arm64 native | - | pinned to a build tag, Teable publishes no release tags |
| `teable-db`, `teable`, `migration-sources` | `pgvector/pgvector:0.8.6-pg16-trixie` | internal only | riosoma_test / Riosoma-Test-2026!, db teable, internal only | 512 MB | arm64 native | - | pgvector build, Teable migrations expect the extension |
| `teable-cache`, `teable`, `migration-sources` | `redis:8.6.7-alpine` | internal only | no password, internal only | 128 MB | arm64 native | - | internal only |
| `baserow`, `migration-sources` | `baserow/baserow:2.3.1` | 13001→80 | admin@riosoma.test / Riosoma-Test-2026! | 2 GB | arm64 native | - | all-in-one image, it runs its own PostgreSQL |
| `nocodb`, `migration-sources` | `nocodb/nocodb:2026.09.0` | 13002→8080 | admin@riosoma.test / Riosoma-Test-2026! | 1 GB | arm64 native | - | calendar version tag, SQLite storage |
| `grist`, `migration-sources` | `gristlabs/grist:1.7.19` | 13003→8484 | single user mode, no sign-in | 1 GB | arm64 native | - | formulas run unsandboxed, gVisor does not work in Colima |
| `seatable`, `migration-sources` | `seatable/seatable-developer:6.2.1` | 13004→80 | admin@riosoma.test / Riosoma-Test-2026! | 1536 MB | amd64 through Rosetta | - | first boot initializes the database and takes minutes |
| `seatable-db`, `seatable`, `migration-sources`, `sql` | `mariadb:10.11.19-ubi9` | 13309→3306 | root / Riosoma-Test-2026! | 512 MB | arm64 native | - | the MariaDB release SeaTable documents |
| `seatable-memcached`, `seatable`, `migration-sources` | `memcached:1.6.45` | internal only | no authentication, internal only | 384 MB | arm64 native | - | aliased as memcached inside the fleet network |

## Port plan

Every port is published on `127.0.0.1` and nothing else.  The plan gives each
family a range, and the first table below groups those ranges.

| Range | Family |
| --- | --- |
| 11025, 18026 | Mailpit, because 18025 was already taken on the host |
| 11210, 18091-18096 | Couchbase data port and its six service ports |
| 11433 | SQL Server |
| 11521 | Oracle Database Free |
| 12121, 30000-30009 | FTP control and passive data ports |
| 12222 | SFTP |
| 13000-13004 | Teable, Baserow, NocoDB, Grist, and SeaTable |
| 13050 | Firebird |
| 13306-13309 | MySQL 8.4, MySQL 9.x, MariaDB 11.x, and the MariaDB SeaTable uses |
| 13310 | ClamAV |
| 14443 | fake-gcs-server |
| 14445 | Samba |
| 15000 | Db2 |
| 15432-15438 | PostgreSQL 14 through 18, PgBouncer, and pgcat |
| 15678 | n8n |
| 15984 | CouchDB |
| 17017 | MongoDB |
| 17474, 17687 | Neo4j browser and Bolt |
| 17700 | Meilisearch |
| 18000 | DynamoDB Local |
| 18081 | Trino |
| 18082 | Cosmos DB emulator |
| 18083 | Firestore emulator |
| 18086, 18181 | InfluxDB 2 and InfluxDB 3 Core |
| 18090 | WebDAV |
| 18108 | Typesense |
| 18123, 19000 | ClickHouse HTTP and native protocol |
| 18180 | Keycloak |
| 18200, 18201 | Vault and OpenBao |
| 18800, 18801 | Kong proxy and admin API |
| 18888 | Druid router |
| 18889 | SearXNG |
| 19088 | Informix |
| 19090 | Prometheus |
| 19100, 19101 | MinIO API and console |
| 19200, 19201 | Elasticsearch and OpenSearch |
| 19443 | Authentik |
| 20000-20002 | Azurite blob, queue, and table |

Five collisions came out of the original plan, and the winner stayed put in
every case.

- Trino kept 18081, so the Cosmos DB emulator moved to 18082.
- Druid kept 18888, so SearXNG moved to 18889.
- DynamoDB Local kept 18000, so Kong moved to 18800 and 18801.
- ClickHouse kept 19000 for its native protocol, so MinIO moved to 19100 and
  19101.
- Mailpit moved off 18025, which the host already uses, so SMTP is 11025 and
  the web interface is 18026.

Two additions were needed for the services to work at all.  Couchbase clients
cannot do anything without the data port, so 11210 is published as well.  FTP
passive transfers negotiate a port in 30000 through 30009, so that range is
published too.

The second table is the final assignment, port by port.

| Host port | Container port | Service |
| --- | --- | --- |
| 11025 | 1025 | `mailpit` |
| 11210 | 11210 | `couchbase` |
| 11433 | 1433 | `mssql2022` |
| 11521 | 1521 | `oracle` |
| 12121 | 21 | `ftp` |
| 12222 | 22 | `sftp` |
| 13000 | 3000 | `teable` |
| 13001 | 80 | `baserow` |
| 13002 | 8080 | `nocodb` |
| 13003 | 8484 | `grist` |
| 13004 | 80 | `seatable` |
| 13050 | 3050 | `firebird5` |
| 13306 | 3306 | `mysql84` |
| 13307 | 3306 | `mysql97` |
| 13308 | 3306 | `mariadb11` |
| 13309 | 3306 | `seatable-db` |
| 13310 | 3310 | `clamav` |
| 14443 | 4443 | `fakegcs` |
| 14445 | 445 | `samba` |
| 15000 | 50000 | `db2` |
| 15432 | 5432 | `postgres14` |
| 15433 | 5432 | `postgres15` |
| 15434 | 5432 | `postgres16` |
| 15435 | 5432 | `postgres17` |
| 15436 | 5432 | `postgres18` |
| 15437 | 6432 | `pgbouncer` |
| 15438 | 6432 | `pgcat` |
| 15678 | 5678 | `n8n` |
| 15984 | 5984 | `couchdb` |
| 17017 | 27017 | `mongodb` |
| 17474 | 7474 | `neo4j` |
| 17687 | 7687 | `neo4j` |
| 17700 | 7700 | `meilisearch` |
| 18000 | 8000 | `dynamodb` |
| 18026 | 8025 | `mailpit` |
| 18081 | 8080 | `trino` |
| 18082 | 8081 | `cosmos` |
| 18083 | 18083 | `firestore` |
| 18086 | 8086 | `influxdb2` |
| 18090 | 8090 | `webdav` |
| 18091 | 8091 | `couchbase` |
| 18092 | 8092 | `couchbase` |
| 18093 | 8093 | `couchbase` |
| 18094 | 8094 | `couchbase` |
| 18095 | 8095 | `couchbase` |
| 18096 | 8096 | `couchbase` |
| 18108 | 8108 | `typesense` |
| 18123 | 8123 | `clickhouse` |
| 18180 | 8080 | `keycloak` |
| 18181 | 8181 | `influxdb3` |
| 18200 | 8200 | `vault` |
| 18201 | 8200 | `openbao` |
| 18800 | 8000 | `kong` |
| 18801 | 8001 | `kong` |
| 18888 | 8888 | `druid-router` |
| 18889 | 8080 | `searxng` |
| 19000 | 9000 | `clickhouse` |
| 19088 | 9088 | `informix` |
| 19090 | 9090 | `prometheus` |
| 19100 | 9000 | `minio` |
| 19101 | 9001 | `minio` |
| 19200 | 9200 | `elasticsearch` |
| 19201 | 9200 | `opensearch` |
| 19443 | 9443 | `authentik` |
| 20000 | 10000 | `azurite` |
| 20001 | 10001 | `azurite` |
| 20002 | 10002 | `azurite` |
| 30000-30009 | 30000-30009 | `ftp` |

Internal only, no published port: `authentik-postgres`, `authentik-redis`, `authentik-worker`, `couchbase-init`, `couchdb-init`, `druid-broker`, `druid-coordinator-overlord`, `druid-historical`, `druid-middlemanager`, `druid-zookeeper`, `seatable-memcached`, `teable-cache`, `teable-db`

## License acceptance

Three images refuse to start until an environment variable says the license is
accepted.  The fleet never accepts one.  Each of those variables is fed from a
fleet variable that defaults to empty, so the container starts, prints its
license complaint, and exits.  Accepting a license is the owner's decision.

| Service | Image variable | Fleet variable | License terms |
| --- | --- | --- | --- |
| `mssql2022` | `ACCEPT_EULA` | `FLEET_ACCEPT_MSSQL_EULA` | [SQL Server license terms](https://learn.microsoft.com/en-us/sql/linux/sql-server-linux-setup), and the container prints the exact link for its build |
| `db2` | `LICENSE` | `FLEET_ACCEPT_DB2_LICENSE` | [IBM software license agreements](https://www.ibm.com/software/sla/sladb.nsf/sla/bm), look for Db2 Community Edition |
| `informix` | `LICENSE` | `FLEET_ACCEPT_INFORMIX_LICENSE` | [Informix container documentation](https://github.com/informix/informix-dockerhub-readme), which carries the Developer Edition terms |

To accept one, copy the example environment file and fill in the value the image
expects, which is `accept` for both IBM images and `Y` for SQL Server.

```sh
cp ops/test-fleet/.env.example ops/test-fleet/.env
$EDITOR ops/test-fleet/.env
```

Compose reads `.env` from the directory that holds `compose.yaml`, so nothing
else has to change.  The file is not committed, and `validate.py` fails the
build if a license variable ever gains a non-empty default.

Some images carry license terms without needing a variable.  Reading them is
still part of using the fleet.

| Service | Terms |
| --- | --- |
| `couchbase` | [Couchbase Community Edition](https://docs.couchbase.com/server/current/install/getting-started-docker.html).  Community Edition is free for clusters up to five nodes, and the image has no variable to accept, so nothing is gated here |
| `oracle` | [Oracle Free license](https://www.oracle.com/downloads/licenses/oracle-free-license.html) |
| `elasticsearch` | [Elastic License 2.0](https://www.elastic.co/licensing/elastic-license) |
| `neo4j` | [Neo4j Community Edition](https://neo4j.com/licensing/) |
| `minio` | [MinIO licenses](https://min.io/legal) |
| `seatable` | [SeaTable Developer Edition](https://seatable.com/en/pricing/) |

## Architecture

Most images publish arm64 builds, and those run natively.  Twelve services do
not, and Compose pins them to `linux/amd64` so Rosetta emulates them.

- `mssql2022`
- `db2`
- `informix`
- `druid-coordinator-overlord`, `druid-broker`, `druid-historical`,
  `druid-middlemanager`, `druid-router`
- `firestore`
- `sftp`
- `ftp`
- `seatable`

Emulation costs time and memory.  First boot for Db2 and Informix can take ten
minutes, and the Druid profile is slow to answer queries.  `validate.py` checks
this against the registry, so an image that gains an arm64 build shows up as a
warning rather than silently staying emulated.

## Caveats

These are the places where the obvious configuration does not work.

- **Oracle TCPS.**  The `oracle` service listens in plain TCP only.  TCPS
  needs a server wallet, which Oracle's `orapki` makes, and the image ships
  without the Java runtime and the PKI libraries `orapki` runs on.  The
  connector tests put a TLS listener of their own in front of it instead,
  which checks the driver's TLS, certificates, and wallets, but not Oracle's
  own TCPS listener or the renegotiation it asks for after handing a session
  to a server process.

- **MinIO.**  MinIO stopped publishing images that anyone can pull without
  credentials.  The fleet uses the last frozen public build,
  `bitnamilegacy/minio:2025.7.23-debian-12-r5`, which carries arm64 and the S3
  API Riosoma needs.  If registry credentials become available, swap in
  `quay.io/minio/minio` and update the tag.
- **WebDAV.**  The dedicated `hacdias/webdav` image is built `FROM scratch`, so
  it has no shell and cannot run a healthcheck at all.  rclone serves WebDAV
  instead, including `PROPFIND`, and it is a maintained multi-architecture
  image.
- **SFTP.**  `atmoz/sftp` publishes `debian` and `alpine` and no version tags,
  so the pin is a digest.  `validate.py` confirms the digest still matches what
  the tag points at.
- **Couchbase.**  A Couchbase SDK gets the cluster topology from the management
  port and then dials the container addresses it is told about.  Published
  ports are enough for the REST API on 18091 through 18096, and a data plane
  test has to run inside the `riosoma-fleet` network.
- **Cosmos DB emulator.**  It runs in HTTP mode, because HTTPS would need a
  certificate the client trusts.  The .NET and Java SDKs do not speak plain
  HTTP, so set `PROTOCOL` to `https-insecure` for those tests.
- **DuckDB.**  There is no container.  DuckDB is an in-process library, so the
  Riosoma tests link it directly.
- **Druid.**  The micro quickstart is five JVMs plus ZooKeeper, and it is the
  heaviest profile in the fleet.  The heaps are cut below the shipped defaults
  so the profile stays near four gigabytes.  Start it alone, and use the
  `druid` profile so all six services come up together.
- **InfluxDB 3 Core.**  Core answers queries only about data written in the last
  72 hours.  Tests that need older data belong against InfluxDB 2 or Enterprise.
- **Grist.**  Formulas run without a sandbox.  gVisor does not work inside the
  Colima virtual machine, and sandboxing is not what this fleet tests.
- **Authentik.**  The worker serves no port, so its healthcheck reads the
  process table instead.  The server publishes HTTPS on 19443 and answers its
  own healthchecks on the internal HTTP port.
- **CouchDB.**  Single node mode is applied by `couchdb-init`, which creates the
  system databases and sets the node configuration.  Starting `couchdb` alone
  leaves that step out.
- **Keycloak.**  The realm is imported on first boot only.  Delete the
  `fleet-keycloak` volume to import `keycloak/realm.json` again.
- **SeaTable.**  The publisher's own registry is not reachable from every
  network, so the fleet uses the `seatable/seatable-developer` mirror on Docker
  Hub, which is the same Developer Edition build.
- **NocoDB and Teable.**  NocoDB switched to calendar versioning and Teable
  publishes only build tags, so those two tags look unusual.  Both are exact.
- **Vault and OpenBao.**  Both run in dev mode, so everything lives in memory
  and disappears on restart.
- **PostgreSQL 18.**  The 18 image moved its data directory, so its volume
  mounts at `/var/lib/postgresql` while 14 through 17 mount
  `/var/lib/postgresql/data`.
- **Prometheus.**  Targets that belong to profiles that are not running show up
  as down, which is normal.

## Validation

```sh
python3 ops/test-fleet/validate.py
```

The checker fails, with a nonzero exit status, when any of these is true.

- A service has no image tag, or its tag is `latest`, or its tag carries no
  version and no digest.
- A service has no healthcheck, or its healthcheck is disabled.  One-shot jobs
  marked `x-fleet-job: true` are exempt, because their exit status is the
  signal.
- A service has no `deploy.resources.limits.memory`.
- A service has no profiles, or none of its profiles is named after it.
- A published port is not bound to `127.0.0.1`.
- Two services publish the same host port.
- A license variable carries a value, or interpolates with a non-empty default.
- A named volume is not prefixed with `fleet-`.
- A bind mount points at a file that is missing.
- An image tag does not exist in its registry, or a digest pin no longer matches
  its tag.
- An image publishes no arm64 build and carries no `platform: linux/amd64`.

Registry lookups need network access and no credentials.  Results are cached in
`~/.cache/riosoma-test-fleet/registry.json`, so repeated runs are fast.  Delete
that file to force a fresh look, or pass `--offline` to skip registry checks
entirely.

```sh
python3 ops/test-fleet/validate.py --offline
```

Warnings never fail the run.  They flag pre-release tags, images that gained an
arm64 build while still pinned to `linux/amd64`, and stale digest pins.

### File-source unit profile

`sh ops/test-fleet/file-sources.sh --check` validates the isolated profile.  `sh ops/test-fleet/file-sources.sh <smoke-command>` starts its SFTP, WebDAV, FTP, and Samba services, runs the command, and removes the containers, network, volumes, and temporary credentials on exit.  Every resource has the `riosoma-file-sources` project prefix.  The services use random loopback ports except FTP passive ports 31100–31109.  Run only one copy of this profile at a time.

The wrapper generates credentials at runtime.  The smoke command inherits `FILE_SOURCES_PASSWORD` and can find ports through `docker compose --project-name riosoma-file-sources --file ops/test-fleet/file-sources.compose.yaml --profile file-sources port <service> <port>`.  Use `file-sources-sftp`, `file-sources-webdav`, `file-sources-ftp`, and `file-sources-samba` as service names.  Obtain the SFTP public host key from the container before testing, and pass it as the source’s pinned key.

SMB remains deferred.  `smb3-client` is MIT-licensed and maintained, but its documented alpha status does not yet provide a stable dependency choice for this unit.  Older SMB2 candidates did not establish the required signing and encryption behavior.  Samba stays in the profile for future validation.  FTP and FTPS use the unit’s bounded passive client, so no dependency or lockfile change is needed.
