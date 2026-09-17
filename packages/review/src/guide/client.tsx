import { parsePatch } from "@knpkv/rly/diff/patch"
import * as Schema from "effect/Schema"
import { useEffect } from "react"
import { hydrateRoot } from "react-dom/client"
import { Findings, Guide } from "./model.js"
import { GuidePage } from "./view.js"

const Payload = Schema.Struct({ guide: Guide, findings: Findings, patch: Schema.String })
const Ready = () => {
  useEffect(() => {
    document.documentElement.dataset.reviewReady = "true"
    document.dispatchEvent(new Event("review-ready"))
  }, [])
  return null
}
const element = document.getElementById("review-data")
const root = document.getElementById("review-root")
if (element !== null && root !== null) {
  const payload = Schema.decodeUnknownSync(Schema.fromJsonString(Payload))(element.textContent)
  const parsed = parsePatch(payload.patch)
  // The export refuses to write an invalid patch, so this only guards a hand-edited document:
  // leave the server-rendered markup in place rather than hydrating over it with nothing.
  if (parsed._tag === "Patch") {
    hydrateRoot(
      root,
      <>
        <GuidePage guide={payload.guide} findings={payload.findings} patch={parsed.patch} />
        <Ready />
      </>
    )
  }
}
