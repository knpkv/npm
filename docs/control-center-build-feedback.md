# Control Center build feedback

The Control Center production build reports these timed phases in order:

1. dependency artifact validation and repair;
2. source-boundary validation;
3. output cleanup;
4. client bundle;
5. server bundle;
6. server declaration emit;
7. distribution-integrity validation.

The dependency phase validates the workspace packages' advertised public files
before any bundle work. It clears stale TypeScript build metadata and rebuilds
only packages with missing artifacts, then rechecks the contract. The
declaration phase removes only
Control Center's build-info file and compiles the Control Center project. It
does not use `--force`, which would also rebuild every unchanged referenced
package. The build still starts from an empty `dist` directory and finishes with
the existing generated-output, package-export, packed-consumer, build-graph,
and declaration-integrity checks.

To reproduce a package timing after its workspace dependencies have been built:

```bash
time pnpm --filter @knpkv/control-center build
```

## Recorded baseline

These measurements were captured on 2026-07-19 in the repository Nix shell.
The shell selected Node 22.21.1 even though Control Center declares Node 24 or
newer, so compare the phase proportions rather than treating the absolute times
as a CI budget.

| Control Center phase    |        Before |  After |
| ----------------------- | ------------: | -----: |
| dependency artifacts    | not separated |  0.69s |
| source boundaries       |         1.87s |  1.17s |
| output cleanup          | not separated |  0.07s |
| client bundle           |         1.91s |  0.84s |
| server bundle           |         2.18s |  1.33s |
| server declarations     |        52.66s | 12.22s |
| distribution integrity  |        21.10s | 16.21s |
| measured package phases |   about 79.7s | 31.84s |

The former post-Vite quiet tail was the forced declaration graph followed by
distribution validation. Both now have explicit start and completion output.

The former hook ran format, lint, a full build, `check` (which ran a second full
build), and tests. Measured components reconstruct to about 507s: format 8.71s,
lint 54.46s, two 161.92s full builds, package checks 50.09s, and tests 70.27s.
On the same warm worktree the Control Center scoped components total about 111s:
staged formatting 0.46s, ast-grep 1.39s, scoped lint 24.77s, build (including a
0.69s dependency artifact check) 32.58s, check 22.75s, and tests 28.59s.

## Pre-commit scopes

`pnpm precommit` defaults to `changed`. It checks staged files without rewriting
them, builds affected packages and their workspace dependencies, then typechecks
and runs unit and packed-package tests for affected packages and their transitive
workspace dependents. Root Vitest registration determines unit-test membership,
regardless of package test scripts. Affected workspace executable smoke cases also
run. Deleted paths and both sides of renames stay in scope.

Before either mode runs, stage or stash every unstaged tracked edit and every
untracked check input: configured workspaces from `pnpm-workspace.yaml`, shared
tooling, root configs, `.changeset/**` and `docs/debt*`. The gate checks staged
content only. Any recreated staged deletion is rejected, regardless of directory
or Git ignore rules. Other ignored build outputs and unrelated scratch files remain allowed. Changeset coverage and changed Effect
diagnostics retain their branch or pending-merge comparison base. The hook always
runs changed Effect diagnostics on staged TypeScript files, including Control
Center tests. The former Control Center-only path skipped this check: #778 passed
locally, then failed CI on `strictEffectProvide` in a new test.
Gitignored files reachable from staged code are visible to local checks; CI checks a clean checkout.

Root configuration, lockfiles, workspace definitions, `scripts/`, `ast-grep/`,
`.github/`, `.husky/`, vendored references and patches select the full repository
gate. Package `vitest*.config.*` and `tsconfig*.json` or `.jsonc` files also select
full. Any edit inside a package targeted by a cross-package relative JS/TS import
selects full, covering its private helpers too. TypeScript parses literal
specifiers, including comments. The scan excludes generated/vendor importers;
computed/dynamic paths, custom loaders, arbitrary file reads, aliases without
manifest dependencies and non-JS/TS importers are not followed. `PRECOMMIT_MODE=full pnpm precommit` also selects
it. A clean empty index runs nothing. `PRECOMMIT_MODE=changed` cannot bypass shared-input checks.

Changed mode also runs focus rings, test-typecheck coverage, script portability,
workspace exports and security documentation examples across the repository.
Package manifest edits also run Effect tsconfig coverage. Root `check` typechecks
`scripts/tsconfig.json` alongside the root project.

Local Vitest runs use half the available cores, rounded down with at least one
worker. Set `PRECOMMIT_MAX_WORKERS` to a positive integer to override that limit.
The changed gate shares one worker pool across the selected packages. The full
local gate applies the same limit. CI worker settings are unchanged.

Run the full repository gate explicitly with:

```bash
pnpm verify:full
```

Main's active ruleset requires Check's `Format`, `Lint`, `Audit`, `Types`, `Test`,
`Edge runtimes`, and `Browser` status checks. The strict up-to-date requirement is
disabled. `Lint` requires both static lint and changeset coverage; `Test` requires
unit and packed-package tests; `Browser` requires every browser matrix suite.
This is the enforced full gate on main.

CI continues to run its independent full format, lint, build, check, test, and
browser jobs. The browser job uses the same manifest-based dependency repair,
runs the route and trusted-HTTPS journeys, executes the deterministic contract
benchmark, and validates the runtime report produced by the full browser suite.
It does not rebuild the complete Control Center dependency graph a second time
for benchmark validation. The scoped hook is a feedback optimization, not a
replacement for the full gate.
