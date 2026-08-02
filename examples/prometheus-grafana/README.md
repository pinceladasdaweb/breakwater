# breakwater + Prometheus + Grafana, live

One command brings up a demo service protected by breakwater, a Prometheus
scraping it, and a Grafana already provisioned with the
[breakwater dashboard](../grafana/breakwater-dashboard.json):

```bash
docker compose up --build
```

| URL | What |
|---|---|
| <http://localhost:3000/d/> → **breakwater** | The dashboard (anonymous access, no login) |
| <http://localhost:8080/metrics> | The raw scrape output |
| <http://localhost:8080/> | The pipelines' aggregated `stats()` as JSON |
| <http://localhost:9090> | Prometheus itself |

Requires `breakwater` >= 0.7.0 (the release that introduced
`breakwater/prometheus`).

## What you are watching

The app protects two pipelines and generates its own traffic:

- **`payments-api`** — retry, bulkhead, circuit breaker, 500ms timeout and a
  stale-response fallback around a fake dependency with a **scripted outage:
  every 90 seconds it goes down for 20**.
- **`partner-quota`** — a rate limit of 3/s driven at ~8/s on purpose, so
  `rate_limited` rejections are always flowing.

Each outage plays the same story across the panels, in order:

1. **Pipeline duration** p95 climbs to the 500ms timeout ceiling
2. **Recovery activity** shows timeouts and retries spiking
3. **Fast rejections** briefly shows `bulkhead_full` while in-flight calls
   pile up — local pressure, not yet a verdict on the dependency
4. After 5 consecutive failures the **Circuit state** box flips to `open`
   (red) and rejections switch to `circuit_open` — failing fast now
5. **Executions** keep reporting `success`: the fallback is serving stale
   responses, which is the whole point
6. The outage ends, a `half-open` probe succeeds, the box goes green, and
   **Circuit transitions** records the full `closed → open → half-open →
   closed` lap

Note the state boxes only appear after a circuit's **first** transition —
absence of an `open` series means healthy, not unmonitored (the
[adapter docs](../../docs/prometheus.md) explain why).

## Adapting it

The demo app is ~100 lines in [`app/server.mjs`](app/server.mjs). To point
this at your own service instead: keep the `prometheusCollector()` wiring and
the `/metrics` endpoint, drop the fake dependency and the traffic loops, and
edit `prometheus/prometheus.yml` to scrape your target.

Tear down with `docker compose down`.
