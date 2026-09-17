# Dependency Maintenance

This repository has two dependency surfaces:

- npm packages managed by the root `pnpm-lock.yaml`
- vendored reference repositories under `repos/`, currently `repos/effect`

The vendored repositories are for source-level reference. Application code must
continue importing from normal package dependencies, not from `repos/*`.

## Upgrade npm Dependencies

Check what is stale:

```bash
pnpm outdated -r
```

Upgrade normal dependencies to the latest registry versions:

```bash
pnpm update -r --latest <package...>
```

Effect v4 packages are published on RC versions while some package `latest`
tags still point at Effect v3-compatible releases. Upgrade Effect packages by
the RC tag or by the exact version from `repos/effect/packages/*/package.json`:

```bash
pnpm update -r @effect/atom-react@rc @effect/platform-bun@rc @effect/platform-node@rc @effect/sql-libsql@rc @effect/vitest@rc effect@rc
```

After changing manifests, regenerate the lockfile:

```bash
pnpm install
```

Run at least:

```bash
pnpm check
pnpm test
pnpm lint
```

Use `pnpm audit` for a full security gate.

## September 2026 audit remediation

At `de0190543c`, separate production and development audits found six production
findings and two development findings. The root audit script stops after a failed
production audit, so run both separately when investigating a failure.

| Dependency                | Baseline | Fixed resolution | Affected workspace paths                                                                    |
| ------------------------- | -------- | ---------------- | ------------------------------------------------------------------------------------------- |
| Astro                     | 7.2.1    | 7.2.8            | Docs directly and through Starlight, MDX, and expressive-code                               |
| sharp                     | 0.35.3   | 0.35.4           | Each docs Astro path                                                                        |
| js-yaml                   | 4.3.1    | 4.3.2            | Docs Astro, Starlight, markdown helpers, and Jira CLI through gray-matter                   |
| SVGO                      | 4.0.2    | 4.1.0            | Each docs Astro path                                                                        |
| Vitest and @vitest/mocker | 4.1.10   | 4.1.11           | Root and workspace test tooling, including Effect Vitest, coverage, and Rly browser tooling |

Official advisories establish the patched versions:
[Astro AVIF processing](https://github.com/advisories/GHSA-26w7-cxv4-gfx2),
[Astro base-path authorization](https://github.com/advisories/GHSA-376h-93r7-7g6f),
[sharp libheif](https://github.com/advisories/GHSA-rgj7-g3m4-5g8c),
[js-yaml merge sources](https://github.com/advisories/GHSA-2883-xcg3-v3hh),
[SVGO executable links](https://github.com/advisories/GHSA-w27v-7q3p-w38r),
[SVGO foreignObject](https://github.com/advisories/GHSA-4vpr-x523-8j87), and
[Vitest redirect mocks](https://github.com/advisories/GHSA-82fw-gwwq-j7x9).

Astro 7.2.8 requires markdown-remark 7.2.4 and sharp `^0.35.4`; its other
transitive changes follow the published Astro manifest. SVGO 4.1.0 satisfies
Astro's `^4.0.1` range, so a targeted lockfile refresh replaces the old SVGO override.
Vitest's browser and coverage packages require matching Vitest versions and move
together to 4.1.11.

The existing js-yaml override advances from 4.3.1 to 4.3.2. Astro and its helpers
accept this patch. Gray-matter still requests `^3.13.1`; Jira CLI already replaces
its default engine with direct js-yaml `load`/`dump` calls in both frontmatter and
sync-document handling. Keep the frontmatter and sync tests as compatibility
coverage. Direct js-yaml 5.2.3 consumers remain unchanged.

The existing CI Audit job guards the resolved graph. Validate with separate
`pnpm audit --prod` and `pnpm audit --dev` runs, followed by `pnpm run audit`, a
frozen install, the docs build, and the full formatting, lint, type and test gates.
No publishable runtime manifest changes are needed for this remediation.

## Update the Effect Subtree

`repos/effect` is a squash-imported git subtree from the canonical
`https://github.com/Effect-TS/effect.git` repository. The remote is named
`effect-upstream`. The former `effect-smol` repository is archived and must not
be used for current updates.

Add the canonical remote if it is missing:

```bash
git remote add effect-upstream https://github.com/Effect-TS/effect.git
```

Before every fetch, fail closed unless that remote still resolves to the exact
canonical URL:

```bash
node scripts/check-effect-reference-alignment.mjs --check-remote
```

Do not fetch when this check fails. Correct or remove a mismatched remote and
add the canonical URL again before continuing.

Choose the exact Effect release used by the workspace, then fetch and update the
vendored source from that release tag. Do not pull `main`: it can contain APIs
that have not reached the installed RC yet.

```bash
effect_version=4.0.0-rc.109
effect_tag="effect@${effect_version}"
git fetch effect-upstream "refs/tags/${effect_tag}"
git subtree pull --prefix=repos/effect effect-upstream "${effect_tag}" --squash
```

Preserve the subtree merge commit and its squash parent when the change lands.
Pull requests that update `repos/effect` must use GitHub's merge-commit method;
squash or rebase merging discards the retained `git-subtree-split` provenance
that the alignment guard verifies.

Then align workspace Effect package versions to the versions in the updated
subtree. The most common packages are:

```bash
node -e "const fs=require('fs'); for (const p of ['repos/effect/packages/effect/package.json','repos/effect/packages/platform/node/package.json','repos/effect/packages/platform/bun/package.json','repos/effect/packages/sql/libsql/package.json','repos/effect/packages/atom/react/package.json','repos/effect/packages/vitest/package.json']) { const j=JSON.parse(fs.readFileSync(p,'utf8')); console.log(j.name, j.version) }"
```

Keep the subtree as reference material unless a task explicitly asks to update
the vendored source. Do not make application fixes inside `repos/effect`.

Update `scripts/effect-reference.json` with the release tag, upstream commit,
and imported Git tree whenever the pinned release changes. The focused alignment
guard resolves and peels that tag from the verified canonical remote, so an
offline or missing upstream tag lookup fails closed instead of trusting the
recorded commit. Run it before the complete lint gate:

```bash
node scripts/check-effect-reference-alignment.mjs --self-test
node scripts/check-effect-reference-alignment.mjs
pnpm lint
```

## Agent and Editor Notes

The subtree pattern follows the Effect article
["The One Weird Git Trick That Makes Coding Agents More Effect-ive"](https://website-content-git-feat-how-to-subtree-effect-ts.vercel.app/blog/the-one-weird-git-trick-that-makes-coding-agents-more-effect-ive/):
vendor source under `repos/`, configure agents to use it as reference material,
and keep editor tooling from treating it as application source.

This repository already excludes `repos/` from Prettier and ESLint. If using
VSCode, also exclude `repos/**` from search, file watching, and TypeScript /
JavaScript auto-import suggestions in local editor settings.
