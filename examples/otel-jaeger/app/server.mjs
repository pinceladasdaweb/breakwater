import http from 'node:http'

import { SpanStatusCode, trace } from '@opentelemetry/api'
import { NodeSDK } from '@opentelemetry/sdk-node'
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http'
import { PrometheusExporter } from '@opentelemetry/exporter-prometheus'
import {
  attachMetrics, circuitBreaker, compose, exponential, fallback,
  metricsPolicy, resilience, retry, timeout
} from 'breakwater'
import { otelCollector, spanPolicy } from 'breakwater/otel'

// ---------------------------------------------------------------------------
// OpenTelemetry SDK first — sdk.start() MUST run before otelCollector() below:
// the metrics API has no late-binding proxy, so a collector created earlier
// would be silently no-op forever (imports are hoisted; what matters is call
// order). Traces go to Jaeger over OTLP; metrics are served on :9464.
// ---------------------------------------------------------------------------
const sdk = new NodeSDK({
  serviceName: 'breakwater-demo',
  traceExporter: new OTLPTraceExporter({ url: `${process.env.OTLP_URL ?? 'http://jaeger:4318'}/v1/traces` }),
  metricReader: new PrometheusExporter({ port: 9464 })
})
sdk.start()

const collector = otelCollector()
const tracer = trace.getTracer('demo-app')

// ---------------------------------------------------------------------------
// A fake downstream with a scripted outage: every 90 seconds it goes down for
// 20. Predictable on purpose — Jaeger tells the same story every cycle:
// attempt spans go red one by one, the circuit opens, the pipeline span stays
// green on the fallback, then half-open probes recover it.
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

// The dependency opens its own span through the PLAIN OTel API — it nests
// under breakwater's attempt span automatically, because spanPolicy keeps
// its span active while the protected function runs.
async function flakyDependency ({ signal }) {
  return await tracer.startActiveSpan('charge downstream', async (span) => {
    try {
      if (inOutage()) {
        await sleep(2_000, signal) // hangs well past the timeout policy
        throw new Error('ECONNREFUSED (scripted outage)')
      }
      await sleep(20 + Math.random() * 130, signal)
      if (Math.random() < 0.02) throw new Error('sporadic 502 (scripted)')
      return { ok: true }
    } catch (error) {
      span.recordException(error)
      span.setStatus({ code: SpanStatusCode.ERROR, message: error.message })
      throw error
    } finally {
      span.end()
    }
  })
}

// ---------------------------------------------------------------------------
// The trace story, outermost to innermost: one pipeline span per checkout,
// one attempt span per retry (spanPolicy sits INSIDE the retry), and the
// dependency's own span under each attempt. During the outage the pipeline
// span stays OK — the fallback answered — while its children show exactly
// which attempts burned and why.
// ---------------------------------------------------------------------------
const payments = compose(
  metricsPolicy(collector, { name: 'payments-api' }),
  spanPolicy({ name: 'payments-api', spanName: 'checkout pipeline' }),
  fallback(() => ({ ok: true, stale: true })),
  retry({ attempts: 3, backoff: exponential({ initial: 50, max: 400 }) }),
  spanPolicy({ name: 'payments-api', spanName: 'checkout attempt' }),
  circuitBreaker({ name: 'payments-api', consecutiveFailures: 5, halfOpenAfter: 15_000 }),
  timeout(500)
)
attachMetrics(payments, collector, { name: 'payments-api' })

// A second pipeline sharing the collector: rate-limit rejections keep the
// breakwater.rejections series moving, split by the name attribute.
const quota = resilience({
  name: 'partner-quota',
  rateLimit: { limit: 3, interval: 1_000 },
  metrics: collector
})

// Self-generated traffic, so Jaeger and Prometheus move without anyone
// curling: checkouts at ~5 rps, and the quota deliberately over its limit.
setInterval(() => { payments.execute(flakyDependency).catch(() => {}) }, 200)
setInterval(() => { quota.execute(() => 'cheap lookup').catch(() => {}) }, 120)

http.createServer((req, res) => {
  // The aggregated stats() double as a human-readable health endpoint.
  res.setHeader('Content-Type', 'application/json')
  res.end(JSON.stringify({
    outage: inOutage(),
    'payments-api': payments.stats(),
    'partner-quota': quota.stats()
  }, null, 2))
}).listen(8080, () => {
  console.log('demo app listening on :8080 — stats() as JSON; metrics on :9464/metrics')
})
