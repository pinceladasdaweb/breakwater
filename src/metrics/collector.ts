/**
 * The interface metrics adapters implement. Every method is optional — a
 * collector implements only what it cares about. `breakwater/prometheus`
 * and `breakwater/otel` are implementations of this interface; the core
 * never imports either client.
 */
export interface MetricsCollector {
  /**
   * One completed execution through the pipeline. Cancelled executions
   * (context signal aborted) are not reported: cancellation is neither a
   * success nor a failure anywhere in breakwater, metrics included.
   */
  onExecution?: (event: {
    policy: string
    name?: string
    outcome: 'success' | 'failure'
    durationMs: number
    correlationId: string
  }) => void
  onRetry?: (event: { name?: string, attempt: number, delayMs: number }) => void
  onTimeout?: (event: { name?: string, ms: number }) => void
  onStateChange?: (event: { name?: string, from: string, to: string }) => void
  onFallback?: (event: { name?: string, handlerIndex: number }) => void
  onReject?: (event: { policy: string, name?: string, reason: 'circuit_open' | 'isolated' | 'bulkhead_full' | 'rate_limited' }) => void
}
