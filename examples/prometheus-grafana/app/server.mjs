import http from 'node:http'

import { register } from 'prom-client'
import { resilience } from 'breakwater'
import { prometheusCollector } from 'breakwater/prometheus'

const metrics = prometheusCollector()

// ---------------------------------------------------------------------------
// A fake downstream with a scripted outage: every 90 seconds it goes down for
// 20. Predictable on purpose — the dashboard tells the same story every cycle:
// latency climbs, the bulkhead briefly fills, the circuit opens, fallbacks
// take over, then half-open probes recover it.
// ---------------------------------------------------------------------------
const OUTAGE_EVERY_S = 90
const OUTAGE_LASTS_S = 20

const inOutage = () => (Date.now() / 1_000) % OUTAGE_EVERY_S < OUTAGE_LASTS_S

/** Waits `ms`, honouring the pipeline's signal — cooperative by contract. */
const sleep = async (ms, signal) => {
  await new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason)
      return
    }
    const onAbort = () => {
      clearTimeout(timer)
      reject(signal.reason)
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

async function flakyDependency ({ signal }) {
  if (inOutage()) {
    // Hangs well past the policy's timeout, then refuses.
    await sleep(2_000, signal)
    throw new Error('ECONNREFUSED (scripted outage)')
  }
  await sleep(20 + Math.random() * 130, signal)
  if (Math.random() < 0.02) throw new Error('sporadic 502 (scripted)')
  return { ok: true }
}

// ---------------------------------------------------------------------------
// Two protected pipelines sharing one collector: the `name` label is what
// splits them apart on every panel.
// ---------------------------------------------------------------------------
const payments = resilience({
  name: 'payments-api',
  retry: { attempts: 3 },
  bulkhead: { concurrency: 8 },
  circuitBreaker: { consecutiveFailures: 5, halfOpenAfter: 15_000 },
  timeout: 500,
  fallback: () => ({ ok: true, stale: true }),
  metrics
})

const quota = resilience({
  name: 'partner-quota',
  rateLimit: { limit: 3, interval: 1_000 },
  metrics
})

// Self-generated traffic, so the dashboard moves without anyone curling:
// payments at ~5 rps, and the quota deliberately over its limit so
// rate_limited rejections always show.
setInterval(() => { payments.execute(flakyDependency).catch(() => {}) }, 200)
setInterval(() => { quota.execute(() => 'cheap lookup').catch(() => {}) }, 120)

http.createServer((req, res) => {
  if (req.url === '/metrics') {
    register.metrics().then((body) => {
      res.setHeader('Content-Type', register.contentType)
      res.end(body)
    }, (error) => {
      res.statusCode = 500
      res.end(String(error))
    })
    return
  }
  // The aggregated stats() double as a human-readable health endpoint.
  res.setHeader('Content-Type', 'application/json')
  res.end(JSON.stringify({
    outage: inOutage(),
    'payments-api': payments.stats(),
    'partner-quota': quota.stats()
  }, null, 2))
}).listen(8080, () => { console.log('demo app listening on :8080 — /metrics for Prometheus, / for stats()') })
