import { assertPositiveInt } from '../validate'

/** One cached result: the value plus when it was stored (epoch ms). */
export interface CacheEntry<T = unknown> {
  value: T
  storedAt: number
}

/**
 * Advisory information handed to `set` alongside the entry. A store may
 * use it (a remote store setting a native expiry) or ignore it entirely —
 * the policy enforces `maxAge` on the read side regardless.
 */
export interface CacheSetHints {
  /** The policy's maxAge, when bounded — a natural expiry for the entry. */
  maxAgeMs?: number
}

/**
 * The storage behind a staleCache policy. Every method may be sync or
 * async, so an implementation can live in memory or behind a network hop
 * (a shared store is planned).
 *
 * Two rules for implementations beyond memoryCache:
 *
 * - Values crossing a process boundary must be plain serializable data —
 *   a Date, a Map or a class instance will not survive the round trip.
 *   The by-reference behavior documented on memoryCache is specific to
 *   memory storage.
 * - One store shared between DIFFERENT policies needs disjoint keys (a
 *   per-policy prefix, configured on the store adapter): the policy's
 *   default key is `''`, so two policies on one bare store would silently
 *   serve each other's responses.
 *
 * Errors are contained by role: the policy reports a throwing store to
 * `console.error` and carries on — a broken cache can cost the rescue,
 * never the execution's own outcome. Only `clear()` on the policy (a
 * manual control call) lets store errors propagate.
 */
export interface CacheStore<T = unknown> {
  get: (key: string) => CacheEntry<T> | undefined | Promise<CacheEntry<T> | undefined>
  set: (key: string, entry: CacheEntry<T>, hints?: CacheSetHints) => void | Promise<void>
  /** Optional: remove one key (dynamic key sets on a shared store). */
  delete?: (key: string) => void | Promise<void>
  /** Optional: drop everything; backs the policy's clear(). */
  clear?: () => void | Promise<void>
}

export interface MemoryCacheOptions {
  /**
   * Entry cap; the least-recently-written key is evicted first. Only
   * matters with a `key` extractor — the default single-slot policy uses
   * one entry total. Default: 1024.
   */
  maxEntries?: number
}

/**
 * The built-in in-memory CacheStore: a Map with least-recently-written
 * eviction. Values are held (and served) BY REFERENCE — cache values you
 * are happy to hand to several callers, or clone before storing. Expiry
 * hints are ignored: the policy already enforces maxAge on the read side.
 */
export function memoryCache<T = unknown> (options: MemoryCacheOptions = {}): CacheStore<T> {
  const { maxEntries = 1024 } = options
  assertPositiveInt('maxEntries', maxEntries)

  const entries = new Map<string, CacheEntry<T>>()

  return {
    get: (key) => entries.get(key),

    set (key, entry) {
      // Delete-then-set refreshes the key's position: Map iterates in
      // insertion order, so the first key is always the stalest write.
      entries.delete(key)
      entries.set(key, entry)
      if (entries.size > maxEntries) {
        const oldest = entries.keys().next().value
        if (oldest !== undefined) entries.delete(oldest)
      }
    },

    delete (key) {
      entries.delete(key)
    },

    clear () {
      entries.clear()
    }
  }
}
