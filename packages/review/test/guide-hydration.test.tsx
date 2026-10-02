import { fileURLToPath } from "node:url"
import * as Config from "effect/Config"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import { build, type Plugin } from "esbuild"
import { Window } from "happy-dom"
import { expect, it } from "vitest"
import { exportGuide } from "../dist/guide/export.js"

const guide = {
  title: "Hydration guide",
  intent: "Check the change.",
  sections: [
    { title: "Release gate", overview: "Inspect the line.", diffs: [{ file: "release.ts", summary: "Review" }] }
  ],
  unplacedFiles: [],
  review: { gitRef: "head" }
}
const findings = {
  checklist: [],
  issues: [{ id: 1, severity: "P1", file: "release.ts", line: 1, summary: "Confirm approval" }]
}
const patch = "diff --git a/release.ts b/release.ts\n--- a/release.ts\n+++ b/release.ts\n@@ -1 +1 @@\n-old\n+new\n"
const clientPath = fileURLToPath(new URL("../src/guide/client.tsx", import.meta.url))
const clientDirectory = fileURLToPath(new URL("../src/guide/", import.meta.url))

const bundleClient = async (mode: "development" | "production") => {
  // A private mutant may replace only the client entrypoint. The export still supplies the real SSR tree.
  const mutantSource = Effect.runSync(Config.option(Config.string("REVIEW_HYDRATION_CLIENT_MUTANT_SOURCE")))
  const plugins: Array<Plugin> = Option.isNone(mutantSource)
    ? []
    : [
        {
          name: "client-only-hydration-mutant",
          setup(plugin) {
            plugin.onLoad({ filter: /[/\\]guide[/\\]client\.tsx$/ }, () => ({
              contents: mutantSource.value,
              loader: "tsx",
              resolveDir: clientDirectory
            }))
          }
        }
      ]
  const result = await build({
    entryPoints: [clientPath],
    bundle: true,
    write: false,
    platform: "browser",
    format: "iife",
    define: { "process.env.NODE_ENV": JSON.stringify(mode) },
    plugins
  })
  const file = result.outputFiles[0]
  if (file === undefined) throw new TypeError("Client bundle missing")
  return file.text
}

const documentWithClient = (html: string, client?: string) => {
  const replaced =
    client === undefined
      ? html
      : html.replace(
          /<script>([\s\S]*?)<\/script>/,
          () => "<script>" + client.replaceAll(/<\/script/gi, "<\\/script") + "</script>"
        )
  if (!/<script>([\s\S]*?)<\/script>/.test(html) || (client !== undefined && replaced === html)) {
    throw new TypeError("Export omitted its client script")
  }
  const observed = replaced.replace(
    '<script id="review-data"',
    '<script>document.addEventListener("review-ready", () => { document.documentElement.dataset.reviewReadyEvents = String(Number(document.documentElement.dataset.reviewReadyEvents ?? 0) + 1) })</script><script id="review-data"'
  )
  if (observed === replaced) throw new TypeError("Export omitted its review data")
  return observed
}

const references = (window: Window) => {
  const root = window.document.getElementById("review-root")
  const guideElement = root?.querySelector(".review-guide")
  if (root === null || guideElement === null || guideElement === undefined) {
    throw new TypeError("Export omitted its guide root")
  }
  const ids = [...root.querySelectorAll("[id]")].map((element) => element.id)
  const links = [...guideElement.querySelectorAll('a[href^="#"]')].map((element) => element.getAttribute("href"))
  const labelledBy = [...root.querySelectorAll("[aria-labelledby]")].map((element) =>
    element.getAttribute("aria-labelledby")
  )
  for (const link of links) {
    if (link === null) throw new TypeError("Fragment link missing href")
    expect(
      ids.filter((id) => id === decodeURIComponent(link.slice(1))),
      link
    ).toHaveLength(1)
  }
  for (const labelled of labelledBy) {
    for (const id of labelled?.split(/\s+/) ?? [])
      expect(
        ids.filter((value) => value === id),
        id
      ).toHaveLength(1)
  }
  expect(new Set(ids).size).toBe(ids.length)
  return { ids, links, labelledBy }
}

const hydrateExport = async (html: string, mode: "development" | "production") => {
  const window = new Window({
    url: "https://review.example.test/",
    settings: { enableJavaScriptEvaluation: true, suppressInsecureJavaScriptEnvironmentWarning: true }
  })
  // React's development build calls this Console API, which Happy DOM does not implement.
  window.console.timeStamp = () => undefined
  const consoleErrors: Array<string> = []
  const runtimeErrors: Array<string> = []
  window.console.error = (...args) => consoleErrors.push(args.map(String).join(" "))
  window.addEventListener("error", (event) => runtimeErrors.push(String(event)))
  window.addEventListener("unhandledrejection", (event) => runtimeErrors.push(String(event)))
  try {
    const client = mode === "development" ? await bundleClient(mode) : undefined
    window.document.write(documentWithClient(html, client))
    await window.happyDOM.whenAsyncComplete()
    expect(window.document.documentElement.dataset.reviewReady).toBe("true")
    expect(window.document.documentElement.dataset.reviewReadyEvents).toBe("1")
    expect(consoleErrors).toEqual([])
    expect(runtimeErrors).toEqual([])
    const hydrated = references(window)

    const tabs = [...window.document.querySelectorAll('[role="tab"]')]
    const reviewTab = tabs.find((tab) => tab.textContent?.startsWith("Review"))
    const guideTab = tabs.find((tab) => tab.textContent === "Change guide")
    if (reviewTab === undefined || guideTab === undefined) throw new TypeError("Hydrated tabs missing")
    reviewTab.dispatchEvent(new window.MouseEvent("mousedown", { bubbles: true, button: 0 }))
    await window.happyDOM.whenAsyncComplete()
    expect(reviewTab.getAttribute("aria-selected")).toBe("true")
    const findingLink = window.document.querySelector(".review-issues a")
    if (findingLink === null) throw new TypeError("Hydrated finding link missing")
    findingLink.dispatchEvent(new window.MouseEvent("click", { bubbles: true }))
    expect(window.location.hash).toBe(findingLink.getAttribute("href"))
    guideTab.dispatchEvent(new window.MouseEvent("mousedown", { bubbles: true, button: 0 }))
    await window.happyDOM.whenAsyncComplete()
    expect(guideTab.getAttribute("aria-selected")).toBe("true")
    const chapterLink = window.document.querySelector(".review-roadmap a")
    if (chapterLink === null) throw new TypeError("Hydrated chapter link missing")
    chapterLink.dispatchEvent(new window.MouseEvent("click", { bubbles: true }))
    expect(window.location.hash).toBe(chapterLink.getAttribute("href"))
    expect(references(window)).toEqual(hydrated)
    expect(window.document.documentElement.dataset.reviewReadyEvents).toBe("1")
    return hydrated
  } finally {
    await window.happyDOM.close()
  }
}

it("hydrates the actual exported guide with the actual bundled client", async () => {
  const exported = await Effect.runPromise(exportGuide({ guide, findings, patch }))
  const server = new Window({ url: "https://review.example.test/" })
  try {
    server.document.write(exported.html)
    expect(server.document.documentElement.dataset.reviewReady).toBeUndefined()
    expect(server.document.body.textContent).toContain("Release gate")
    expect(server.document.body.textContent).toContain("Confirm approval")
    const ssr = references(server)
    const modes: ReadonlyArray<"development" | "production"> = ["development", "production"]
    for (const mode of modes) {
      expect(await hydrateExport(exported.html, mode)).toEqual(ssr)
    }
  } finally {
    await server.happyDOM.close()
  }
})

it("hydrates omitted, empty and custom producer prefixes from exported data", async () => {
  const cases = [
    { patch },
    {
      patch: patch.replaceAll("a/release.ts", "release.ts").replaceAll("b/release.ts", "release.ts"),
      prefixes: { source: "", destination: "" }
    },
    {
      patch: patch.replaceAll("a/release.ts", "old/release.ts").replaceAll("b/release.ts", "new/release.ts"),
      prefixes: { source: "old/", destination: "new/" }
    }
  ]
  for (const input of cases) {
    const exported = await Effect.runPromise(exportGuide({ guide, findings, ...input }))
    const hydrated = await hydrateExport(exported.html, "production")
    expect(hydrated.links.length).toBeGreaterThan(0)
  }
})
