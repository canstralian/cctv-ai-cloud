---
agent: systems-critic
subject: Frigate → API event bridge design + ADR 0001
date: 2026-10-06
confidence: medium-high
inputs:
  - docs/design/frigate-bridge/architecture.md
  - docs/design/frigate-bridge/interfaces.py
  - docs/design/frigate-bridge/integration-plan.md
  - docs/adr/0001-idempotent-event-upsert.md
  - Frigate source and docs at tags v0.16.4, v0.17.2, v0.18.0 (docs/docs/integrations/mqtt.md, frigate/events/cleanup.py, frigate/api/event.py)
  - api/app/** (current main)
---

# Review: Frigate bridge design

## Steelman

Frigate already does the hard part: it detects, tracks and publishes every
object over MQTT. The cheapest way to get real data into the API is a thin,
stateless translator. MQTT gives durable delivery while the bridge is down.
An upsert keyed on Frigate's own event ID makes every retry and refinement
harmless, so the bridge never needs to remember anything. The API stays
ignorant of Frigate; the bridge stays ignorant of storage. The upsert is a
generic `(source, external_id)` key, so the ML worker reuses it instead of
inventing a second ingest path. Each integration step is additive and can be
reverted. That's a sound shape, and nothing below argues for a different one.

## Strengths

- **The boundary is clean and testable.** `parse` and `to_upsert` are pure
  functions, `Clock` is injected, and the sink returns outcomes rather than
  raising. The whole bridge can be tested offline against recorded payloads.
- **The idempotency is in the right place.** It's in the store, with an
  atomic single-statement upsert. The SQLite form was actually run, and a
  real bug was caught before it shipped.
- **The payload dependency is stable.** The `frigate/events` section of
  Frigate's MQTT docs is **byte-identical between v0.16.4 and v0.18.0**
  (verified by diff), so the version pin is low-risk.
- **The snapshot path is right.** `clips/<camera>-<id>.jpg` matches
  `frigate/events/cleanup.py` and `frigate/api/event.py` at v0.18.0
  (Assumption 5 is now verified).

## Findings

Ranked by expected cost: how often it fires times what it breaks.

### F1: Snapshot links rot by design · severity: high · confidence: high
**Category:** Failure modes / Evidence gaps
**What breaks:** `thumbnail_path` points to a file Frigate deletes on its
own schedule. `frigate/events/cleanup.py` unlinks
`clips/<camera>-<id>.jpg` (plus the `-clean.webp` / `-clean.png` variants)
when Frigate's snapshot retention expires. The API keeps the row for
`EVENT_RETENTION_DAYS` (30). Whenever Frigate's retention is shorter, every
older event shows a broken thumbnail.
**Under what conditions:** On any install where Frigate's snapshot
retention is shorter than the API's. *Inferred:* Frigate's default snapshot
retention is 10 days, so this fires from day 11 on a default install.
**Evidence:** The cleanup code is verified. The default retention value
wasn't checked in source.
**Class of remedy:** Treat `thumbnail_path` as a best-effort link whose
lifetime is owned elsewhere. Either tie the two retention settings together
explicitly, or have consumers expect a missing file. Also say which root the
path is relative to: the API doesn't record it today.

### F2: A dropped `end` is never repaired · severity: high · confidence: high
**Category:** Failure modes
**What breaks:** The failure path says that after the retry deadline, "the
next `update` or `end` for X repairs the row." That's true for every message
**except the last one**. If `end` is the message dropped, nothing follows it.
The row keeps `ended_at = null` forever and reads as an ongoing event on the
dashboard indefinitely.
**Under what conditions:** The API is unavailable for longer than
`SINK_MAX_ELAPSED` (120 s) while any event ends. A slow API restart, a
container rebuild or a disk-full stall all qualify, so this happens on
ordinary operations days, not just disasters.
**Evidence:** Follows directly from the design's own sequence. No external
evidence needed.
**Class of remedy:** Either the terminal message must not be droppable
(durable local spool, or don't acknowledge until delivered), or catch-up is
required for v1 rather than "Future evolution": Alternative D, querying
Frigate's `/api/events` for recently ended events.

### F3: Retrying inside the MQTT callback stalls the connection · severity: high · confidence: medium
**Category:** Hidden complexity / Operational
**What breaks:** The design retries for up to 120 s while holding the
message unacknowledged, with an in-flight window of 1. In paho-mqtt, message
callbacks run on the network-loop thread. If the retry sleeps there, keepalive
pings stop. The broker drops the client after 1.5× keepalive (90 s at paho's
default 60 s), which is before the 120 s deadline. That causes a reconnect
storm and redelivery, and nothing is logged as the cause.
- Separately, `max_inflight_messages 1` is a **broker-wide** Mosquitto
  setting. It throttles every subscriber, including Home Assistant if that's
  added later, not just the bridge.
- During a long outage, Mosquitto's per-client queue cap
  (`max_queued_messages`, default 1000) drops messages **silently, on the
  broker**, where the bridge's "fail visible" counters can't see it.
**Under what conditions:** Any API outage longer than about 90 s.
**Evidence:** *Inferred* from paho-mqtt's threading model and Mosquitto's
documented defaults. Not run.
**Class of remedy:** Decouple receiving from delivering (a bounded hand-off
between the MQTT thread and a delivery worker). Keep flow control
per-client rather than broker-wide, and make broker-side drops observable.

### F4: The update filter drops zone changes, and the reason for it was wrong · severity: medium · confidence: high
**Category:** Evidence gaps / Failure modes
**What breaks:** The architecture says Frigate sends updates "several times
a second." The Frigate docs say otherwise: a message is published only
"when Frigate finds a better snapshot … or when a zone change occurs"
(verified, v0.16–v0.18). So the throttle saves little.
- It also **drops zone changes**: `entered_zones` is mapped into
  `attributes.zones`, but zones aren't in the `is_material_update` predicate.
  Zones stay stale until `end`, which matters for any "person entered
  driveway" use.
- If the `end` is lost too (F2), the zones are lost permanently.
**Under what conditions:** Every event that crosses a zone.
**Evidence:** Verified, Frigate mqtt.md at three tags.
**Class of remedy:** Revisit whether the throttle is needed at all, given
the verified message rate. If it stays, the predicate must cover every
mapped field.

### F5: The startup check needs a scope the bridge doesn't have · severity: medium · confidence: high
**Category:** Hidden complexity (doc contradicts doc)
**What breaks:** The Risks table relies on "a loud startup log listing the
camera IDs the API knows" to catch name mismatches. But the integration
plan's security checklist gives the bridge key "`write` scope only."
`GET /api/v1/cameras` requires `read` (`security.py`, `RequireRead`). So the
startup listing either fails with 403 or someone quietly widens the key.
**Under what conditions:** Always.
**Evidence:** Verified, from both design docs and `api/app/security.py`.
**Class of remedy:** Decide one way: the key gets `read`, or the mismatch
check moves elsewhere (for example, the API logs unknown-camera 404s by
camera ID).

### F6: Any write key can overwrite any source's events · severity: medium · confidence: high
**Category:** Security / Governance leaks
**What breaks:** ADR 0001 says `source` is a free label. Any principal with
`write` can `PUT …/by-source/ml/<id>`, or `…/frigate/<id>` with a different
camera before the first write, and overwrite or squat on another producer's
rows. Today the only `write` holders are trusted services, which limits the
risk. But the ADR justifies the generic key by future producers, and that's
exactly when it matters.
**Under what conditions:** A compromised or misconfigured producer key, or
a buggy producer reusing the wrong `source`.
**Evidence:** Verified. `ApiKey` has `name` and `scopes` but no source
binding (`config.py`).
**Class of remedy:** Bind each key to the `source` values it may write. The
key name is a natural default.

### F7: The broker trusts any authenticated publisher · severity: medium · confidence: medium
**Category:** Security
**What breaks:** Password auth stops anonymous LAN clients, but any client
with *any* valid MQTT credential can publish to `frigate/events` and inject
detections. That includes the Home Assistant install this broker is
presumably for (the architecture's own justification for the broker).
**Under what conditions:** As soon as a second MQTT client exists.
**Evidence:** *Inferred* from the design, which specifies password auth but
no topic ACLs.
**Class of remedy:** Per-user topic ACLs: only the Frigate user may publish
to `frigate/#`, and the bridge user may only subscribe.

### F8: A silent bridge looks the same as a quiet site · severity: medium · confidence: high
**Category:** Operational
**What breaks:** At 3 a.m. with the bridge crash-looping (for example, a
401 after key rotation, which is "fatal, exit non-zero" plus `restart:
unless-stopped`), the dashboard shows "no events", which looks the same as
"nothing happened." There's no freshness signal anywhere a human looks.
**Under what conditions:** Key rotation, a broker credential change, or a
Frigate MQTT misconfiguration.
**Evidence:** Verified. The design has logs and counters but no health
check, no surfaced metric, and no "last ingest" in `/api/v1/stats`.
**Class of remedy:** An ingest-freshness signal people can see: a compose
health check on the bridge, plus a "last event received per source" reading
that the dashboard can show as stale.

### F9: Concurrent startup migration · severity: low · confidence: medium
**Category:** Failure modes
**What breaks:** ADR 0001 runs `ALTER TABLE … ADD COLUMN` behind a
`PRAGMA user_version` check at startup. With more than one uvicorn worker or
replica starting together, both read version 0, both alter, and the second
fails with "duplicate column" and won't boot.
**Under what conditions:** The moment someone adds `--workers N`. Compose
runs one worker today, so the risk is currently latent.
**Evidence:** *Inferred.* `db.init_db` is called on startup. Worker count
was checked in `docker-compose.yml`.
**Class of remedy:** Check the version and alter inside one exclusive write
transaction, or make each step tolerate already being applied.

## Hidden assumptions

1. **The API is down for less than 120 s, or no event ends while it's
   down.** This is load-bearing for F2. It's stated nowhere.
2. **Frigate's `start_time` for an ID never changes between `new` and
   `end`.** The ADR's 409 rule depends on it. The docs example shows it
   stable across before and after, but no guarantee is documented. If
   Frigate ever adjusts it, legitimate updates become 409s and are
   permanently rejected.
3. **The bridge is the only process that reads `frigate/events` with that
   client ID.** Two bridge replicas with the same fixed ID would kick each
   other off the broker in a loop.
4. **Frigate's and the API's retention settings are related.** They
   aren't (F1).

## Missing evidence

- A real `frigate/events` capture from the pinned version. One recorded
  `new` / `update` / `end` set would turn Hidden assumption 2 and the F4
  message rate from documentation into observation, and becomes the test
  fixtures anyway.
- Frigate's default `snapshots.retain` in v0.18.0 source, to confirm F1's
  timing.
- paho-mqtt's version and callback threading model as pinned, to move F3 from
  medium to high confidence or clear it.

## Not applicable / cleared

- **Circular reasoning:** cleared. Idempotency is in the store and relies on
  nothing from the bridge.
- **Determinism / replay:** cleared. `parse` and `to_upsert` are pure, the
  clock is injected, and epoch→ISO is deterministic for the same float.
  Message order is preserved.
- **Scale:** cleared at the stated assumption (tens of events a minute). The
  first limit at 10× is the broker queue cap in F3, not SQLite. WAL plus a
  single upsert per message has headroom.
- **Maintenance:** cleared. A few hundred lines, one dependency on a schema
  that was stable across three Frigate releases. Ownership is clear.

## Recommendations

1. **F2 + F3 together:** this is the delivery model. It's the one change that
   affects the architecture's shape, because catch-up moves from "future" to
   v1 and receive/deliver get split. Revise it before building.
2. **F1:** decide who owns snapshot lifetime before the dashboard renders
   thumbnails (step 2 depends on it).
3. **F5, F6, F7:** credential and scope model, one small decision each.
   Cheap now, expensive after keys are deployed.
4. **F4:** drop or fix the throttle, a one-line decision.
5. **F8:** add the freshness signal. Small, and the dashboard needs it.
6. **F9:** fold into the migration implementation. No design change.

None of these argue against the chosen shape (Alternative A + ADR 0001). All
of them are revisions inside it.

## Handoff

- **Ready for:** runtime-architect (revision of the delivery model and
  credentials sections), then builder.
- **Open questions:**
  1. For F2: durable local spool, or Frigate HTTP catch-up? The second also
     covers bridge downtime longer than the broker session, so it's likely
     the better fit.
  2. For F1: should the API keep its own copy of each thumbnail, or treat
     Frigate's as best-effort?
- **Do not proceed if:** building starts on step 5 (`bridge/`) before F2/F3
  are resolved in the architecture. Steps 1–3 (pin Frigate, ADR 0001 API
  change, Mosquitto) aren't affected by any finding except F6/F7/F9, which
  are refinements, and can start now.
