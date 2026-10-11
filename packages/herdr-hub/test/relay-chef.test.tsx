// @vitest-environment happy-dom

import { NodeServices } from "@effect/platform-node"
import { Crypto, Effect } from "effect"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "@effect/vitest"
import { relayChefArt } from "../src/internal/relay-chef-art.js"
import { RelayChefMark } from "../src/internal/relay-chef-mark.js"

interface DrawingNode {
  readonly name: string
  readonly attributes: Readonly<Record<string, string>>
  readonly children: ReadonlyArray<DrawingNode>
}

/** Compare drawing structure, allowing only the instance-local gradient identifiers to change. */
const drawing = (root: Element) => {
  const identifiers = new Map(
    [...root.querySelectorAll("[id]")].map((node, index) => [node.id, `gradient-${String(index)}`])
  )
  const normalize = (value: string) => {
    let normalized = value
    for (const [id, token] of identifiers) {
      if (normalized === id) normalized = token
      normalized = normalized.replaceAll(`url(#${id})`, `url(#${token})`)
    }
    return normalized
  }
  const node = (element: Element): DrawingNode => ({
    name: element.localName,
    attributes: Object.fromEntries(
      [...element.attributes]
        .map(({ name, value }) => [name, normalize(value)])
        .sort(([a], [b]) => (a ?? "").localeCompare(b ?? ""))
    ),
    children: [...element.children].map(node)
  })
  return [...root.children].map(node)
}

describe("Chef logo drawing", () => {
  it.layer(NodeServices.layer)("Approved source hashes", (it) => {
    const hashes = {
      mark: "5e11800f504b132472685ab377a40c30d5a548a817d32bf746c92e1846ec4e63",
      contrast: "cc54f1809f34ac59e13223f5f59ff781f983139447de22c0c87cf5baf0e407a8",
      favicon: "64555e8f7c0b5a9dda8c2e05581b0e7a74ac5900c342a0317ed8bde6be279af4",
      tile: "076522d9e00c1631af1d6f3cbe32f4d670231d17b8dc292ccde50df0ca6c6ad8"
    } satisfies Record<keyof typeof relayChefArt, string>
    for (const variant of ["mark", "contrast", "favicon", "tile"] satisfies ReadonlyArray<keyof typeof relayChefArt>) {
      it.effect(`pins the approved ${variant} source without metadata or executable markup`, () =>
        Effect.gen(function* () {
          const hashing = yield* Crypto.Crypto
          const source = relayChefArt[variant]
          const bytes = yield* hashing.digest("SHA-256", new TextEncoder().encode(source))
          const sha256 = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")
          expect(sha256).toBe(hashes[variant])
          const document = new DOMParser().parseFromString(source, "image/svg+xml")
          expect(
            document.querySelector("parsererror,metadata,style,script,foreignObject,animate,animateTransform")
          ).toBeNull()
          expect(document.querySelector("[style],[href],[xlink\\:href]")).toBeNull()
          expect(document.documentElement.getAttribute("viewBox")).toMatch(/^0 0 (32 32|512 512)$/)
        })
      )
    }
  })

  it("renders both approved drawings as JSX with only instance-local ids changed", () => {
    const host = document.createElement("div")
    host.innerHTML = renderToStaticMarkup(<RelayChefMark />)
    for (const variant of ["mark", "contrast"] satisfies ReadonlyArray<keyof typeof relayChefArt>) {
      const expected = new DOMParser().parseFromString(relayChefArt[variant], "image/svg+xml").documentElement
      const actual = host.querySelector(`[data-relay-chef-drawing="${variant}"]`)
      expect(actual).not.toBeNull()
      if (actual === null) return
      expect(drawing(actual)).toEqual(drawing(expected))
    }
    const svg = host.querySelector("svg")
    expect(svg?.getAttribute("aria-hidden")).toBe("true")
    expect(svg?.getAttribute("focusable")).toBe("false")
    expect(svg?.getAttribute("viewBox")).toBe("0 0 32 32")
    expect(host.querySelector("title,desc")).toBeNull()
  })

  it("keeps every gradient local when the sidebar and launcher render together", () => {
    const host = document.createElement("div")
    host.innerHTML = renderToStaticMarkup(
      <>
        <RelayChefMark />
        <RelayChefMark />
      </>
    )
    const ids = [...host.querySelectorAll("[id]")].map((node) => node.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const id of ids) expect(id).toMatch(/^[A-Za-z0-9_-]+$/)
    for (const svg of host.querySelectorAll("svg")) {
      for (const node of svg.querySelectorAll("[fill]")) {
        const reference = /^url\(#(.+)\)$/.exec(node.getAttribute("fill") ?? "")?.[1]
        if (reference !== undefined) expect(svg.querySelector(`[id="${reference}"]`)).not.toBeNull()
      }
    }
  })
})
