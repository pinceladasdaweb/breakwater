export type EventMap = Record<string, unknown>

export type Listener<T> = (payload: T) => void

/**
 * Minimal typed event emitter.
 *
 * Deliberately not Node's EventEmitter: listeners are fully typed per event,
 * and a listener that throws never breaks the execution pipeline — the error
 * is routed to `onListenerError` instead.
 */
export interface TypedEmitter<E extends EventMap> {
  on: <K extends keyof E>(event: K, listener: Listener<E[K]>) => void
  off: <K extends keyof E>(event: K, listener: Listener<E[K]>) => void
  emit: <K extends keyof E>(event: K, payload: E[K]) => void
}

/**
 * Event subscription surface shared by every policy.
 *
 * `on`/`off` return the policy itself so subscriptions can be chained.
 */
export interface Observable<E extends EventMap> {
  on: <K extends keyof E>(event: K, listener: Listener<E[K]>) => this
  off: <K extends keyof E>(event: K, listener: Listener<E[K]>) => this
}

const defaultListenerErrorReporter = (error: unknown): void => {
  console.error('breakwater: event listener threw', error)
}

/**
 * Attaches the chainable on/off surface to a policy object, in place.
 * Mutating (instead of spreading) preserves getters and keeps the
 * self-reference: on/off return the finished policy object.
 */
export function withObservable<P extends object, E extends EventMap> (
  target: P,
  emitter: TypedEmitter<E>
): P & Observable<E> {
  const result = target as P & Observable<E>
  const on: Observable<E>['on'] = (event, listener) => {
    emitter.on(event, listener)
    return result
  }
  const off: Observable<E>['off'] = (event, listener) => {
    emitter.off(event, listener)
    return result
  }
  Object.assign(result, { on, off })
  return result
}

export function createEmitter<E extends EventMap> (
  onListenerError: (error: unknown) => void = defaultListenerErrorReporter
): TypedEmitter<E> {
  const listeners = new Map<keyof E, Set<Listener<never>>>()

  return {
    on (event, listener) {
      let set = listeners.get(event)
      if (set === undefined) {
        set = new Set()
        listeners.set(event, set)
      }
      set.add(listener as Listener<never>)
    },

    off (event, listener) {
      listeners.get(event)?.delete(listener as Listener<never>)
    },

    emit (event, payload) {
      const set = listeners.get(event)
      if (set === undefined || set.size === 0) return
      // Snapshot: a listener that subscribes another listener during emit
      // must not have the new one invoked for the in-flight event.
      for (const listener of [...set]) {
        try {
          (listener as Listener<typeof payload>)(payload)
        } catch (error) {
          onListenerError(error)
        }
      }
    }
  }
}
