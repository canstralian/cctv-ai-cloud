# Frigate Bridge: Integration Plan

Order matters: each step ships and stays green on its own, and nothing
downstream depends on a later step.

| # | Change | Touches | Breaks | Rollback |
|---|---|---|---|---|
| 1 | **Pin Frigate** to a specific version instead of `stable`; move Frigate media to `./data/frigate` | `docker-compose.yml`, `.gitignore` | Existing recordings in `./data/*` stop being visible to Frigate (move them, or start fresh) | Revert the compose line |
| 2 | **ADR 0001 API change**: `source`/`external_id` columns, partial unique index, `PRAGMA user_version` migration, `PUT …/by-source/{source}/{external_id}`, fields on `EventOut` | `api/app/db.py`, `schemas.py`, `repositories/events.py`, `routers/events.py`, tests | Nothing: additive; `POST` unchanged | Columns are nullable and unused by old code; revert the code and leave the columns |
| 3 | **Mosquitto service**: password file, listener on the compose network only (no host port), persistence on, `max_inflight_messages 1` | `docker-compose.yml`, `nvr/mosquitto/mosquitto.conf`, `.env.example` | Nothing | Remove the service |
| 4 | **Frigate MQTT on**: `mqtt.enabled: true`, host `mosquitto`, credentials via `{FRIGATE_MQTT_PASSWORD}` env substitution; one test camera | `nvr/config.yml` | Nothing | `mqtt.enabled: false` |
| 5 | **`bridge/` service**: modules per `interfaces.py`, unit tests on recorded Frigate payloads (fixtures), compose service with `BRIDGE_API_KEY` | `bridge/**`, `docker-compose.yml`, `.env.example`, new `bridge-validation.yml` workflow | Nothing | Stop the service |
| 6 | **Docs**: README services table, roadmap tick, a "register your cameras with IDs matching Frigate names" note | `README.md` | — | — |

## Test strategy

- **API (step 2):**
  - First PUT gives 201; the same PUT again gives 200 with the same `id`.
  - A changed `camera_id` gives 409.
  - An unknown camera gives 404.
  - A row created by `POST` is untouched.
  - Migration on a pre-existing DB is idempotent.
  - Two concurrent PUTs with the same key leave one row.
- **Bridge (step 5), offline, no broker:**
  - `parse` against recorded payloads for `new` / `update` / `end` /
    malformed / missing field.
  - `to_upsert` table tests for every `SkipReason` and the field mapping.
  - `sink` with a fake transport and a fake `Clock`: 201, 200, 404 (no
    retry), 5xx → retry → 200, deadline exhausted, 401 (fatal).
- **End to end (manual, once):**
  1. `mosquitto_pub` a recorded `new`, `update` and `end` for one event.
  2. Expect exactly one row in `GET /api/v1/events?camera_id=…`, with
     `ended_at` set.

## Security checklist

- Mosquitto has no host port and requires auth.
- The bridge API key has `write` scope only, and its own key name
  (`frigate-bridge`), so it can be revoked on its own.
- Neither secret is logged; the settings `repr` masks them.
- Frigate's `privileged: true` is unchanged here, but flagged for the ops
  step.
