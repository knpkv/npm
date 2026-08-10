import { describe, expect, it } from "@effect/vitest"
import type { RelatedWork } from "../src/VersionService.js"
import { planRelatedWorkSync } from "../src/VersionService.js"

const link = (
  title: string,
  url: string,
  category = "Communication",
  relatedWorkId: string | null = `id-${title}`
): RelatedWork => ({ relatedWorkId, title, category, url })

const notes = { title: "Release Notes - REL 96", url: "https://example.atlassian.net/wiki/pages/1" }
const vra = { title: "Verbal Risk Assessment - REL 96", url: "https://example.atlassian.net/wiki/pages/2" }
const report = { title: "Test Report - REL 96", url: "https://example.atlassian.net/wiki/pages/3" }

const options = { category: "Communication", prune: false }

describe("planRelatedWorkSync", () => {
  it("adds every link when the version has none", () => {
    const plan = planRelatedWorkSync([], [notes, vra, report], options)

    expect(plan.toAdd).toEqual([notes, vra, report])
    expect(plan.kept).toEqual([])
    expect(plan.toRemove).toEqual([])
  })

  // The whole point: scaffolding a release twice must not double the links.
  it("is a no-op on a second run", () => {
    const desired = [notes, vra, report]
    const existing = desired.map((d) => link(d.title, d.url))

    const plan = planRelatedWorkSync(existing, desired, options)

    expect(plan.toAdd).toEqual([])
    expect(plan.kept).toEqual([notes.url, vra.url, report.url])
    expect(plan.toRemove).toEqual([])
  })

  it("adds only what is missing", () => {
    const plan = planRelatedWorkSync([link(notes.title, notes.url)], [notes, vra], options)

    expect(plan.toAdd).toEqual([vra])
    expect(plan.kept).toEqual([notes.url])
  })

  // A link retitled in the Jira UI is still the same link; matching on URL
  // keeps the user's edit instead of adding a duplicate under our title.
  it("matches on URL, not title", () => {
    const existing = [link("Renamed by hand", notes.url)]

    const plan = planRelatedWorkSync(existing, [notes], options)

    expect(plan.toAdd).toEqual([])
    expect(plan.kept).toEqual([notes.url])
  })

  it("ignores links in other categories", () => {
    const existing = [link(notes.title, notes.url, "Testing")]

    const plan = planRelatedWorkSync(existing, [notes], options)

    expect(plan.toAdd).toEqual([notes])
  })

  it("leaves extras alone without --prune", () => {
    const existing = [link(notes.title, notes.url), link("Stale", "https://example.atlassian.net/wiki/pages/99")]

    const plan = planRelatedWorkSync(existing, [notes], options)

    expect(plan.toRemove).toEqual([])
  })

  it("removes extras in the category with --prune", () => {
    const existing = [link(notes.title, notes.url), link("Stale", "https://example.atlassian.net/wiki/pages/99")]

    const plan = planRelatedWorkSync(existing, [notes], { category: "Communication", prune: true })

    expect(plan.toRemove).toEqual([
      { relatedWorkId: "id-Stale", url: "https://example.atlassian.net/wiki/pages/99" }
    ])
  })

  it("never prunes across categories", () => {
    const existing = [link("Other team's link", "https://example.atlassian.net/wiki/pages/99", "Testing")]

    const plan = planRelatedWorkSync(existing, [notes], { category: "Communication", prune: true })

    expect(plan.toRemove).toEqual([])
    expect(plan.toAdd).toEqual([notes])
  })

  it("skips prune candidates Jira gave no id for", () => {
    const existing = [link("No id", "https://example.atlassian.net/wiki/pages/99", "Communication", null)]

    const plan = planRelatedWorkSync(existing, [notes], { category: "Communication", prune: true })

    expect(plan.toRemove).toEqual([])
  })

  // The pile-up the reconcile exists to clean up: repeated `related-work add`
  // leaves several links to the same page, all of them wanted URLs.
  it("prunes surplus copies of a desired URL, keeping the first", () => {
    const existing = [
      link("Release Notes", notes.url, "Communication", "id-first"),
      link("Release Notes", notes.url, "Communication", "id-second"),
      link("Release Notes", notes.url, "Communication", "id-third")
    ]

    const plan = planRelatedWorkSync(existing, [notes], { category: "Communication", prune: true })

    expect(plan.toAdd).toEqual([])
    expect(plan.kept).toEqual([notes.url])
    expect(plan.toRemove).toEqual([
      { relatedWorkId: "id-second", url: notes.url },
      { relatedWorkId: "id-third", url: notes.url }
    ])
  })

  it("leaves duplicate copies alone without --prune", () => {
    const existing = [
      link("Release Notes", notes.url, "Communication", "id-first"),
      link("Release Notes", notes.url, "Communication", "id-second")
    ]

    const plan = planRelatedWorkSync(existing, [notes], options)

    expect(plan.toRemove).toEqual([])
  })

  // Two --link flags for one page are one link: URL is the identity on the
  // desired side too, or the reconcile would itself create the duplicates.
  it("collapses repeated desired entries to a single add", () => {
    const plan = planRelatedWorkSync([], [notes, { title: "Same page, other title", url: notes.url }], options)

    expect(plan.toAdd).toEqual([notes])
  })

  // Every desired link carries a URL, so a url-less entry can never be one of
  // them. Skipping it left the category unreconciled while --prune reported
  // success.
  it("prunes a url-less entry that Jira gave an id", () => {
    const existing = [
      link("Release Notes", notes.url),
      { relatedWorkId: "id-orphan", title: "Legacy attachment", category: "Communication", url: null }
    ]

    const plan = planRelatedWorkSync(existing, [notes], { category: "Communication", prune: true })

    expect(plan.toRemove).toEqual([{ relatedWorkId: "id-orphan", url: null }])
  })

  // Jira can hand back a desired URL twice with only the second copy
  // deletable. Skipping the undeletable one before designating a keeper let the
  // deletable duplicate claim that role, so both survived a reconcile that
  // reported success.
  it("prunes the deletable duplicate when the keeper has no id", () => {
    const existing = [
      { relatedWorkId: null, title: "Release Notes", category: "Communication", url: notes.url },
      link("Release Notes", notes.url, "Communication", "id-second")
    ]

    const plan = planRelatedWorkSync(existing, [notes], { category: "Communication", prune: true })

    expect(plan.toRemove).toEqual([{ relatedWorkId: "id-second", url: notes.url }])
  })

  // The nearby valid fixture: with no id there is nothing to delete with, so
  // it stays skipped however it is pruned.
  it("leaves a url-less entry alone when Jira gave no id either", () => {
    const existing = [
      link("Release Notes", notes.url),
      { relatedWorkId: null, title: "Legacy attachment", category: "Communication", url: null }
    ]

    const plan = planRelatedWorkSync(existing, [notes], { category: "Communication", prune: true })

    expect(plan.toRemove).toEqual([])
  })
})
