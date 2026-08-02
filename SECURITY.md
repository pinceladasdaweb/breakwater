# Security Policy

## Supported versions

breakwater is pre-1.0 and fixes land on the latest release. Please reproduce
on the current version before reporting.

| Version | Supported |
|---|---|
| Latest `0.x` | ✅ |
| Anything older | ❌ |

## Reporting a vulnerability

**Please do not open a public issue.**

Use GitHub's private vulnerability reporting:
[**Report a vulnerability**](https://github.com/pinceladasdaweb/breakwater/security/advisories/new).
It opens a private thread with the maintainer, and the fix and the advisory
can be prepared before anything becomes public.

Useful things to include: the affected version, a minimal reproduction, and
what an attacker gains. A rough report sent early beats a polished one sent
late.

You can expect an acknowledgement within a few days. Once a fix is out, the
advisory is published and you are credited unless you would rather not be.

## What counts

breakwater is a library with no runtime dependencies, so it has no network
listener and no configuration file of its own. The realistic reports are
things like:

- Input that makes a policy loop, allocate without bound, or leak memory or
  timers across calls
- A protected function's result, error, or `AbortSignal` reaching a caller it
  should not — for example state bleeding between two named policies
- Prototype pollution through an options object or a custom `StateStore`
- A supply-chain problem in the published artifact itself

Out of scope: vulnerabilities in your own application code, in the
dependencies you pair breakwater with, or reports produced by a scanner
against `devDependencies` that never ship — the published package contains
`dist` only.

There is no bug bounty.
