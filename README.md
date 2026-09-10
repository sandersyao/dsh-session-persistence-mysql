# @sandersyao/dsh-session-persistence-mysql

<p align="center">
  <img src="assets/dolphin_typewriter_cartoon.jpg" alt="A cartoon dolphin tapping away at a typewriter" width="480" />
</p>

English | [中文](README.zh.md)

The **MySQL durable session-persistence backend** for the DeepSeek Harness — a concrete `SessionPersistence` (the `dsh-session-persistence` seam). Load it as a plugin; it registers `ctx.sessionPersistence` and persists the event-sourced `SessionEvent` log into MySQL, behavior-contract-equivalent to the JSONL backend, with **read/write split** support.

## Install & usage

```ts
import { MysqlSessionPersistence } from '@sandersyao/dsh-session-persistence-mysql'

await ctx.plugin(MysqlSessionPersistence, {
  connection: { tablePrefix: process.env.SESSION_TABLE_PREFIX ?? process.env.MYSQL_TABLE_PREFIX },
})
// ctx.sessionPersistence is now MySQL-backed.
```

## Guides

- **Try it in a dsh profile without touching existing sessions** — `docs/DSH_PROFILE_TRIAL.md`.
- **Production / npm install & `cordis.patch.yml` integration (replace the default JSONL backend)** — `docs/DEPLOYMENT.md` §8.

## Companion plugins (distributed dsh deployment)

This plugin runs alongside three sibling plugins on a shared MySQL to form a **distributed dsh
deployment**: `dsh-storage-mysql` and `dsh-credentials-mysql` switch the default storage and
credentials backends to MySQL, and `dsh-workspace-bootstrap` declaratively bootstraps a default
workspace so the first session can start on an empty database.

| Plugin | GitHub repository | npm package page |
| --- | --- | --- |
| `@sandersyao/dsh-workspace-bootstrap` | https://github.com/sandersyao/dsh-workspace-bootstrap | https://www.npmjs.com/package/@sandersyao/dsh-workspace-bootstrap |
| `@sandersyao/dsh-storage-mysql` | https://github.com/sandersyao/dsh-storage-mysql | https://www.npmjs.com/package/@sandersyao/dsh-storage-mysql |
| `@sandersyao/dsh-credentials-mysql` | https://github.com/sandersyao/dsh-credentials-mysql | https://www.npmjs.com/package/@sandersyao/dsh-credentials-mysql |

## Configuration

Credentials, table prefix and pool tuning come from environment variables / a `.env` file (see `.env.example`). The plugin `Config` is fully optional — environment is the source of truth for credentials (never hard-code a password).
Each variable reads the plugin-exclusive **`SESSION_*` first and falls back to the shared `MYSQL_*`** — the same pattern as `dsh-storage-mysql`(`STORAGE_*`) and `dsh-credentials-mysql`(`CREDENTIALS_*`): the MySQL plugins can share one `MYSQL_*` deployment yet each be configured independently (own database / table prefix).

| Exclusive `SESSION_*` | Fallback `MYSQL_*` | Default | Purpose |
|---|---|---|---|
| `SESSION_HOST` / `SESSION_PORT` | `MYSQL_HOST` / `MYSQL_PORT` | `127.0.0.1` / `3306` | Write (primary) host. |
| `SESSION_USER` / `SESSION_PASSWORD` | `MYSQL_USER` / `MYSQL_PASSWORD` | — (required) | Least-privilege DB user. |
| `SESSION_DATABASE` | `MYSQL_DATABASE` | — (required) | Target database. |
| `SESSION_TABLE_PREFIX` | `MYSQL_TABLE_PREFIX` | — (required) | Table prefix; validated against `^[A-Za-z0-9_]+$`. |
| `SESSION_READ_HOST` / `SESSION_READ_USER` / `SESSION_READ_PASSWORD` | `MYSQL_READ_*` equivalents | (empty) | Read replica for read/write split; empty reuses the write connection (same-store mode). |
| `SESSION_SSL_REQUIRED` | `MYSQL_SSL_REQUIRED` | `false` | Reserved for TLS enforcement (deferred; may be provided by a cloud provider). |
| `SESSION_POOL_SIZE` / `SESSION_POOL_QUEUE_LIMIT` | `MYSQL_POOL_*` equivalents | `10` / `0` | Pool sizing. |
| `SESSION_SCHEMA_AUTO_MIGRATE` | `MYSQL_SCHEMA_AUTO_MIGRATE` | `true` | Auto-migrate schema on startup; `false` only validates. |
| `SESSION_ENCRYPTION_KEY` | `MYSQL_ENCRYPTION_KEY` | (empty) | Reserved for application-level field encryption (deferred; empty = plaintext). |

> **Test isolation.** Automated tests (`vitest`) run against a **separate** database to avoid touching the production one: `SESSION_TEST_DATABASE` (fallback `MYSQL_TEST_DATABASE`, default `test`) overrides `SESSION_DATABASE` during tests, and `MYSQL_ROOT_PASSWORD` is used only by the test harness to create/grant the test DB. See `docs/MANUAL_TEST_PLAN.md`.

## Storage layout

Two tables plus a schema-version table, all under `MYSQL_TABLE_PREFIX`:

- `${prefix}sessions` — one row per materialized session (the `SessionHeader`).
- `${prefix}events` — the append-only event log; `PRIMARY KEY (session_id, seq)`.
- `${prefix}_meta` — applied schema version.

The header row is written **only in the same transaction as the first event batch** (lazy materialization, atomic), so a created-but-never-appended session leaves no rows and is absent from `list`.

## Read/write split

Write hooks (`appendBatch`, `commitRepair`) use the write pool; read hooks (`loadStored`, `readStoredRevision`, `loadStoredFrom`, `list`, `listSnapshots`) use the read pool. When `MYSQL_READ_HOST` is unset the read pool reuses the write connection (same-store mode — what tests exercise). Read-replica lag does not break the seam contract: revisions only need to be stable while unchanged.

## Durability and crash semantics

- **Transactional append.** Each batch commits in a single InnoDB transaction; the log is append-only and seq-contiguous. The composite primary key is the cross-process safety net for same-id double writes (the second writer is rejected on a key collision).
- **No torn tail.** Because writes are transactional, InnoDB atomicity makes a partially-written final record impossible, so the backend's `tornMarker` is always `undefined` and `commitRepair` only appends synthetic closers. This is a structural advantage over file backends.
- **Crash recovery.** An interrupted final turn is preserved and durably closed with synthetic `tool/result`/`step/end`/`turn/end {interrupted}` closers via the shared coordinator. Committed records are never rewritten.
- **Lazy materialization** — the header and first batch commit atomically.
- **Deadlock retry** — `ER_LOCK_DEADLOCK` (1213) retries with bounded backoff.

## Schema & migration

Startup runs a connection test, idempotent `CREATE TABLE IF NOT EXISTS`, then reads `${prefix}_meta`; an applied version higher than expected fails closed (no downgrade). With `MYSQL_SCHEMA_AUTO_MIGRATE=false`, a version mismatch fails instead of auto-migrating (production can run DDL out of band).

## Model Experience

The backend adds no prompt or schema. Resume restores stored surface events as message history; crash repair marks an unanswered assistant call `TOOL_NOT_STARTED` and a call without a result `TOOL_OUTCOME_UNKNOWN`. Zero live-request tokens during ordinary persistence; `readFrom` seeks by seq for checkpoint consumers.

## Known Limitations and Deferred Work

- **No delete/archive API** — the seam has none; pruning stored sessions is out-of-band `DELETE` maintenance.
- **`list()` is unpaginated and unfiltered** (seam constraint).
- **Plaintext by default** — session events may contain sensitive content (conversations, tool results, request headers). `ENCRYPTION_KEY` is a reserved extension point; application-level field encryption is deferred. Deployers should consider MySQL native TDE / at-rest encryption.
- **TLS/transport enforcement deferred** — `MYSQL_SSL_REQUIRED` is reserved; may be provided by a cloud provider.
- **Pinned to `^0.1.5-rc.x` peers** — aligned with the dsh `0.1.5-rc.x` session-persistence contract; upgrade together with `@deepseek-ai/dsh-session` / `@deepseek-ai/dsh-session-persistence`.
