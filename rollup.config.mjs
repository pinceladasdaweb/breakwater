import typescript from '@rollup/plugin-typescript'
import { dts } from 'rollup-plugin-dts'

// A library build must never inline dependencies: everything that is not
// the library's own source (deps, node builtins) stays external.
const external = (id) => !id.startsWith('.') && !id.startsWith('/')

export default [
  {
    input: 'src/index.ts',
    output: [
      { file: 'dist/index.cjs', format: 'cjs', exports: 'named' },
      { file: 'dist/index.mjs', format: 'es', exports: 'named' }
    ],
    plugins: [typescript({ include: ['src/**/*.ts'] })],
    external
  },
  {
    input: 'src/index.ts',
    output: { file: 'dist/index.d.ts', format: 'es' },
    plugins: [dts()],
    external
  }
]
