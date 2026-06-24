/**
 * External sidecar storage for ADF placeholder metadata.
 *
 * Markdown stays readable by replacing large `attrs={...}` / `node={...}`
 * blobs with `ref=./page.adf.json#id`; the sidecar stores decoded JSON.
 *
 * @module
 */
import * as Schema from "effect/Schema"

export type AdfMetadataKind = "attrs" | "marks" | "node"

export const AdfMetadataEntrySchema = Schema.Struct({
  kind: Schema.Literals(["attrs", "marks", "node"]),
  value: Schema.Unknown
})

export const AdfMetadataSidecarSchema = Schema.Struct({
  version: Schema.Literal(1),
  entries: Schema.Record(Schema.String, AdfMetadataEntrySchema)
})

export type AdfMetadataEntry = typeof AdfMetadataEntrySchema.Type
export type AdfMetadataSidecar = typeof AdfMetadataSidecarSchema.Type

const stableStringify = (v: unknown): string => {
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(",")}]`
  if (v !== null && typeof v === "object") {
    const entries = Object.entries(v as Record<string, unknown>)
      .filter(([, value]) => value !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, value]) => `${JSON.stringify(k)}:${stableStringify(value)}`)
    return `{${entries.join(",")}}`
  }
  return JSON.stringify(v) ?? "null"
}

const markerKinds: ReadonlyArray<AdfMetadataKind> = ["node", "attrs", "marks"]

const markerType = (line: string): string => {
  const match = /<!--\s*adf:([A-Za-z][A-Za-z0-9]*)/.exec(line)
  return match?.[1] ?? "metadata"
}

const externalizeLine = (
  line: string,
  sidecarHref: string,
  nextId: (type: string) => string,
  entries: Record<string, AdfMetadataEntry>
): string => {
  if (!line.includes("<!-- adf:") || line.includes("<!-- adf:/")) return line
  const end = line.lastIndexOf("-->")
  if (end === -1) return line

  for (const kind of markerKinds) {
    const needle = ` ${kind}=`
    const keyStart = line.indexOf(needle)
    if (keyStart === -1 || keyStart > end) continue

    const valueStart = keyStart + needle.length
    const raw = line.slice(valueStart, end).trim()
    if (!raw.startsWith("{") && !raw.startsWith("[")) return line

    try {
      const value = JSON.parse(raw) as unknown
      const id = nextId(markerType(line))
      entries[id] = { kind, value }
      return `${line.slice(0, keyStart)} ref=${sidecarHref}#${id} ${line.slice(end)}`
    } catch {
      return line
    }
  }

  return line
}

export const externalizeAdfMetadata = (
  markdown: string,
  sidecarHref: string
): { readonly markdown: string; readonly sidecar: AdfMetadataSidecar | null } => {
  const entries: Record<string, AdfMetadataEntry> = {}
  let counter = 0
  const nextId = (type: string): string => `${type}-${++counter}`
  const lines = markdown.split("\n").map((line) => externalizeLine(line, sidecarHref, nextId, entries))
  return {
    markdown: lines.join("\n"),
    sidecar: Object.keys(entries).length > 0 ? { version: 1, entries } : null
  }
}

export const collectAdfMetadataHrefs = (markdown: string): ReadonlySet<string> => {
  const hrefs = new Set<string>()
  for (const line of markdown.split("\n")) {
    if (!line.includes("<!-- adf:") || !line.includes(" ref=")) continue
    const end = line.lastIndexOf("-->")
    const refStart = line.indexOf(" ref=")
    if (end === -1 || refStart === -1 || refStart > end) continue
    const rawRef = line.slice(refStart + " ref=".length, end).trim()
    const href = rawRef.includes("#") ? rawRef.slice(0, rawRef.lastIndexOf("#")) : rawRef
    if (href.length > 0) hrefs.add(href)
  }
  return hrefs
}

const hydrateLine = (line: string, sidecars: ReadonlyMap<string, AdfMetadataSidecar>): string => {
  if (!line.includes("<!-- adf:") || !line.includes(" ref=")) return line
  const end = line.lastIndexOf("-->")
  const refStart = line.indexOf(" ref=")
  if (end === -1 || refStart === -1 || refStart > end) return line

  const rawRef = line.slice(refStart + " ref=".length, end).trim()
  const href = rawRef.includes("#") ? rawRef.slice(0, rawRef.lastIndexOf("#")) : rawRef
  const id = rawRef.includes("#") ? rawRef.slice(rawRef.lastIndexOf("#") + 1) : rawRef
  const sidecar = sidecars.get(href)
  if (!sidecar) return line
  const entry = sidecar.entries[id]
  if (!entry) return line

  return `${line.slice(0, refStart)} ${entry.kind}=${stableStringify(entry.value)} ${line.slice(end)}`
}

export const hydrateAdfMetadata = (
  markdown: string,
  sidecars: ReadonlyMap<string, AdfMetadataSidecar>
): string => markdown.split("\n").map((line) => hydrateLine(line, sidecars)).join("\n")
