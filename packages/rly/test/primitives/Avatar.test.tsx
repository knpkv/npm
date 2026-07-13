// @vitest-environment happy-dom

import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"
import { Avatar, RLY_AVATAR_DEFAULT_VARIANTS, RLY_AVATAR_VARIANTS } from "../../src/primitives/Avatar.js"
import { render } from "./render.js"

// @ts-expect-error meaningful avatars require an accessible label
const missingLabel = <Avatar fallback="DR" />
// @ts-expect-error decorative avatars cannot expose a competing label
const labelledDecoration = <Avatar decorative fallback="DR" label="Draft reviewer" />
void [missingLabel, labelledDecoration]

describe("Avatar", () => {
  it("provides a labelled image role and deterministic fallback", () => {
    const avatar = render(<Avatar fallback="DR" label="Draft reviewer" />)
    expect(avatar?.getAttribute("role")).toBe("img")
    expect(avatar?.getAttribute("aria-label")).toBe("Draft reviewer")
    expect(avatar?.textContent).toBe("DR")
    expect(avatar?.className).toContain(RLY_AVATAR_VARIANTS.size.default.className)
    expect(RLY_AVATAR_DEFAULT_VARIANTS).toEqual({ shape: "circle", size: "default" })
  })

  it("can be explicitly decorative", () => {
    const avatar = render(<Avatar decorative fallback="DR" />)
    expect(avatar?.getAttribute("aria-hidden")).toBe("true")
    expect(avatar?.getAttribute("role")).toBeNull()
  })

  it("keeps fallback content for missing and unavailable images", () => {
    const missingImage = render(<Avatar fallback="MI" label="Missing image" />)
    expect(missingImage?.textContent).toBe("MI")

    const unavailableImage = render(<Avatar fallback="UI" label="Unavailable image" src="/unavailable-avatar.png" />)
    expect(unavailableImage?.textContent).toContain("UI")
  })

  it("rejects blank fallback content and labels", () => {
    expect(() => renderToStaticMarkup(<Avatar fallback=" " label="Reviewer" />)).toThrow("visible text")
    expect(() => renderToStaticMarkup(<Avatar fallback="DR" label=" " />)).toThrow("visible text")
  })
})
