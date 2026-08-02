import typescript from '@rollup/plugin-typescript'
import { dts } from 'rollup-plugin-dts'

// A library build must never inline dependencies: everything that is not
// the library's own source (deps, node builtins) stays external.
const external = (id) => !id.startsWith('.') && !id.startsWith('/')

// One pair of configs per public entry point. Each subpath bundles its own
// tree — entry points stay independent, so importing breakwater/prometheus
// never loads the core and vice versa.
const entry = (input, name) => [
  {
    input,
    output: [
      { file: `dist/${name}.cjs`, format: 'cjs', exports: 'named' },
      { file: `dist/${name}.mjs`, format: 'es', exports: 'named' }
    ],
    plugins: [typescript({ include: ['src/**/*.ts'] })],
    external
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
  ...entry('src/prometheus/index.ts', 'prometheus')
]
