# Implementation plan

1. Record requirements and audit the existing security, route, benchmark, build, and CI evidence.
2. Add failing focused tests for benchmark acceptance semantics, route-inventory drift, browser build reuse, and the trusted HTTPS journey.
3. Implement benchmark report v2 with deterministic machine eligibility and a two-second warmed portfolio p95 gate.
4. Add the explicit production-route browser audit matrix using existing route fixtures and axe-core.
5. Extend the real-runtime fixture with an owned test HTTPS proxy and exercise the second-machine pairing/navigation path.
6. Remove the redundant browser dependency prebuild, add benchmark release commands/artifacts to CI, and document the exact gate.
7. Run focused unit/browser/benchmark checks, then format, lint, type-check, full tests, and the repository-wide verification gate.
8. Review the exact head for standards and specification compliance, publish the pull request, resolve exact-head feedback, and merge only when every gate is green.
