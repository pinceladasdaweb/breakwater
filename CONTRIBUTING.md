# Contributing to breakwater

Thanks for taking the time. This is a resilience library, so the bar for
correctness is higher than usual: a bug here breaks the thing that was
supposed to keep a service standing. The rules below exist to keep that bar
where it is, not to be ceremony.

## Getting set up

```bash
git clone https://github.com/pinceladasdaweb/breakwater.git
cd breakwater
npm install
npm run hooks   # points core.hooksPath at .hooks — commit and branch checks
```

Node 22 or newer. CI runs on 22, 24 and 26.

| Command | What it does |
|---|---|
| `npm test` | The unit suite (`node --test` over the TypeScript sources via tsx) |
| `npm run test:coverage` | The same, with coverage |
| `npm run test:mutation` | [Stryker](https://stryker-mutator.io/) — grades whether the tests actually assert |
| `npm run lint` | neostandard; `npm run lint:fix` to autofix |
| `npm run check:types` | `tsc --noEmit` |
| `npm run check:types:next` | The same sources against the TypeScript 7 native compiler |
| `npm run build` | Dual ESM + CJS bundle plus the type declarations |

## The rules that are not negotiable

**The core has no runtime dependencies.** Integrations belong behind their own
entry point with the integration's package as a `peerDependency`. If a change
adds a `dependencies` entry to the core, it is the wrong change.

**Nothing may be tied to a single runtime.** The core uses web-standard APIs
(`globalThis.crypto`, `AbortSignal.any`, plain timers) and imports nothing
from `node:`. Node is the only runtime currently tested, but the code must
not assume it.

**Cancellation is not failure.** An aborted call is neither a success nor a
failure: it must not feed the circuit breaker's statistics, trigger a
fallback, or be retried. Every policy honours this, and every new one has to.

**Hot paths stay O(1).** Policies run on every protected call. Per-call array
scans, allocations and sorting belong in `stats()`, which monitoring reads,
not in admission or recording.

**Errors are identified by `code`, never by message.** Consumers branch on
the stable `code` property and the exported type guards. Messages are free to
be reworded; codes are not.

## Working on a change

Branches are prefixed with the type of change they carry, matching the commit
types: `feat/`, `fix/`, `docs/`, `test/`, `refactor/`, `perf/`, `build/`,
`ci/`, `chore/`, `style/`, `revert/` (plus `feature/` and `hotfix/`). The
pre-push hook enforces it.

Commits follow [Conventional Commits](https://www.conventionalcommits.org/) —
commitlint checks the message. The CHANGELOG is generated from commit
subjects, so write the subject for the person reading the release notes.

Open pull requests against `development`, not `main`.

## What a change needs before it lands

- **Tests that would fail without it.** Adding a policy means covering the
  cancellation path, the boundary conditions and the events it emits, not
  just the happy path.
- **Deterministic timing.** Use `mock.timers` and the `drain()` helper in
  `tests/helpers.ts`. No test may depend on real elapsed time.
- **Coverage and mutation score held.** `src` is at 100% of lines, branches
  and functions; the mutation score is above 90%. A surviving mutant that
  points at a real gap should be closed rather than accepted.
- **Documentation.** Every public export has a page or a section under
  `docs/`, with a realistic example. Documentation is not a follow-up.
- **Lint, types and build clean**, including the TypeScript 7 check.

## Reporting things

Bugs and feature requests go through the
[issue templates](https://github.com/pinceladasdaweb/breakwater/issues/new/choose).
Security vulnerabilities do **not** — see [SECURITY.md](SECURITY.md).

## Licence

Contributions are released under the [MIT licence](LICENSE) that covers the
project.
