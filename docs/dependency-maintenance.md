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

## Update the Effect Subtree

`repos/effect` is a squash-imported git subtree from the canonical
`https://github.com/Effect-TS/effect.git` repository. The remote is named
`effect-upstream`. The former `effect-smol` repository is archived and must not
be used for current updates.

Check the configured remote:

```bash
git remote -v | rg effect-upstream
```

If the remote is missing, add it:

```bash
git remote add effect-upstream https://github.com/Effect-TS/effect.git
```

Choose the exact Effect release used by the workspace, then fetch and update the
vendored source from that release tag. Do not pull `main`: it can contain APIs
that have not reached the installed RC yet.

```bash
effect_version=4.0.0-rc.109
effect_tag="effect@${effect_version}"
git fetch effect-upstream "refs/tags/${effect_tag}"
git subtree pull --prefix=repos/effect effect-upstream "${effect_tag}" --squash
```

Then align workspace Effect package versions to the versions in the updated
subtree. The most common packages are:

```bash
node -e "const fs=require('fs'); for (const p of ['repos/effect/packages/effect/package.json','repos/effect/packages/platform/node/package.json','repos/effect/packages/platform/bun/package.json','repos/effect/packages/sql/libsql/package.json','repos/effect/packages/atom/react/package.json','repos/effect/packages/vitest/package.json']) { const j=JSON.parse(fs.readFileSync(p,'utf8')); console.log(j.name, j.version) }"
```

Keep the subtree as reference material unless a task explicitly asks to update
the vendored source. Do not make application fixes inside `repos/effect`.

Update `scripts/effect-reference.json` with the release tag, upstream commit,
and imported Git tree whenever the pinned release changes. Then run the focused
alignment guard before the complete lint gate:

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
