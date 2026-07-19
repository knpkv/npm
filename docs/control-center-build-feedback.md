# Control Center build feedback

The Control Center production build reports these timed phases in order:

1. source-boundary validation;
2. output cleanup;
3. client bundle;
4. server bundle;
5. server declaration emit;
6. distribution-integrity validation.

The declaration phase removes only Control Center's build-info file and compiles
the Control Center project. It does not use `--force`, which would also rebuild
every unchanged referenced package. The build still starts from an empty `dist`
directory and finishes with the existing generated-output, package-export,
packed-consumer, build-graph, and declaration-integrity checks.

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
staged formatting 0.46s, ast-grep 1.39s, scoped lint 24.77s, dependency artifact
check 0.69s, build 32.58s, check 22.75s, and tests 28.59s.

## Pre-commit scopes

`pnpm precommit` reads staged paths and selects one of three conservative gates:

- documentation-only changes run Prettier against the staged paths;
- changes confined to `packages/control-center` (plus Markdown or MDX companions)
  run the Effect static checks, Control Center lint/build/check/test, and builds
  only missing public artifacts of Control Center's workspace dependencies;
- every other change runs the full repository gate.

Run the authoritative local gate explicitly with:

```bash
pnpm verify:full
```

CI continues to run its independent full format, lint, build, check, test, and
browser jobs. The scoped hook is a feedback optimization, not a replacement for
the full gate.
