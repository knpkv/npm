import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"
import type { ReviewExecutionProfile } from "../src/index.js"
import { ReviewProfileControl, ReviewResultStatus } from "../src/view.js"

const profile: ReviewExecutionProfile = {
  id: "explain",
  name: "Explain change",
  kind: "explain",
  provider: "codex",
  harness: "native-codex",
  model: "gpt-5.6-terra",
  skillIds: []
}

describe("shared review controls", () => {
  it("renders one profile-owned execution choice with provider and model context", () => {
    const markup = renderToStaticMarkup(
      <ReviewProfileControl onProfileChange={() => undefined} profiles={[profile]} selectedProfileId={profile.id} />
    )
    expect(markup).toContain("Explain change")
    expect(markup).toContain("codex · gpt-5.6-terra")
    expect(markup).not.toContain("Security")
  })

  it("visibly labels retained output after a failed rerun", () => {
    const markup = renderToStaticMarkup(
      <ReviewResultStatus
        presentation={{
          _tag: "Previous",
          completed: {
            identity: {
              namespace: "codecommit",
              subjectId: "account-a/pr-35",
              revisionId: "revision-1",
              baseRevision: "base-1",
              headRevision: "head-1"
            },
            profile,
            result: { verdict: "No issues" }
          }
        }}
      />
    )
    expect(markup).toContain("Previous result")
  })

  it("preserves a radio presentation for product shells that already expose one", () => {
    const markup = renderToStaticMarkup(
      <ReviewProfileControl
        accessibleName="Review agent presets"
        groupName="review-agent"
        onProfileChange={() => undefined}
        presentation="radios"
        profiles={[profile]}
        selectedProfileId={profile.id}
      />
    )
    expect(markup).toContain('aria-label="Review agent presets"')
    expect(markup).toContain('type="radio"')
    expect(markup).toContain('name="review-agent"')
  })
})
