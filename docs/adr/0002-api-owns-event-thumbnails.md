# ADR 0002: The API stores its own copy of each event thumbnail

- **Status:** Accepted (2026-10-06)
- **Context doc:** [Frigate bridge architecture rev 2](../design/frigate-bridge/architecture.md), review finding F1

## Context

The API keeps events for `EVENT_RETENTION_DAYS` (30). Frigate deletes its
snapshot files after its own retention period, which defaults to **10 days**
(`frigate/config/camera/snapshots.py`, v0.18.0), via
`frigate/events/cleanup.py`. 0.18 also changed the on-disk format to
`<camera>-<id>-clean.webp`; rendered JPEGs are served by
`GET /api/events/{id}/snapshot.jpg`. A path into Frigate's media therefore
breaks on two independent schedules: retention expiry and format changes
between versions.

## Decision

The API stores, serves and deletes thumbnails for the events it keeps.
Frigate is where a thumbnail comes from, never where it's stored.

- `PUT /api/v1/events/by-source/{source}/{external_id}/thumbnail` takes
  `image/jpeg` up to `THUMBNAIL_MAX_BYTES` (default 512 KiB) and checks the
  JPEG magic bytes. It writes `<DATA_DIR>/thumbnails/<event_id>.jpg`
  atomically (write to a temp file, then rename), replacing any previous
  copy.
- `GET /api/v1/events/{id}/thumbnail` (scope `read`) serves it.
- The file's lifetime follows the row. Event delete, camera cascade and the
  retention prune all remove it. The prune job also sweeps files whose row is
  gone, so a crash between deleting the row and deleting the file can't leak.
- `EventOut.thumbnail_path` is replaced by `has_thumbnail: bool` plus the
  GET route. `POST` keeps accepting `thumbnail_path` for compatibility, but
  it's documented as an unmanaged, best-effort pointer.

## Consequences

**Positive:**
- A row and its thumbnail live and die together.
- Frigate upgrades and retention changes can't break historical events.
- The dashboard needs no access to Frigate.

**Negative:**
- Disk cost of roughly 1.5–4.5 GB at 1,000 events a day for 30 days.
- The API now handles binary uploads: a size cap, a type check and atomic
  writes are needed.
- Two places hold the image until Frigate's copy expires.

**Neutral:** clips are still not copied. A clip is orders of magnitude
larger, so copying them is a separate decision if it's ever wanted.

## Alternatives

| Alternative | Why not |
|---|---|
| Store a path into Frigate's media | Breaks at Frigate's retention (10 days) and on format changes |
| Raise Frigate's snapshot retention to match | Couples two configs that drift independently, and is still broken by format changes |
| API proxies requests to Frigate's `snapshot.jpg` | Same lifetime problem, plus a runtime dependency on Frigate being up and reachable from the API |

## Revisit when

- Thumbnail disk use exceeds roughly 10 % of the data volume: move to a
  separate volume or object storage behind the same API routes.
- Clips become a requirement.
