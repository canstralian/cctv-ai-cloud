# CCTV AI Cloud

Self-hosted CCTV/NVR with a cloud web interface and AI/ML enhancement hooks.

## Services

| Service | What it is | Port |
|---|---|---|
| `api` | FastAPI control plane — camera registry, detection events, stats | 8000 |
| `web` | React UI | 5173 |
| `ml` | Inference worker (YOLO via ultralytics) | — |
| `nvr` | Frigate NVR | 5000, 8554 |

## Quick start

```bash
cp .env.example .env      # optional; dev defaults work without it
docker compose up -d
```

Or run just the API against a local virtualenv:

```bash
./scripts/run-api.sh      # http://127.0.0.1:8000 — interactive docs at /docs
./scripts/test-api.sh     # pytest suite
```

## API

Interactive docs are served at `/docs`; the OpenAPI document is at `/openapi.json`.

```
GET    /health                     liveness  (open)
GET    /ready                      readiness, checks the database  (open)

GET    /api/v1/cameras             list, filter by ?enabled=, paginate
POST   /api/v1/cameras             register a camera
GET    /api/v1/cameras/{id}
PATCH  /api/v1/cameras/{id}        partial update
DELETE /api/v1/cameras/{id}        cascades to that camera's events

GET    /api/v1/events              ?camera_id= &label= &min_score= &since= &until=
POST   /api/v1/events              ingest a detection (NVR / ML worker)
GET    /api/v1/events/{id}
DELETE /api/v1/events/{id}

GET    /api/v1/stats               fleet + detection summary for the dashboard
```

Errors share one envelope, and every response carries an `X-Request-ID` that also
appears in the logs:

```json
{"error": {"code": "not_found", "message": "Camera 'ghost' does not exist.",
           "request_id": "d971cced94ae4aa0af467f1db09bb73b"}}
```

### Authentication

Everything under `/api` requires a credential; `/health` and `/ready` are open.

* **Machine clients** (NVR, ML worker) send `X-API-Key`. Keys are configured as
  `API_KEYS=name:secret:scope|scope`, scopes being `read` and `write`.
* **The web UI** sends `Authorization: Bearer <jwt>`, signed with `JWT_SECRET`.
  Mint one for local work:

  ```bash
  cd api && ../.venv/bin/python -m app.token --sub dashboard --scope read
  ```

Write endpoints require the `write` scope; reads require `read`.

Outside `ENV=dev` the API **refuses to start** unless `JWT_SECRET` is a real
value of at least 32 characters, `CORS_ORIGINS` is an explicit list rather than
`*`, and `AUTH_DISABLED` is off. That check is deliberate: the bearer path is
always enabled, so a placeholder secret would let anyone mint a valid token.

RTSP stream URLs commonly embed camera credentials. They are stored as given but
**never returned in full** — the API redacts userinfo on the way out
(`rtsp://***:***@192.168.1.50:554/h264`).

## Configuration

All settings come from the environment or a repo-root `.env`; see
[`.env.example`](.env.example) for the annotated list.

## Storage

SQLite, via the stdlib — no ORM to install and no database server to run, which
suits a sidecar to a self-hosted NVR. The schema is created on startup and lives
in `data/cctv.db` (`/data/cctv.db` inside the containers).

## Tests

```bash
./scripts/test-api.sh
```

53 tests covering auth and scope enforcement, credential redaction, CRUD,
filtering, pagination, validation limits, and the fail-closed startup checks.

## Roadmap

Shipped so far is the API slice. Still to come:

- **web** — replace the Vite starter template with a live dashboard against `/api/v1`
- **ml** — inference worker that posts detections to `POST /api/v1/events`
- **nvr** — real Frigate camera config and an MQTT bridge into the event ingest
- **ci** — GitHub Actions running the test suite on every push
- **ops** — Dockerfiles pinned per service, and the event-retention prune job
  (`EVENT_RETENTION_DAYS` and `prune_older_than` exist; nothing schedules them yet)
