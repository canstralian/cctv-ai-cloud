# Frigate Bridge: Integration Plan (rev 2)

Each step ships green on its own and can be reverted on its own. Steps 1–4
can merge before the bridge exists.

| # | Change | Touches | Breaks | Rollback |
|---|---|---|---|---|
| 1 | **Pin and close Frigate:** image `0.18.0@sha256:9678a83a…14d35`. **Stop publishing port 5000** (unauthenticated) and publish `8971` (authenticated) instead. Move media to `./data/frigate`. Create a Frigate viewer user for the bridge | `docker-compose.yml`, `nvr/config.yml`, `.gitignore`, README | Anything on the LAN using `:5000` must switch to `:8971` and log in. Existing recordings in `./data/*` need moving | Revert the compose lines |
| 2 | **ADR 0001 (amended):** `source`/`external_id` columns, partial unique index, `BEGIN IMMEDIATE` migration, `PUT by-source`, `API_KEYS` 4th field (source binding), `last_ingest_at` in stats | `api/app/{db,config,security,schemas}.py`, `repositories/events.py`, `routers/events.py`, `routers/stats.py`, tests | Nothing: existing `POST` and 3-field keys are unchanged | Columns are nullable and unused by old code |
| 3 | **ADR 0002:** thumbnail `PUT`/`GET`, atomic file write, size and type checks, deletes on row delete/cascade/prune, orphan sweep, `has_thumbnail` on `EventOut` | `api/app/**`, tests, `.env.example` (`THUMBNAIL_MAX_BYTES`) | `EventOut.thumbnail_path` → `has_thumbnail` (no consumers exist yet) | Revert; files in `data/thumbnails/` can be deleted |
| 4 | **Mosquitto:** password file, **ACL file** (`frigate`: write `frigate/#`; `bridge`: read `frigate/events`), listener on the compose network only, persistence on, session expiry 24 h | `docker-compose.yml`, `nvr/mosquitto/{mosquitto.conf,acl}`, `.env.example` | Nothing | Remove the service |
| 5 | **Frigate MQTT on:** host `mosquitto`, user `frigate`, password via `{FRIGATE_MQTT_PASSWORD}`, plus one test camera | `nvr/config.yml` | Nothing | `mqtt.enabled: false` |
| 6 | **`bridge/` service** per `interfaces.py`. First task: verify the Frigate 8971 login flow (architecture Assumption 6). Compose health check on `/healthz`. Add a `bridge` path filter to `ci.yml` with a `bridge-validation.yml` | `bridge/**`, `docker-compose.yml`, `.github/workflows/` | Nothing | Stop the service |
| 7 | **Docs/runbook:** register cameras with IDs that match Frigate's names, the one-off long-lookback catch-up, and reading `/healthz` | README | — | — |

## Test strategy

- **Step 2:**
  - 201 → 200 with the same `id`.
  - 409 on a changed `camera_id`/`started_at`.
  - 403 when the key isn't bound to the source; 403 for a JWT.
  - A 3-field key can't reach `by-source`.
  - Running the migration twice is a no-op.
  - Two connections migrating at once leave one schema.
  - Concurrent same-key PUTs leave one row.
- **Step 3:**
  - 413 over the cap; 415 when the bytes aren't JPEG.
  - A replace leaves no temp file behind.
  - Event delete, camera cascade and prune each remove the file.
  - The orphan sweep removes files with no row and keeps files that have one.
- **Step 6, offline (fakes for MQTT, Frigate and the API, plus a fake
  clock):**
  - `parse_mqtt` / `parse_http` against **recorded 0.18.0 payloads**,
    captured during step 5.
  - Mapping table tests.
  - Worker order per ID.
  - Queue overflow is counted and triggers early catch-up.
  - Gave-up triggers early catch-up.
  - Catch-up paging and the window bounds.
  - Thumbnail fetch on the first snapshot and on `end`, and on catch-up only
    when `has_thumbnail` is false.
  - Health turns unhealthy only on the stated conditions.
- **End to end (manual, once):**
  1. Stop the API.
  2. Walk past the camera.
  3. Wait for the event to end.
  4. Start the API.
  5. Within one catch-up interval there should be exactly one row, with
     `ended_at` set and a thumbnail.

## Security checklist

- Frigate: only 8971 published; the bridge uses a **viewer** user.
- Mosquitto: no host port; password auth plus ACLs; `frigate` is the only
  publisher on `frigate/#`.
- API: the bridge key is `write`, bound to `source=frigate`, and named
  `frigate-bridge` so it can be revoked on its own.
- Thumbnail upload: size cap, magic-byte check, filenames from the event
  UUID only (never from client input), atomic rename.
- No secret appears in logs or in `/healthz`.
