// @vitest-environment happy-dom

import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"
import { Field, RLY_FIELD_DEFAULT_VARIANTS, RLY_FIELD_VARIANTS } from "../../src/primitives/Field.js"
import { render } from "./render.js"

describe("Field", () => {
  it("attaches its visible label, description, and required state through explicit control props", () => {
    const field = render(
      <Field controlId="release-name" description="Shown in release summaries." label="Release name" required>
        {(controlProps) => <input {...controlProps} />}
      </Field>
    )
    const label = field?.querySelector("label")
    const input = field?.querySelector("input")
    expect(label?.htmlFor).toBe("release-name")
    expect(input?.getAttribute("aria-labelledby")).toBe("release-name-label")
    expect(input?.getAttribute("aria-describedby")).toBe("release-name-description")
    expect(input?.getAttribute("aria-required")).toBe("true")
    expect(input?.required).toBe(true)
    expect(field?.textContent).toContain("Required")
  })

  it("announces errors and connects both supporting messages without replacing the control", () => {
    const field = render(
      <Field controlId="notes" description="Keep this concise." error="Notes are required." label="Notes">
        {(controlProps) => <textarea {...controlProps} data-owned-control="textarea" />}
      </Field>
    )
    const control = field?.querySelector("textarea")
    const alert = field?.querySelector('[role="alert"]')
    expect(control?.getAttribute("data-owned-control")).toBe("textarea")
    expect(control?.getAttribute("aria-describedby")).toBe("notes-description notes-error")
    expect(control?.getAttribute("aria-errormessage")).toBe("notes-error")
    expect(control?.getAttribute("aria-invalid")).toBe("true")
    expect(alert?.id).toBe("notes-error")
    expect(alert?.textContent).toBe("Notes are required.")
  })

  it("generates stable SSR ids and supports select-like controls", () => {
    const renderField = () =>
      renderToStaticMarkup(
        <Field label="Environment" size="compact">
          {(controlProps) => (
            <button {...controlProps} role="combobox">
              Production
            </button>
          )}
        </Field>
      )
    const first = renderField()
    expect(renderField()).toBe(first)
    expect(first).toContain('role="combobox"')
    expect(first).toContain('aria-labelledby="rly-field-_R_0_-label"')
    expect(first).toContain(RLY_FIELD_VARIANTS.size.compact.className)
    expect(RLY_FIELD_DEFAULT_VARIANTS).toEqual({ size: "default" })
  })

  it("rejects empty accessible copy", () => {
    expect(() => renderToStaticMarkup(<Field label=" ">{(props) => <input {...props} />}</Field>)).toThrow(
      "Field label"
    )
    expect(() =>
      renderToStaticMarkup(
        <Field description=" " label="Name">
          {(props) => <input {...props} />}
        </Field>
      )
    ).toThrow("Field description")
  })

  it("rejects a render callback that drops the owned control semantics", () => {
    expect(() => renderToStaticMarkup(<Field label="Name">{() => <input />}</Field>)).toThrow(
      "Field control must apply"
    )
    expect(() => renderToStaticMarkup(<Field label="Name">{() => <></>}</Field>)).toThrow("must render one control")
  })
})
