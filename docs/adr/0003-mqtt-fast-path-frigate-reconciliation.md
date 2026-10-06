# ADR 0003: MQTT for live delivery, Frigate's events API for catch-up

- **Status:** Accepted (2026-10-06)
- **Context doc:** [Frigate bridge architecture rev 2](../design/frigate-bridge/architecture.md), review findings F2/F3

## Context

MQTT QoS 1 delivers at least once while the bridge's session lives. It
doesn't help with:
- a bridge down past the broker's session expiry
- an HTTP delivery that gave up
- a full queue
- a crash between receiving and delivering

In particular, losing an event's final (`end`) message leaves its row
"in progress" forever (F2).

## Decision

Two inputs, one idempotent output:

- **Live:** subscribe to `frigate/events` → bounded queue → one delivery
  worker → `PUT by-source` (ADR 0001).
- **Catch-up:** on start, on MQTT reconnect, every `RECONCILE_INTERVAL`
  (10 min), and early after any delivery that gave up or any queue
  overflow:
  1. Page through Frigate's `GET /api/events` for `now − RECONCILE_LOOKBACK`
     (6 h) → now.
  2. Enqueue every record into the same worker.
  3. No cursor is stored. The overlap is free because writes are idempotent.

Correctness comes from catch-up; MQTT only provides speed. Neither path keeps
state that has to survive a restart.

## Consequences

**Positive:**
- Every loss mode within the lookback window repairs itself, whatever the
  cause.
- The bridge stays stateless.
- A disk spool, and its corruption and fsync concerns, isn't needed.

**Negative:**
- Frigate's API becomes a dependency, so the bridge needs a Frigate viewer
  credential.
- There's a periodic query load on Frigate (small at the assumed volume).
- Gaps older than the lookback window need a one-off manual run with a
  larger `RECONCILE_LOOKBACK`.

**Neutral:** the HTTP and MQTT record shapes differ (`zones` vs
`entered_zones`, `data.top_score` vs `top_score`). There are two parsers and
one internal type.

## Alternatives

| Alternative | Why not |
|---|---|
| Disk spool of undelivered messages | Covers only one of the loss modes above |
| Catch-up only | Live latency would equal the catch-up interval |
| Stored cursor | Adds state for no gain over an idempotent overlap |

## Revisit when

- Event volume makes a 6-hour lookback query expensive for Frigate.
- Frigate offers a durable change feed.
