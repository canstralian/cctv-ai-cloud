# ADR 0001: Idempotent event upsert keyed by (source, external_id)

- **Status:** Accepted (2026-10-06), amended the same day after review F6/F9 (see *Amendments*)
- **Date:** 2026-10-06
- **Context doc:** [Frigate bridge architecture](../design/frigate-bridge/architecture.md)

## Context

`POST /api/v1/events` inserts a new row on every call. The first real producer,
the Frigate bridge, gets messages at least once (MQTT QoS 1 plus HTTP
retries). It also reports each detection several times as Frigate refines it
(`new` → `update` → `end`). With today's endpoint, one person walking past a
camera becomes several rows, and a retried request becomes a duplicate.

## Decision

Add an idempotent upsert keyed by the producer's own identifier:

```
PUT /api/v1/events/by-source/{source}/{external_id}    scope: write
```

- **Schema:** two nullable columns on `events`, `source TEXT` and
  `external_id TEXT`, with a **partial unique index**:
  `UNIQUE (source, external_id) WHERE source IS NOT NULL`. Rows created via
  the existing `POST` keep both columns null and are unaffected.
- **Semantics:** if the key is new, insert and return `201`. If it exists,
  update the mutable fields (`label`, `score`, `ended_at`, `thumbnail_path`,
  `clip_path`, `attributes`) in place and return `200` with the same `id`
  and `created_at`. `camera_id` and `started_at` are fixed on first write; a
  later PUT that changes them is a `409 conflict`, because it means the
  producer reused an ID.
- **Atomicity:** one `INSERT … ON CONFLICT (source, external_id) WHERE
  source IS NOT NULL DO UPDATE` statement. No read-then-write race. The
  `WHERE` in the conflict target is required: SQLite matches a partial index
  only if the target repeats its predicate, and rejects the bare form with
  "ON CONFLICT clause does not match any PRIMARY KEY or UNIQUE constraint"
  (verified on SQLite 3.45). The 409 check stays in the same statement:
  `DO UPDATE … WHERE events.camera_id = excluded.camera_id AND
  events.started_at = excluded.started_at`. If `changes()` is 0 on a
  conflicting key, the producer reused an ID.
- **Migration:** `ALTER TABLE events ADD COLUMN` twice, plus `CREATE UNIQUE
  INDEX IF NOT EXISTS`, run idempotently at startup next to the existing
  `init_db`. Old rows need no backfill.
- `POST /api/v1/events` stays as it is, for producers with no stable ID.

## Amendments (2026-10-06, after review)

- **Source-bound write authority (F6).** `API_KEYS` entries gain an optional
  fourth field listing the sources the key may write:
  `name:secret:scopes:source|source`. A `by-source` request whose `{source}`
  is not in the key's list gets **403**. A key with no list may write no
  `by-source` path at all (fail-closed). JWT principals may not use
  `by-source` paths. Without this, `source` is a naming convention, not an
  authority boundary.
- **Migration race (F9).** The `user_version` check and the `ALTER TABLE`s
  run inside one `BEGIN IMMEDIATE` transaction, so a second worker waits,
  then sees the new version and does nothing.
- **Thumbnail is API-owned on this path.** `thumbnail_path` is not accepted
  in the `by-source` body; see [ADR 0002](0002-api-owns-event-thumbnails.md).

## Consequences

**Positive**
- Retries and duplicate deliveries are harmless; producers stay stateless.
- The ML worker (step 4) uses the same path with `source="ml"`, so we don't
  need a second ingest design.
- `EventOut` exposes `source` / `external_id`, so the dashboard can deep-link
  back into Frigate.

**Negative**
- This is the first schema migration. The app currently only has
  `CREATE IF NOT EXISTS`, so this introduces a small migration step (one
  `PRAGMA user_version` bump).
- `PUT` with a natural key is a second write path. Tests must cover both.

**Neutral**
- `source` is a free label validated by pattern, not an enum, so new
  producers don't need an API release.

## Alternatives

| Alternative | Why not |
|---|---|
| `Idempotency-Key` header on `POST` (Stripe-style) | Covers retries, but not Frigate's `new`/`update`/`end` refinements, which are *different* requests for the same detection |
| Bridge keeps a Frigate→API ID map, then POST + PATCH | Stateful bridge; the map is lost on restart, which brings the duplicates back |
| Frigate-specific columns (`frigate_id`) | Locks the schema to one producer; the ML worker would need its own |
| Dedupe on `(camera_id, label, started_at)` | Two people entering a frame in the same instant really are two events |

## Revisit when

- A producer can't supply a stable ID. It keeps using `POST`; that's fine.
- The store moves off SQLite. Then we need the same partial-unique semantics
  on the new engine.
- Events are ever shared across tenants. `source` would then need namespacing.
