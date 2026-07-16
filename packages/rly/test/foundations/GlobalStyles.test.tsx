// @vitest-environment happy-dom

import { act, createRef } from "react"
import { createRoot } from "react-dom/client"
import { renderToStaticMarkup } from "react-dom/server"
import { afterEach, describe, expect, it } from "vitest"
import { GlobalStyles, type GlobalStylesProps } from "../../src/foundations/GlobalStyles.js"

// @ts-expect-error asChild cannot safely type a wrapper ref against an arbitrary child element
const invalidPolymorphicRef: GlobalStylesProps = {
  asChild: true,
  children: <main />,
  ref: createRef<HTMLDivElement>()
}
void invalidPolymorphicRef

afterEach(() => {
  document.body.replaceChildren()
})

describe("GlobalStyles", () => {
  it("renders an SSR-safe structural style boundary", () => {
    const markup = renderToStaticMarkup(<GlobalStyles id="release-root">Content</GlobalStyles>)

    expect(markup).toContain("data-rly-root")
    expect(markup).toContain('id="release-root"')
    expect(markup).toContain("Content")
  })

  it("composes into one child without adding a wrapper", () => {
    const markup = renderToStaticMarkup(
      <GlobalStyles asChild className="scope">
        <main data-rly-root="ignored">Release</main>
      </GlobalStyles>
    )

    expect(markup).toContain("<main")
    expect(markup).toContain('class="scope"')
    expect(markup).toContain('data-rly-root=""')
    expect(markup).not.toContain("ignored")
    expect(markup.match(/<main/g)).toHaveLength(1)
  })

  it("forwards a root element ref", async () => {
    const host = document.createElement("div")
    document.body.append(host)
    const root = createRoot(host)
    const ref = createRef<HTMLDivElement>()

    await act(async () => root.render(<GlobalStyles ref={ref}>Content</GlobalStyles>))
    expect(ref.current?.getAttribute("data-rly-root")).toBe("")
    await act(async () => root.unmount())
  })
})
