// @vitest-environment happy-dom

import { NodeServices } from "@effect/platform-node"
import { Crypto, Effect } from "effect"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "@effect/vitest"
import { relayChefArt } from "../src/internal/relay-chef-art.js"
import { RelayChefMastMark } from "../src/internal/relay-chef-mast-mark.js"
import { RelayChefMark } from "../src/internal/relay-chef-mark.js"

interface DrawingNode {
  readonly name: string
  readonly attributes: Readonly<Record<string, string>>
  readonly children: ReadonlyArray<DrawingNode>
}

/** Compare drawing structure, allowing only the instance-local clip identifiers to change. */
const drawing = (root: Element) => {
  const identifiers = new Map(
    [...root.querySelectorAll("[id]")].map((node, index) => [node.id, `clip-${String(index)}`])
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
      markMast: "e751213f0a6346b1d337eee925d63516a24356644a242c77263bebf7b5af0255",
      contrastMast: "afc4f530316bba42d45f2fc5a70794043e54607a54f91fcb997806a5a137abb7",
      mark: "e183fe6ef1d345f56307ea513cae00cb5ec2ef6cc2113e682812d5d23b698878",
      contrast: "4ca92cc4b077609b0e628546ba79221f1dcf8f77bd27f407d80d44bc0909447d",
      markPhone: "6b43adf5e19375dbca5c7e23f1c979f40ae3c078bfa6b51bd7f24f0b2bc98554",
      contrastPhone: "b70d789692fe1ccf92628f4513f80765fdfc97450edfe04b52c44ebe9b6b8c16",
      contrastBadge: "6698b90e79be853c7903c7d11fbbfe0bfd450cc046de899704ea912337342583",
      tileApple: "9903b174815b31329a4322c15e528342410f6c7552091f2b129dce156c9d311e",
      favicon: "865804065e0a8522cd72f031023e9988351ba546161eee8bdd083c981c6751e5",
      tile: "9b4078b9b93086538ea88e6944f331b262a3aaf3f2c4e69e5d97ee53ed906e30"
    } satisfies Record<keyof typeof relayChefArt, string>
    for (const variant of [
      "mark",
      "contrast",
      "markMast",
      "contrastMast",
      "markPhone",
      "contrastPhone",
      "contrastBadge",
      "tileApple",
      "favicon",
      "tile"
    ] satisfies ReadonlyArray<keyof typeof relayChefArt>) {
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
    for (const variant of ["mark", "contrast", "markPhone", "contrastPhone"] satisfies ReadonlyArray<
      keyof typeof relayChefArt
    >) {
      const expected = new DOMParser().parseFromString(relayChefArt[variant], "image/svg+xml").documentElement
      const kind = variant.startsWith("contrast") ? "contrast" : "mark"
      const size = variant.endsWith("Phone") ? 24 : 32
      const actual = host.querySelector(`[data-relay-chef-drawing="${kind}"][data-relay-chef-size="${String(size)}"]`)
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

  it("renders the approved28px mast drawing without reusing the24px launcher geometry", () => {
    const host = document.createElement("div")
    host.innerHTML = renderToStaticMarkup(<RelayChefMastMark />)
    expect(host.querySelector("svg")?.getAttribute("width")).toBe("28")
    for (const variant of ["markMast", "contrastMast"] satisfies ReadonlyArray<keyof typeof relayChefArt>) {
      const kind = variant === "markMast" ? "mark" : "contrast"
      const actual = host.querySelector(`[data-relay-chef-drawing="${kind}"][data-relay-chef-size="28"]`)
      expect(actual).not.toBeNull()
      if (actual === null) return
      const expected = new DOMParser().parseFromString(relayChefArt[variant], "image/svg+xml").documentElement
      expect(drawing(actual)).toEqual(drawing(expected))
    }
  })

  it("keeps every clip local when the sidebar and launcher render together", () => {
    const host = document.createElement("div")
    host.innerHTML = renderToStaticMarkup(
      <>
        <RelayChefMark />
        <RelayChefMastMark />
        <RelayChefMark />
      </>
    )
    const ids = [...host.querySelectorAll("[id]")].map((node) => node.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const id of ids) expect(id).toMatch(/^[A-Za-z0-9_-]+$/)
    for (const group of host.querySelectorAll("[data-relay-chef-drawing]")) {
      const references = [...group.querySelectorAll("[clip-path]")]
      expect(references.length).toBeGreaterThan(0)
      for (const node of references) {
        const reference = /^url\(#(.+)\)$/.exec(node.getAttribute("clip-path") ?? "")?.[1]
        expect(reference).toBeDefined()
        if (reference !== undefined) expect(group.querySelector(`[id="${reference}"]`)).not.toBeNull()
      }
    }
  })
})
