#!/usr/bin/env node
/**
 * Generates dist/package.json for publishing.
 */
import { readFileSync, writeFileSync } from "fs"

const pkg = JSON.parse(readFileSync("package.json", "utf-8"))

const out = {
  name: pkg.name,
  version: pkg.version,
  description: pkg.description,
  license: pkg.license,
  author: pkg.author,
  repository: pkg.repository,
  bugs: pkg.bugs,
  homepage: pkg.homepage,
  keywords: pkg.keywords,
  exports: {
    ".": "./index.js"
  },
  peerDependencies: pkg.peerDependencies,
  dependencies: pkg.dependencies
}

writeFileSync("dist/package.json", JSON.stringify(out, null, 2) + "\n")
