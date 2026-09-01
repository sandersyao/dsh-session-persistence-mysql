# @sandersyao/dsh-session-persistence-mysql

English | [中文](README.zh.md)

The **MySQL durable session-persistence backend** for the DeepSeek Harness — a concrete `SessionPersistence` (the `dsh-session-persistence` seam). Load it as a plugin; it registers `ctx.sessionPersistence` and persists the event-sourced `SessionEvent` log into MySQL, behavior-contract-equivalent to the JSONL backend, with **read/write split** support.

## Install & usage

```ts
import { MysqlSessionPersistence } from '@sandersyao/dsh-session-persistence-mysql'

await ctx.plugin(MysqlSessionPersistence, {
  connection: { tablePrefix: process.env.MYSQL_TABLE_PREFIX },
})
// ctx.sessionPersistence is now MySQL-backed.
```

## Configuration

Credentials, table prefix and pool tuning come from environment variables / a `.env` file (see `.env.example`). The plugin `Config` is fully optional — environment is the source of truth for credentials (never hard-code a password).

| Env | Default | Purpose |
|---|---|---|
| `MYSQL_HOST` / `MYSQL_PORT` | `127.0.0.1` / `3306` | Write (primary) host. |
| `MYSQL_USER` / `MYSQL_PASSWORD` | — (required) | Least-privilege DB user. |
| `MYSQL_DATABASE` | — (required) | Target database. |
| `MYSQL_TABLE_PREFIX` | — (required) | Table prefix; validated against `^[A-Za-z0-9_]+$`. |
| `MYSQL_READ_HOST` / `MYSQL_READ_USER` / `MYSQL_READ_PASSWORD` | (empty) | Read replica for read/write split; empty reuses the write connection (same-store mode). |
| `MYSQL_SSL_REQUIRED` | `false` | Reserved for TLS enforcement (deferred; may be provided by a cloud provider). |
| `MYSQL_POOL_SIZE` / `MYSQL_POOL_QUEUE_LIMIT` | `10` / `0` | Pool sizing. |
| `MYSQL_WRITE_BATCH_DELAY_MS` | `200` | Batching window passed to the coordinator. |
| `MYSQL_PREPARED_CACHE_SIZE` | `5` | Unpublished-session LRU size. |
| `MYSQL_PACK_CHUNKS` | `true` | Fold `assistant/chunk` runs into packed rows. |
| `MYSQL_SCHEMA_AUTO_MIGRATE` | `true` | Auto-migrate schema on startup; `false` only validates. |
| `ENCRYPTION_KEY` | (empty) | Reserved for application-level field encryption (deferred; empty = plaintext). |

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
- **Pinned to `^0.1.1-rc.2` peers** — official `v0.1.2-alpha.3` compatibility is future work; high test coverage is the safety net.
