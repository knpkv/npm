import { createRequire } from "node:module"

// TypeScript 7 has no JavaScript compiler API. Resolve the TypeScript 6
// compatibility package's real compiler for ts-patch without pinning pnpm's
// virtual-store layout.
const compatibilityRequire = createRequire(import.meta.resolve("typescript"))

console.log(compatibilityRequire.resolve("@typescript/old"))
