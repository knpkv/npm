// @vitest-environment happy-dom

import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"
import { RLY_SKELETON_DEFAULT_VARIANTS, Skeleton } from "../../src/primitives/Skeleton.js"
import { render } from "./render.js"

// @ts-expect-error informative placeholders require a label
const missingLabel = <Skeleton decorative={false} />
void missingLabel

describe("Skeleton", () => {
  it("is static and presentation-only by default", () => {
    const skeleton = render(<Skeleton height="4rem" width="12rem" />)
    expect(skeleton?.getAttribute("role")).toBe("presentation")
    expect(skeleton?.getAttribute("aria-hidden")).toBe("true")
    expect(skeleton?.style.blockSize).toBe("4rem")
    expect(skeleton?.style.inlineSize).toBe("12rem")
    expect(RLY_SKELETON_DEFAULT_VARIANTS).toEqual({ variant: "text" })
  })

  it("keeps explicit dimensions authoritative over conflicting style values", () => {
    const skeleton = render(<Skeleton height="5rem" style={{ blockSize: "2rem", inlineSize: "3rem" }} width="10rem" />)
    expect(skeleton?.style.blockSize).toBe("5rem")
    expect(skeleton?.style.inlineSize).toBe("10rem")
  })

  it("can announce a labelled busy region", () => {
    const skeleton = render(<Skeleton decorative={false} label="Loading comparison" variant="block" />)
    expect(skeleton?.getAttribute("role")).toBe("status")
    expect(skeleton?.getAttribute("aria-busy")).toBe("true")
    expect(skeleton?.getAttribute("aria-label")).toBe("Loading comparison")
  })

  it("rejects blank status labels", () => {
    expect(() => renderToStaticMarkup(<Skeleton decorative={false} label=" " />)).toThrow("visible text")
  })
})
