const leakedDiffImplementations: ReadonlyArray<string> = [
  "@pierre/diffs",
  "diffs-container",
  "DiffCodeView-module",
  "WorkerPoolManager",
  "/assets/worker-"
]

export const renderNormalEntryConsumer = (): string =>
  `import * as Root from "@knpkv/rly"
import * as Patterns from "@knpkv/rly/patterns"
import * as Primitives from "@knpkv/rly/primitives"
const exportCount = Object.keys(Root).length + Object.keys(Patterns).length + Object.keys(Primitives).length
if (exportCount === 0) throw new Error("Normal package entries exported no values")
`

export const renderNormalEntryViteConfig = (): string =>
  `const root = new URL(".", import.meta.url).pathname
export default {
  build: {
    lib: {
      entry: new URL("src/normal-entries.js", import.meta.url).pathname,
      fileName: "normal-entries",
      formats: ["es"]
    },
    minify: false,
    outDir: new URL("dist-normal", import.meta.url).pathname,
    rollupOptions: { external: ["react", "react/jsx-runtime", "react-dom"] }
  },
  logLevel: "silent",
  root
}
`

export const findLeakedDiffImplementation = (bundle: string): string | undefined =>
  leakedDiffImplementations.find((implementation) => bundle.includes(implementation))
