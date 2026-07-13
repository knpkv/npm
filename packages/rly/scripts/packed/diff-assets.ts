export interface PackedDiffArtifacts {
  readonly wasm: string
  readonly worker: string
}

export interface PackedDiffArtifactSources {
  readonly diffEntry: string
  readonly wasmFileName: string
  readonly workerFileName: string
  readonly workerSource: string
}

export const findPackedDiffArtifacts = (
  entries: ReadonlyArray<string>
): PackedDiffArtifacts | undefined => {
  const worker = entries.find((entry) => /^package\/dist\/assets\/worker-[\w-]+\.js$/.test(entry))
  const wasm = entries.find((entry) => /^package\/dist\/assets\/wasm-[\w-]+\.js$/.test(entry))
  return worker === undefined || wasm === undefined ? undefined : { wasm, worker }
}

export const validatePackedDiffArtifactSources = ({
  diffEntry,
  wasmFileName,
  workerFileName,
  workerSource
}: PackedDiffArtifactSources): string | undefined => {
  if (!diffEntry.includes(workerFileName) || /["']\/assets\/worker-[\w-]+\.js["']/.test(diffEntry)) {
    return "Packed diff worker URL is not package-relative"
  }
  if (!workerSource.includes(wasmFileName)) {
    return "Packed diff worker does not reference its WASM runtime"
  }
  return undefined
}
