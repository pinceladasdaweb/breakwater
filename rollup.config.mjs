import typescript from '@rollup/plugin-typescript'
import { dts } from 'rollup-plugin-dts'

// A library build must never inline dependencies: everything that is not
// the library's own source (deps, node builtins) stays external.
const external = (id) => !id.startsWith('.') && !id.startsWith('/')

// A subpath entry that uses core RUNTIME (otel's spanPolicy builds on
// basePolicy) must import the shipped core bundle, never carry a private
// copy: identity-sensitive values in the core (the never-aborted signal
// sentinel) have to stay singletons across entry points. Types are not
// affected — the dts bundles keep inlining, interfaces have no identity.
// Core modules a subpath may use at RUNTIME. Each one is re-exported by the
// core entry, so the bundle imports it from there instead of carrying a
// private copy — identity-sensitive values stay singletons, and the shipped
// code is not the same module twice.
const CORE_MODULES = ['policy', 'circuit-breaker/state-store', 'circuit-breaker/window']
const isCore = (id) => CORE_MODULES.some((module) => id === `../${module}` || id.endsWith(`/${module}`))
const corePaths = (format) => (id) =>
  isCore(id) ? (format === 'es' ? './index.mjs' : './index.cjs') : id

// One pair of configs per public entry point. Each subpath bundles its own
// tree — entry points stay independent, so importing breakwater/prometheus
// never loads the core and vice versa. `core: true` is the exception above:
// the code bundle then imports the core entry instead of duplicating it.
const entry = (input, name, { core = false } = {}) => [
  {
    input,
    output: [
      { file: `dist/${name}.cjs`, format: 'cjs', exports: 'named', ...(core && { paths: corePaths('cjs') }) },
      { file: `dist/${name}.mjs`, format: 'es', exports: 'named', ...(core && { paths: corePaths('es') }) }
    ],
    plugins: [typescript({ include: ['src/**/*.ts'] })],
    external: core ? (id) => external(id) || isCore(id) : external
  },
  {
    input,
    // The .d.cts is a byte-identical copy: the declarations contain nothing
    // module-kind-sensitive, and emitting both here keeps the build script a
    // plain `rollup -c` however many entry points exist.
    output: [
      { file: `dist/${name}.d.ts`, format: 'es' },
      { file: `dist/${name}.d.cts`, format: 'es' }
    ],
    plugins: [dts()],
    external
  }
]

export default [
  ...entry('src/index.ts', 'index'),
  ...entry('src/prometheus/index.ts', 'prometheus'),
  ...entry('src/otel/index.ts', 'otel', { core: true }),
  ...entry('src/redis/index.ts', 'redis', { core: true })
]
