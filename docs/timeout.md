# Timeout

Bounds the time of each execution. When the budget is exceeded, the context's
`AbortSignal` aborts and the call rejects with a typed [`TimeoutError`](errors.md).

```ts
import { timeout } from '@pinceladasdaweb/breakwater'

const policy = timeout(2_000)

const data = await policy.execute(({ signal }) => fetch(url, { signal }))
```

## Signature

```ts
timeout(ms: number, options?: TimeoutOptions): TimeoutPolicy
```

| Option | Type | Default | Description |
|---|---|---|---|
| `ms` | `number` | — (required) | Time budget per execution, in milliseconds |
| `mode` | `'cooperative' \| 'aggressive'` | `'cooperative'` | What happens when the budget is exceeded (below) |

## The two modes

### `cooperative` (default) — abort and wait

When the timer fires, the policy aborts the signal passed to your function and
**waits** for it to observe the abort and settle. Nothing keeps running
unobserved — but your function must honor the signal.

```ts
const policy = timeout(2_000) // cooperative

await policy.execute(async ({ signal }) => {
  // fetch, undici, pg, and most modern clients accept an AbortSignal
  return await fetch('https://api.example.com/slow', { signal })
})
// rejects with TimeoutError (code 'TIMEOUT') after 2s
```

Cooperative semantics after the deadline, precisely:

| Your function, after the timer fired… | Result |
|---|---|
| rejects because of the abort (our reason, or an `AbortError`) | `TimeoutError` (original error in `cause` when normalized) |
| rejects with a **genuine domain error** | that domain error, untouched — never masked as a timeout |
| resolves anyway (ignored the signal) | the value is returned; **no** `timeout` event is emitted |

### `aggressive` — reject immediately, orphan the work

When the timer fires, the call rejects with `TimeoutError` **immediately**; the
original promise keeps running orphaned (its eventual rejection is silenced).
Use it only when the function cannot be trusted to observe the signal — and be
aware the work leaks:

```ts
const policy = timeout(2_000, { mode: 'aggressive' })

await policy.execute(() => legacyClientWithNoAbortSupport.query(sql))
// rejects after exactly 2s even though the query is still running
```

In aggressive mode external cancellation also rejects promptly — the caller is
never held hostage by a function that ignores signals.

## Cancellation vs timeout

External cancellation (your `AbortSignal` passed via `execute` options) is
**never** reported as a timeout: the call rejects with your abort reason, no
`timeout` event is emitted, and downstream policies treat it as cancellation.

```ts
const controller = new AbortController()
const promise = policy.execute(({ signal }) => fetch(url, { signal }), { signal: controller.signal })

controller.abort(new Error('user navigated away'))
await promise // rejects with 'user navigated away', NOT TimeoutError
```

## Events

| Event | Payload | When |
|---|---|---|
| `timeout` | `{ ms, mode, correlationId }` | The call's outcome was a timeout (not on late success, not on cancellation) |

```ts
policy.on('timeout', ({ ms, correlationId }) => {
  log.warn({ ms, correlationId }, 'execution timed out')
})
```

## Real-world examples

### HTTP with fetch

```ts
const httpTimeout = timeout(3_000)

export const getQuote = httpTimeout.wrap(
  async (symbol: string) => await fetch(`https://quotes.example.com/${symbol}`).then(r => r.json())
)
```

> With `wrap` the function does not receive the signal. For real HTTP calls
> prefer `execute` and pass the signal through — that is what makes the
> cooperative mode effective.

### PostgreSQL query

```ts
import pg from 'pg'
const pool = new pg.Pool()

const dbTimeout = timeout(500)

const user = await dbTimeout.execute(async ({ signal }) => {
  const client = await pool.connect()

  try {
    signal.addEventListener('abort', () => { void pool.query(`SELECT pg_cancel_backend(${client.processID})`) }, { once: true })
    return await client.query('SELECT * FROM users WHERE id = $1', [id])
  } finally {
    client.release()
  }
})
```

## Gotchas

- **Validate your budget**: `ms` must be a positive finite number — `timeout(0)`
  throws `RangeError` at construction time, not at call time.
- **Timers do not leak**: the internal timer is cleared as soon as the call
  settles, and it intentionally keeps the process alive while a call is in
  flight (an exit mid-call would leave the promise forever unsettled).
- **A timeout inside `compose` aborts only its own subtree** — the outer
  context's signal is untouched, so an outer `fallback` still activates on
  `TimeoutError`. See [composition ordering](composition.md).
