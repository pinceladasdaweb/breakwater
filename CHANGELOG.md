# CHANGELOG

## 0.6.0 (2026-08-01)

* fix: report one metrics name per policy when a registry entry is renamed by Pedro Rogério [View](https://github.com/pinceladasdaweb/breakwater/commit/818ea9d9182490a3cdc3903ba0a8b8312dc0f0cc)
* refactor: drop two unreachable guards that mutation testing exposed by Pedro Rogério [View](https://github.com/pinceladasdaweb/breakwater/commit/11ee256d9f08883d75ba60d603fa8ba99e02fc6a)
* test: add Stryker mutation testing and close the gaps it found by Pedro Rogério [View](https://github.com/pinceladasdaweb/breakwater/commit/7c8f0c786da71919bff09c14db3a1890be200a83)


## 0.5.4 (2026-07-29)

* test: use Promise.withResolvers for deferred gates by Pedro Rogério [View](https://github.com/pinceladasdaweb/breakwater/commit/1ef59fe1355e55143ddad780751ea9f2e939c85c)


## 0.5.3 (2026-07-29)

* chore: raise lib to ES2024 by Pedro Rogério [View](https://github.com/pinceladasdaweb/breakwater/commit/54a9fc6320a48034bcd50e8b800ba14d019d7bf1)
* ci: add Node 26 to the test matrix by Pedro Rogério [View](https://github.com/pinceladasdaweb/breakwater/commit/1db1a385c0474f2a4908870c9157f832d43735c6)


## 0.5.2 (2026-07-28)

* refactor: drop the last node: imports from the core by Pedro Rogério [View](https://github.com/pinceladasdaweb/breakwater/commit/6847063e11a8bcf2328619788372665034a129c2)


## 0.5.1 (2026-07-26)

* test: assert the collector-error report instead of printing it by Pedro Rogério [View](https://github.com/pinceladasdaweb/breakwater/commit/0cf82797272ac3d8026539b228541b1e0bf8370f)


## 0.5.0 (2026-07-26)

* feat(minor): add attachMetrics, metricsPolicy and aggregated stats by Pedro Rogério [View](https://github.com/pinceladasdaweb/breakwater/commit/24b86a477c1d26c11447ae9e6feb4b58ed40d76b)
* fix: harden metrics tooling after adversarial review by Pedro Rogério [View](https://github.com/pinceladasdaweb/breakwater/commit/d725a46cf48cc5f190b3c515255ee8b01f1b495f)
* docs: cover the custom-policy building blocks by Pedro Rogério [View](https://github.com/pinceladasdaweb/breakwater/commit/861fde393ad69a1edb32056eeaa735767fc86df5)


## 0.4.0 (2026-07-26)

* feat(minor): add named policy registry by Pedro Rogério [View](https://github.com/pinceladasdaweb/breakwater/commit/d6a8e799cd92a2a55ced815bc2b094f5d5c2451d)


## 0.3.0 (2026-07-26)

* feat(minor): add rate limit policy by Pedro Rogério [View](https://github.com/pinceladasdaweb/breakwater/commit/3fb583bafc59377ac56754b291bd83953a5064db)


## 0.2.0 (2026-07-26)

* ci: create a GitHub release with changelog notes on publish by Pedro Rogério [View](https://github.com/pinceladasdaweb/breakwater/commit/dea53fd9af79b3a534525a11f692f6f4b3188bb8)
* docs: add migration guidance learned from real-world integration by Pedro Rogério [View](https://github.com/pinceladasdaweb/breakwater/commit/65cb30f82464c3e084721650d9fda2d1aea8f5d1)
* feat(minor): add bulkhead policy by Pedro Rogério [View](https://github.com/pinceladasdaweb/breakwater/commit/478ad8e66ed277ee4cfe0916a783ae63c08bf326)
