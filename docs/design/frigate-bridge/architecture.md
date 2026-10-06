---
agent: runtime-architect
subject: Frigate → API event bridge (roadmap step 1)
date: 2026-10-06
confidence: medium
inputs:
  - api/app/schemas.py, api/app/routers/events.py, api/app/repositories/events.py, api/app/db.py
  - api/app/config.py, api/app/security.py, .env.example, docker-compose.yml, nvr/config.yml
  - Frigate docs, MQTT integration (docs.frigate.video/integrations/mqtt), via Context7
---

# Frigate Bridge Architecture

## Problem

The API stores detections, but nothing sends it any. Frigate already runs
object detection and publishes every tracked object on MQTT. The bridge turns
those messages into rows in `events` so the dashboard (step 2) and the ML
re-scorer (step 4) have real data, without building detection a second time.

## Assumptions

1. **Verified.** Frigate publishes tracked objects on `frigate/events` as
   `{"type": "new"|"update"|"end", "before": {...}, "after": {...}}`. `after`
   carries `id`, `camera`, `label`, `sub_label` (null or `[name, score]`),
   `top_score`, `false_positive`, `start_time` / `end_time` (epoch seconds
   as floats), `current_zones`, `entered_zones`, `has_snapshot`, `has_clip`
   and `attributes`. (Frigate MQTT docs.)
2. **Verified.** `POST /api/v1/events` has no idempotency key. Every call
   inserts a new row with a fresh UUID (`repositories/events.py:create`).
3. **Verified.** `camera_id` is a foreign key. An event for a camera the API
   doesn't know returns 404 (`routers/events.py:create_event`).
4. **Verified.** `camera_id` must match `^[a-z0-9][a-z0-9_-]{0,63}$` and
   `label` must match `^[a-z0-9][a-z0-9_-]{0,31}$`. Media paths must be
   relative with no `..` segments.
5. **Inferred.** Frigate stores snapshots as `clips/<camera>-<event_id>.jpg`
   under `/media/frigate`. **Verify** against the pinned Frigate version
   before relying on `thumbnail_path`.
6. **Assumed.** One site, one Frigate, a few to a few dozen cameras, and at
   most tens of events a minute at peak. If that's wrong, see Risks.
7. **Verified.** `docker-compose.yml` uses `frigate:stable`, an unpinned tag,
   so the payload schema can change under us on any `docker compose pull`.

## Constraints

### Hard
- **No duplicate rows.** MQTT QoS 1 is at-least-once and the bridge retries
  failed posts, so the same Frigate event *will* arrive more than once.
- **No direct database access from the bridge.** The API owns `cctv.db`. The
  bridge writes only through `/api/v1` with a `write`-scope API key, the same
  path the ML worker will use.
- **Credentials stay out of the repo and the logs.** That covers the MQTT
  password and the API key.
- **Fail visible, not silent.** A dropped event is logged with its reason
  and counted.

### Soft
- Show events within about 2 s of Frigate's `new`.
- No new language or runtime. The bridge is Python 3.12, like `api` and `ml`.
- Stays small: a few hundred lines, no framework.

## Architecture

```
 Frigate ──MQTT──▶ mosquitto ──MQTT──▶ bridge ──HTTP PUT──▶ api ──▶ SQLite
 (nvr)   frigate/events  (broker)     (new svc)  X-API-Key   (owns the DB)
```

| Component | Owns | Doesn't own |
|---|---|---|
| **mosquitto** (new compose service) | Message delivery between Frigate and the bridge, and a persistent session queue while the bridge is down | Meaning of the messages |
| **bridge** (new `bridge/` service) | Subscribing, parsing, filtering and mapping Frigate payloads to `EventUpsert`, plus delivery with retry | Storage, dedupe, camera registry |
| **api** | Storage, dedupe (via the external key), validation, auth | Anything MQTT-specific |

Boundary tests:
- The bridge knows Frigate's schema; the API never does.
- The API knows about duplicates; the bridge never needs state to avoid them.

### Bridge internals

| Module | Responsibility |
|---|---|
| `config` | `BridgeSettings` (pydantic-settings), read from the environment |
| `frigate` | Parses the raw MQTT payload into a typed `FrigateEvent`, and nothing more |
| `mapping` | Turns a `FrigateEvent` into an `EventUpsert`, or a `Skip` with a reason. Pure functions, no IO |
| `sink` | Sends an `EventUpsert` to the API with bounded retry, and classifies the outcome |
| `app` | Wiring: MQTT client loop → parse → map → sink. Logs and counters |

### What gets forwarded

| Frigate `type` | Action |
|---|---|
| `new` | Upsert. The event appears on the dashboard immediately |
| `update` | Upsert **only if** `top_score`, `sub_label`, `has_snapshot` or `has_clip` changed between `before` and `after`. Frigate sends updates several times a second; forwarding them all is pointless load |
| `end` | Upsert with `ended_at`. This is the final state |
| any, with `false_positive: true` | Skip (reason `false_positive`) |
| camera not in `CAMERA_MAP` and not a valid camera ID | Skip (reason `unmapped_camera`) |

### Field mapping

| `EventUpsert` | Source |
|---|---|
| `source` | Constant `"frigate"` |
| `external_id` | `after.id` |
| `camera_id` | `CAMERA_MAP.get(after.camera, after.camera)`, which must pass `CAMERA_ID_PATTERN` |
| `label` | `after.label`, which must pass `LABEL_PATTERN` (otherwise skip, reason `invalid_label`) |
| `score` | `after.top_score` (the best score over the event's life, not the current frame) |
| `started_at` / `ended_at` | `after.start_time` / `after.end_time`, epoch seconds converted to UTC |
| `thumbnail_path` | `clips/<camera>-<id>.jpg` if `has_snapshot`, else null (see Assumption 5) |
| `clip_path` | null for now. Frigate serves clips by API, not as one file; deferred |
| `attributes` | `{"sub_label", "sub_label_score", "zones": entered_zones, "frigate_attributes": attributes}` |

## Interfaces

API change, recorded in [ADR 0001](../../adr/0001-idempotent-event-upsert.md):

```
PUT /api/v1/events/by-source/{source}/{external_id}     scope: write
    body: EventCreate (camera_id, label, score, started_at, ended_at?, …)
    201  EventOut  first time this (source, external_id) is seen
    200  EventOut  existing row updated in place (same `id`)
    404  camera_id unknown       (unchanged FK behaviour)
    422  validation              (unchanged)

source:      ^[a-z0-9][a-z0-9_-]{0,31}$
external_id: ^[A-Za-z0-9._-]{1,128}$      (Frigate ids look like 1607123955.475377-mxklsc)

EventOut gains:  source: str | null, external_id: str | null
```

Bridge types are in [`interfaces.py`](interfaces.py) (signatures only).

## Sequences

### Happy path: a person walks past `front_door`

1. Frigate publishes `type=new`, id `X`, `top_score=0.81`, at QoS 1.
2. Mosquitto delivers the message to the bridge's persistent session.
3. `frigate.parse` produces a `FrigateEvent`. `mapping.to_upsert` produces an
   `EventUpsert`.
4. `sink.send` sends `PUT …/by-source/frigate/X`. The API inserts the row and
   returns **201**.
5. The bridge acknowledges the MQTT message (manual ack, after the HTTP
   result).
6. Six `update`s follow. Only the one where `top_score` rises to 0.93 is
   forwarded; the API updates the same row and returns **200**.
7. `type=end` arrives. The bridge sends a PUT with `ended_at`, and the API
   returns **200**. One row, final state.

### Failure path: the API restarts mid-event

1. `update` (`top_score` 0.93) arrives. The PUT fails with a connection
   refused error.
2. `sink` retries with exponential backoff and jitter (0.5, 1, 2, 4, 8, then
   a 30 s cap) for up to `SINK_MAX_ELAPSED` (default 120 s). The MQTT message
   stays **unacknowledged**.
3. While it retries, Mosquitto holds later messages for this session; the
   in-flight window is 1, so order is preserved.
4. The API comes back and the PUT returns 200. The bridge acknowledges the
   message.
5. **If the deadline passes first:** the bridge logs
   `event_dropped reason=api_unavailable external_id=X` and acknowledges, so
   the queue drains. The next `update` or `end` for `X` repairs the row,
   because the upsert is idempotent. Only an event whose *every* message was
   lost is gone; see Risks for reconciliation.

### Failure path: event for an unregistered camera

The API returns 404. This is permanent, so retrying is pointless. The bridge
logs `event_dropped reason=unknown_camera camera_id=…`, counts it, and
acknowledges. One warning per camera ID per hour, so a missing registration
can't flood the logs.

## Alternatives considered

| Option | Strengths | Weaknesses | Why not chosen |
|---|---|---|---|
| **A. Separate bridge service → HTTP upsert** (chosen) | Clean boundary; API stays MQTT-agnostic; same auth path as the ML worker; bridge can restart independently | Needs one API endpoint and a new service | — |
| B. MQTT subscriber inside the API process | No new service; writes directly to the DB | Couples API uptime to the broker; background thread inside uvicorn workers (one subscriber per worker means duplicates); API learns Frigate's schema | Breaks the "API knows nothing about Frigate" boundary, and multiple workers make it subtly wrong |
| C. Bridge posts only on `end`, with existing `POST` | No API change | No live view (events appear after they finish, minutes for a parked car); any lost `end` loses the whole event; retries still duplicate | Fails the no-duplicates constraint anyway |
| D. Poll Frigate's HTTP `/api/events` on a timer | No broker; easy to catch up after downtime | Latency equals the poll interval; needs a cursor to be kept; polls the NVR forever | Worse latency and more state. Kept as the **reconciliation** mechanism later (Future evolution) |
| E. Bridge keeps its own Frigate-id → API-id map, then POST + PATCH | No new endpoint pattern | Bridge becomes stateful; the map is lost on restart, producing duplicates | Moves the dedupe problem rather than solving it |

## Trade-offs

- **Gives up exactly-once.** We get at-least-once delivery plus idempotent
  writes, which has the same visible effect for an upsert.
- **Gives up intermediate `update` fidelity.** The bounding-box path and
  per-frame scores are not stored. `top_score` and the final state are.
- **Adds a broker.** That's one more container to run. Frigate needs it
  anyway for Home Assistant and similar integrations, so it's not wasted.
- **Gives up clip paths for now.** `clip_path` stays null until we decide
  whether to link to Frigate's clip API or export files.

## Risks

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Frigate `stable` tag changes the payload schema | Medium | Bridge skips or rejects everything | Pin the Frigate image to a version in this change. `frigate.parse` ignores unknown fields and skips (with a count) on missing required ones |
| Every message for an event is lost (bridge down longer than the broker's session expiry) | Low | Gap in history | Session expiry of 24 h. Later: catch up via Frigate HTTP on start (Alternative D) |
| `./data` holds both `cctv.db` and Frigate's `/media/frigate` | **Already true today** | Frigate's media retention or a careless cleanup touches the DB | Separate it: Frigate gets `./data/frigate`, and the API keeps `./data/cctv.db`. Included in the integration plan |
| Camera-name mismatch (Frigate allows `Front_Door`; the API ID pattern is lowercase) | Medium | All events for that camera dropped | `CAMERA_MAP` env var, plus a loud startup log listing the camera IDs the API knows |
| Mosquitto open to the LAN without auth | Medium | Anyone on the LAN can inject fake events | Mosquitto bound to the compose network only, with password auth from day one |
| Event volume above the assumption (busy street camera) | Low | Write contention on SQLite | Update throttling already cuts most traffic; WAL plus `busy_timeout` is already set. Revisit if p95 latency of PUT > 200 ms |

## Future evolution

**Cheap later:**
- Catching up via Frigate HTTP on bridge start.
- Forwarding `frigate/reviews` as a separate entity.
- Clip links.
- A Prometheus `/metrics` endpoint on the bridge.
- The ML worker reusing the same `PUT by-source` path with `source="ml"`.

**Expensive later:** changing the external-key model. Once rows carry
`(source, external_id)`, every consumer can rely on it. So the ADR fixes the
shape now: a source plus an opaque ID, no Frigate-specific columns.

## Context gaps

- **Not found:** any ADR directory or design docs. This creates `docs/adr/`.
  **Effect:** the conventions here are inferred from `api/` code style.
- **Not verified:** the Frigate snapshot file layout (Assumption 5) and the
  Frigate version the user will run. **Effect:** `thumbnail_path` may need a
  one-line change. **Raises confidence:** pin the version, then check one real
  snapshot path.
- **Unknown:** real cameras and event volume (Assumption 6).

## Handoff

- **Ready for:** systems-critic, then human decision on ADR 0001, then builder.
- **Open questions:**
  1. Approve the API change (`PUT …/by-source/{source}/{external_id}` plus two
     nullable columns)? It's the one contract change; everything else is
     additive.
  2. Which Frigate version should we pin? Default: the current 0.16.x
     release at build time.
  3. Should events from an unknown camera auto-register a placeholder camera,
     or be dropped as designed? Designed as drop-and-warn, because
     auto-registering needs a stream URL the bridge doesn't have.
- **Do not proceed if:** the Frigate version you pin publishes `frigate/events`
  without `after.id` / `top_score` / `start_time` (the schema the mapping
  depends on). Or if the API moves off SQLite or gains multi-tenant
  `source` semantics before this lands.
