import { parsePatch } from "@knpkv/rly/diff/patch"
import * as Schema from "effect/Schema"
import { hydrateRoot } from "react-dom/client"
import { Findings, Guide, PatchPrefixes } from "./model.js"
import { GuideRoot } from "./root.js"

const Payload = Schema.Struct({
  guide: Guide,
  findings: Findings,
  patch: Schema.String,
  prefixes: Schema.optionalKey(PatchPrefixes)
})
const element = document.getElementById("review-data")
const root = document.getElementById("review-root")
if (element !== null && root !== null) {
  const payload = Schema.decodeUnknownSync(Schema.fromJsonString(Payload))(element.textContent)
  const parsed = parsePatch(payload.patch, payload.prefixes)
  // The export refuses to write an invalid patch, so this only guards a hand-edited document:
  // leave the server-rendered markup in place rather than hydrating over it with nothing.
  if (parsed._tag === "Patch") {
    hydrateRoot(root, <GuideRoot guide={payload.guide} findings={payload.findings} patch={parsed.patch} />)
  }
}
