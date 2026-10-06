---
agent: runtime-architect
subject: Frigate → API event bridge (roadmap step 1), revision 2
date: 2026-10-06
confidence: high
inputs:
  - review.md (systems-critic, 9 findings)
  - Human decisions 2026-10-06: pin Frigate 0.18.0; reconcile from Frigate (no disk spool); the API owns retained thumbnails
  - Frigate v0.18.0 source: events/maintainer.py, events/cleanup.py, api/media.py, api/defs/query/events_query_parameters.py, config/camera/snapshots.py, docs (mqtt.md, authentication.md)
  - api/app/** (current main)
supersedes: revision 1 (same file, commit 4ffdc29)
---

# Frigate Bridge Architecture (rev 2)

## What changed from rev 1

| Review finding | Resolution in rev 2 |
|---|---|
| F1: snapshot links rot | [ADR 0002](../../adr/0002-api-owns-event-thumbnails.md): the API stores its own copy of each thumbnail. Its lifetime follows the event row, not Frigate's retention |
| F2: a dropped `end` is never repaired | [ADR 0003](../../adr/0003-mqtt-fast-path-frigate-reconciliation.md): periodic and on-reconnect **catch-up** from Frigate's events API, using the same idempotent upsert |
| F3: retrying inside the MQTT callback | Receiving and delivering are split by a bounded queue. The MQTT thread only parses and enqueues. A broker-wide in-flight limit is no longer used |
| F4: update filter drops zone changes | **Filter removed.** Frigate only publishes on a better snapshot or a zone change (verified), so every message is forwarded |
| F5: startup check needs a scope the bridge lacks | Two credentials: a Frigate *viewer* login for reads, and an API key that can only *ingest* `source=frigate` events. The bridge doesn't read the API's camera registry at all |
| F6: any key can write any source | ADR 0001 amended: each API key is bound to the sources it may write. A mismatch returns 403 |
| F7: broker trusts any publisher | Mosquitto per-user topic ACLs: only `frigate` may publish `frigate/#`, and the `bridge` user may only read |
| F8: dead bridge looks like a quiet site | A bridge `/healthz` with the five health readings below, plus `last_ingest_at` per source in `/api/v1/stats` |
| F9: migration race | Check the version and migrate inside one `BEGIN IMMEDIATE` transaction |
| *New:* Frigate port 5000 published | Port 5000 is Frigate's **unauthenticated** API (Frigate docs). Integration step 1 stops publishing it. Only 8971 (authenticated) is published, and the bridge talks to 8971 |

## Problem

Unchanged: Frigate detects, and the API stores and serves. The bridge makes
every Frigate detection appear once in the API, with a thumbnail that lasts
as long as the event does. It should be live within seconds, and **eventually
correct even when messages are lost**.

## Assumptions

1. **Verified (v0.18.0).** `frigate/events` publishes `new`, `update` and
   `end`. Updates only come on a better snapshot or a zone change. The
   `after` object carries `id`, `camera`, `label`, `sub_label` (null or
   `[name, score]`), `top_score`, `start_time`, `end_time`, `entered_zones`,
   `has_snapshot` and `has_clip`. The schema is identical in 0.16.4 and
   0.17.2.
2. **Verified.** `GET /api/events` accepts `after`, `before`, `in_progress`,
   `cameras`, `limit` and `sort`. The record shape **differs from MQTT**:
   `zones` (= entered_zones), `sub_label` as a string,
   `data.top_score`, and `data.sub_label_score`.
3. **Verified.** `GET /api/events/{id}/snapshot.jpg` renders the snapshot.
   On disk, 0.18 keeps `<camera>-<id>-clean.webp`. The bridge never reads
   Frigate's disk.
4. **Verified.** Frigate's default snapshot retention is 10 days
   (`config/camera/snapshots.py`), and the API's is 30.
5. **Verified.** Port 5000 is unauthenticated. Port 8971 is authenticated,
   with `admin` and `viewer` roles (Frigate authentication docs).
6. **Inferred.** The bridge authenticates to 8971 by `POST /api/login` with
   a viewer user and reuses the returned token. **Verify** on the pinned
   image during the build; if login differs, only `FrigateClient`
   changes.
7. **Assumed.** One site, at most tens of events a minute (unchanged).

## Constraints

### Hard
- No duplicate rows. Delivery is at-least-once; writes are idempotent (ADR 0001).
- **Eventual correctness:** within one catch-up interval of Frigate and the
  API both being healthy, every Frigate event inside the lookback window
  matches its API row. This includes `ended_at` and the thumbnail.
- The bridge never touches the API's database, the API's file storage, or
  Frigate's filesystem. Everything goes over HTTP.
- Least privilege: the bridge's credentials let it read from Frigate and
  ingest `source=frigate` events into the API. Nothing else.
- Failures are visible in a health signal, not only in logs.

### Soft
- Live latency of about 2 s or less from Frigate's `new`.
- Python 3.12. Dependencies: paho-mqtt, httpx, pydantic-settings.

## Architecture

```
                 MQTT (ACL: frigate publishes, bridge reads)
 Frigate ───────────────────────────────▶ mosquitto ───────────▶ bridge ──PUT──▶ api ──▶ SQLite
 0.18.0  ◀──── GET /api/events (catch-up), GET …/snapshot.jpg ───────┘   X-API-Key   │
 :8971   (viewer login)                                                (source=frigate) └─▶ data/thumbnails/
```

| Component | Owns | Doesn't own |
|---|---|---|
| **Frigate** | Detection, tracking, its own media and retention | Anything after the event is published |
| **mosquitto** | Live delivery and topic authorization (ACLs) | Durability beyond its session: catch-up covers that |
| **bridge** | Translating Frigate events into upserts, catch-up, fetching thumbnails, its own health | Storage, dedupe, auth policy |
| **api** | Event rows, dedupe, **thumbnail files**, retention of both, per-source write authority | Anything Frigate-specific |

### Bridge internals

```
 paho network thread            ┌──────────────── delivery worker (1 thread) ─────────────────┐
 on_message:                    │ take item → map → PUT event → (has_snapshot?) fetch+PUT      │
   parse → enqueue ─▶ [bounded queue, maxsize Q] ─▶  thumbnail → mark MQTT msg acked              │
   (never blocks on IO)         │ retry transient failures with backoff, then give up (logged; │
                                │ catch-up repairs it)                                           │
 catch-up timer ────────────────▶ same queue (items tagged origin=catchup)                       │
                                └───────────────────────────────────────────────────────────────┘
```

- **One delivery worker.** That keeps per-event order: `new` → `update` →
  `end` for one ID is never reordered. Throughput is far above the
  assumption.
- **Queue full, MQTT side:** the network thread **does not block**. It
  drops the item, counts `queue_overflow`, and marks catch-up as needed.
  Keep-alive is never at risk; the next catch-up repairs the dropped item.
- **Queue full, catch-up side:** catch-up runs on its own thread, so it
  **blocks** on `put` until there's capacity (with the run's own deadline).
  It never drops a record. If the deadline expires, the run ends as
  `failed` and the next run starts from the top of the window. Catch-up
  therefore can't discard the older records it exists to recover.
- **Acknowledgement:** MQTT QoS 1 with manual ack after the worker finishes
  (success *or* giving up). If the bridge crashes, unacknowledged messages
  are redelivered on reconnect. Redelivery is harmless because the upsert
  is idempotent.
- **No broker-wide `max_inflight_messages`** (F3).

### Catch-up (ADR 0003)

| Trigger | Window |
|---|---|
| Bridge start | `now − RECONCILE_LOOKBACK` (default 6 h) → now |
| MQTT reconnect | same |
| Every `RECONCILE_INTERVAL` (default 10 min) | same |
| After a delivery gave up, or the queue overflowed | an early run, at most one per minute |

A catch-up pages through `GET /api/events?after=…&before=…&limit=100
&sort=date_desc`. Frigate filters `start_time < before` (strict) and orders
only by `start_time` (verified, `frigate/api/event.py` v0.18.0), so records
that share a boundary `start_time` need care:

1. The next page's `before` is the oldest `start_time` on the page **plus a
   small epsilon** (1 ms), so records tied at the boundary are fetched
   again rather than skipped.
2. Records are de-duplicated by `id` within the run, and each is enqueued
   once.
3. If a full page adds no new IDs (every record is tied at one
   `start_time`), the run retries that page with `limit` doubled, up to
   1,000. If it still adds nothing, the run ends as `failed` and the
   failure is visible in health. It never loops forever, and never skips
   silently.

There's **no stored cursor**: the overlapping window is cheap because writes
are idempotent. Events that started before
the lookback window aren't repaired. That's a stated limit, set by
`RECONCILE_LOOKBACK`.

### Thumbnails (ADR 0002)

Whenever the worker sees `has_snapshot = true`, it fetches
`/api/events/{id}/snapshot.jpg` and sends a `PUT` to the API's
thumbnail endpoint. It does this on the first message with a snapshot (so
the live dashboard has an image), again on `end` (Frigate's final best
snapshot), and during catch-up when the stored thumbnail is not final:
`has_snapshot` is true, and the upsert response says `has_thumbnail` is
false, **or** the record has ended and `thumbnail_final` is false. That
covers a live `end` whose snapshot fetch failed after an earlier, non-final
thumbnail was stored. A thumbnail fetched for an ended record is uploaded
with `?final=true`.

### What gets forwarded

| Input | Action |
|---|---|
| MQTT `new` / `update` / `end` | Upsert. Fetch the thumbnail per the rule above |
| Catch-up record | Upsert. Fetch the thumbnail if `has_snapshot` and the stored one is missing, or the record has ended and the stored one isn't final (the upsert response carries both flags) |
| `false_positive: true` | Skip. Frigate normally doesn't publish these, but it's cheap to guard against |
| Camera fails `CAMERA_ID_PATTERN` after `CAMERA_MAP` | Skip, `unmapped_camera` |
| Label fails `LABEL_PATTERN` | Skip, `invalid_label` |

### Field mapping

| `EventUpsert` | MQTT `after` | HTTP record |
|---|---|---|
| `external_id` | `id` | `id` |
| `camera_id` | `CAMERA_MAP.get(camera, camera)` | same |
| `label` | `label` | `label` |
| `score` | `top_score` | `data.top_score` |
| `started_at` / `ended_at` | `start_time` / `end_time` (epoch → UTC) | same |
| `attributes.zones` | `entered_zones` | `zones` |
| `attributes.sub_label`, `sub_label_score` | `sub_label[0]`, `sub_label[1]` | `sub_label`, `data.sub_label_score` |

Two parsers (`parse_mqtt`, `parse_http`) produce the same
`FrigateObject`. The mapping code only ever sees `FrigateObject`.

## Interfaces

### API changes

```
PUT    /api/v1/events/by-source/{source}/{external_id}              scope: ingest, key bound to {source}
         body: EventCreate minus thumbnail_path (that field is API-owned on this path)
         merge rules: ADR 0001 (ended_at sticky, score max, terminal row frozen)
         201 created · 200 updated (same id) · 403 not ingest / source not bound
         404 unknown camera · 409 camera_id/started_at changed · 422 validation
         response: EventOut (incl. has_thumbnail, thumbnail_final)

PUT    /api/v1/events/by-source/{source}/{external_id}/thumbnail[?final=true]
                                                                    scope: ingest, key bound to {source}
         body: image/jpeg, ≤ THUMBNAIL_MAX_BYTES (default 512 KiB); magic bytes checked
         204 stored · 204 ignored (non-final upload over a final one)
         404 event unknown · 413 too large · 415 not JPEG

GET    /api/v1/events/{id}/thumbnail                                scope: read
         200 image/jpeg · 404 none stored

GET    /api/v1/stats  gains  last_ingest_at: {source: datetime}
```

`API_KEYS` grammar grows an optional fourth field: `name:secret:scopes:sources`,
for example `frigate-bridge:sk_…:ingest:frigate`. `ingest` is a separate scope
and doesn't satisfy `write`, so the bridge key gets 403 on `POST
/api/v1/events` and on every camera write. A key with no sources field can
ingest **nothing**: fail-closed. Existing `read`/`write` keys are unaffected.

### Bridge

Signatures are in [`interfaces.py`](interfaces.py). Health:

```
GET :8080/healthz   200 when healthy, 503 otherwise
  { "mqtt_connected": bool,
    "last_mqtt_received_at": ts|null,
    "last_api_delivery_at": ts|null,
    "last_reconciliation_at": ts|null,
    "reconciliation_status": "ok"|"failed"|"never",
    "queue_depth": int,
    "oldest_pending_age_s": float|null,
    "consecutive_give_ups": int,
    "counters": {created, updated, skipped_by_reason, gave_up, queue_overflow} }
unhealthy = !mqtt_connected for > 60 s
         OR reconciliation_status == "failed" twice in a row
         OR consecutive_give_ups >= 3            (deliveries are failing, not just slow)
         OR oldest_pending_age_s > 180           (work is waiting and not draining)
```

The compose health check calls `/healthz`. The two delivery conditions only
trigger when there **is** work: a quiet site has an empty queue
(`oldest_pending_age_s` null) and no attempts, so it stays healthy. Any
successful delivery resets `consecutive_give_ups` to 0. So with MQTT up and
catch-up succeeding, an API that rejects or drops every `PUT` still turns the
bridge unhealthy within about three delivery deadlines.

## Sequences

### Happy path
1. Frigate publishes `new` for event X. The network thread parses it,
   enqueues it, and returns in microseconds.
2. The worker sends a PUT for the event (201). `has_snapshot` is true, so it
   fetches `snapshot.jpg` and sends a PUT for the thumbnail (204). Then it
   acknowledges the message.
3. A zone-change `update` arrives. PUT returns 200.
4. `end` arrives. PUT with `ended_at` returns 200. It fetches the final
   snapshot and sends a PUT (204, replacing the previous one). Acknowledged.

### Failure path: API down for 5 minutes while X ends
1. The `end` PUT fails. The worker retries with backoff for up to
   `SINK_MAX_ELAPSED` (60 s), gives up, logs `gave_up external_id=X`, and
   acknowledges. An early catch-up is scheduled.
2. The network thread keeps receiving the whole time, so keep-alive is
   fine. New items queue up; if the queue fills, overflow is counted.
3. The API comes back. The early catch-up fetches the last 6 h from Frigate,
   which includes X with its `end_time`, and enqueues it. The PUT returns
   200: `ended_at` is now set. The row has no thumbnail, so the bridge
   fetches it and sends a PUT. **The event has repaired itself without any
   message being replayed.**
4. Health showed `last_api_delivery_at` going stale for those 5 minutes.

### Failure path: bridge down for 2 days
Mosquitto's session expiry (24 h) has passed, and the queued messages are
gone. On start, catch-up covers the last 6 h. **Events that ended between
6 h and 2 days ago are not recovered.** To fill that gap, run the bridge
once with `RECONCILE_LOOKBACK=72h`. Documented as a runbook line.

## Alternatives considered (delivery, rev 2)

| Option | Why not |
|---|---|
| Disk spool for undelivered messages | Only covers "received, then the HTTP delivery failed." It misses bridge downtime, broker session expiry and crashes, all of which catch-up covers. It's also more state to corrupt |
| Catch-up only, no MQTT | Live latency equals the catch-up interval. MQTT stays as the fast path |
| Stored catch-up cursor | Precise but stateful. An overlapping window plus idempotency gives the same result with no state |

## Trade-offs

- A catch-up every 10 minutes queries Frigate's events for the last 6 hours.
  At the assumed volume that's a few hundred rows. Revisit if Frigate's
  query time shows up in its own metrics.
- Thumbnails cost disk on the API side: about 50–150 KB × events. At
  1,000 events a day and 30-day retention, that's roughly 1.5–4.5 GB.
  `THUMBNAIL_MAX_BYTES` caps the worst case per file.
- Bridge restarts within 24 h are covered twice (broker redelivery and
  catch-up). That's harmless.

## Risks

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Frigate login flow differs from Assumption 6 | Medium | Catch-up and thumbnails fail; the live path still works | Confined to `FrigateClient`. Health shows `reconciliation_status: failed` |
| Thumbnail files orphaned (row deleted by camera cascade or prune, file left) | High without care | Disk leak | The prune job also sweeps files with no row. Thumbnails are named by event ID, so the sweep is a set difference |
| Thumbnail disk growth | Medium | Disk fills, which breaks SQLite too | Byte cap per file, plus thumbnails counted in stats. Revisit a separate volume at ops time |
| 0.18.0 is a `.0` release | Medium | Frigate bugs (known ones are fixed in 0.18.1) | Pinned by digest. 0.18.1 is a deliberate upgrade after the fixtures pass |

## Pinned versions

- Frigate `ghcr.io/blakeblackshear/frigate:0.18.0@sha256:9678a83a76e4730ac7d9ea7428370e32ae656d6b312aaad30d6c69f3fef14d35`
  (index digest resolved from ghcr.io on 2026-10-06).

## Handoff

- **Ready for:** builder, steps 1–4 of the integration plan. Step 5 (the bridge) is
  unblocked too, but should start after step 2's API contract has merged.
- **Open questions:** none blocking. Assumption 6 (the login flow) gets verified
  as the first task of step 5.
- **Do not proceed if:** the pinned image's `GET /api/events` stops returning
  `data.top_score` and `zones`, or `snapshot.jpg` needs a role above `viewer`.
