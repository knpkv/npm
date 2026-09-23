"use client"

import { findFile, type FileDiff, type Patch, PatchDiffView } from "@knpkv/rly/diff/patch"
import { ThemeProvider } from "@knpkv/rly/foundations"
import { Button, StateLabel, Surface, Tabs, Text } from "@knpkv/rly/primitives"
import { memo, type ReactElement, useEffect, useId, useRef, useState } from "react"
import { renderInline, renderMarkdown } from "./markdown.js"
import type { Findings, Guide, Issue, Usage } from "./model.js"
import { bySeverity, placeAll, type Placed } from "./plan.js"

/** Keep Mermaid-owned DOM intact when unrelated diff or theme controls change. */
const Prose = memo(({ text }: { readonly text: string }) => (
  <div className="review-prose" dangerouslySetInnerHTML={{ __html: renderMarkdown(text).html }} />
))

/** Inline-only markup keeps labels compact and avoids nested anchors in finding navigation. */
const Inline = ({ links = true, text }: { readonly text: string; readonly links?: boolean }) => (
  <span className="review-inline-markdown" dangerouslySetInnerHTML={{ __html: renderInline(text, { links }) }} />
)

const Severity = ({ issue }: { readonly issue: Issue }) => (
  <StateLabel
    label={issue.severity}
    size="compact"
    tone={issue.severity === "P1" ? "critical" : issue.severity === "P2" ? "caution" : "neutral"}
  />
)

const FindingCard = ({
  issue,
  issueId,
  onReview,
  readingId
}: {
  readonly issue: Issue
  readonly issueId: string
  readonly readingId: string
  readonly onReview: () => void
}) => (
  <Surface as="aside" padding="compact" id={issueId} className="review-finding">
    <div className="review-inline">
      <Severity issue={issue} />
      <strong>Issue {issue.id}</strong>
      {issue.status === undefined ? null : <span>{issue.status}</span>}
      <a href={`#${readingId}`} onClick={onReview}>
        Review summary
      </a>
    </div>
    <h3 className="review-finding-title">
      <Inline text={issue.summary} />
    </h3>
    {issue.explanation === undefined ? null : <Prose text={issue.explanation} />}
    {issue.status !== undefined || issue.recommendation === undefined ? null : (
      <>
        <Text as="strong" variant="label">
          Fix
        </Text>
        <Prose text={issue.recommendation} />
      </>
    )}
  </Surface>
)

const number = (value: number | undefined) =>
  value === undefined ? "Not recorded" : new Intl.NumberFormat("en").format(value)
const duration = (value: number | undefined) =>
  value === undefined
    ? "Not recorded"
    : value < 1000
      ? `${value < 1 ? value : Math.round(value)} ms`
      : `${Math.floor(value / 60000)}m ${Math.floor((value % 60000) / 1000)}s`

/** Each run retains its evidence; printing opens the disclosure temporarily and restores the screen state. */
export const GuideUsage = ({ usage }: { readonly usage: ReadonlyArray<Usage> | undefined }): ReactElement => {
  const ref = useRef<HTMLDetailsElement>(null)
  useEffect(() => {
    const details = ref.current
    if (details === null) return
    const media = window.matchMedia("print")
    let screenOpen: boolean | undefined
    const before = () => {
      if (screenOpen === undefined) screenOpen = details.open
      details.open = true
    }
    const after = () => {
      if (screenOpen === undefined) return
      details.open = screenOpen
      screenOpen = undefined
    }
    const changed = () => (media.matches ? before() : after())
    window.addEventListener("beforeprint", before)
    window.addEventListener("afterprint", after)
    media.addEventListener("change", changed)
    if (media.matches) before()
    return () => {
      window.removeEventListener("beforeprint", before)
      window.removeEventListener("afterprint", after)
      media.removeEventListener("change", changed)
      after()
    }
  }, [])
  const receipt =
    usage === undefined || usage.length === 0 ? (
      <p>Usage, cost, and execution time were not recorded.</p>
    ) : (
      usage.map((run, index) => (
        <Surface padding="compact" key={index}>
          <Text as="h3" variant="card-title">
            {run.label}
          </Text>
          <p className="review-muted">
            {run.scope}
            {run.model === undefined ? "" : ` · ${run.model}`}
          </p>
          <dl className="review-metrics">
            <div>
              <dt>Input tokens</dt>
              <dd>{number(run.inputTokens)}</dd>
            </div>
            <div>
              <dt>Output tokens</dt>
              <dd>{number(run.outputTokens)}</dd>
            </div>
            <div>
              <dt>Cached input</dt>
              <dd>{number(run.cachedInputTokens)}</dd>
            </div>
            <div>
              <dt>Execution time</dt>
              <dd>{duration(run.durationMs)}</dd>
            </div>
            <div>
              <dt>Cost</dt>
              <dd>
                {run.cost === undefined
                  ? "Not recorded"
                  : `${run.cost.currency} ${String(run.cost.amount)} · ${run.cost.basis}`}
              </dd>
            </div>
          </dl>
          <p className="review-muted">Source: {run.source}</p>
        </Surface>
      ))
    )
  return (
    <>
      <details className="review-usage" ref={ref}>
        <summary>Execution · tokens, cost, and time</summary>
        {receipt}
      </details>
      <section className="review-usage-print" aria-label="Execution evidence">
        <h2>Execution · tokens, cost, and time</h2>
        {receipt}
      </section>
    </>
  )
}

export interface GuidePageProps {
  readonly guide: Guide
  readonly patch: Patch
  readonly findings: Findings
}

/** Chapter-first reading with explicit diff controls and stable links to source lines and findings. */
export const GuidePage = ({ findings, guide, patch }: GuidePageProps): ReactElement => {
  const instanceId = useId()
  const fragmentId = (name: string) => `${instanceId}-${name}`
  const [reading, setReading] = useState("guide")
  const [mode, setMode] = useState<"split" | "stacked">("split")
  const [wrap, setWrap] = useState(true)
  const [theme, setTheme] = useState<"system" | "light" | "dark">("system")
  const placed = placeAll(patch, findings)
  const general = placed.filter((entry): entry is Extract<Placed, { kind: "general" }> => entry.kind === "general")
  const hasFindings = findings.checklist.length + findings.issues.length > 0
  const renderFile = (file: FileDiff, summary: string) => {
    const id = fragmentId(`f${patch.files.indexOf(file) + 1}`)
    return (
      <article className="review-file" id={id} key={file.path}>
        <header className="review-file-header">
          <StateLabel label={file.status} size="compact" tone="neutral" />
          <code>
            {file.status === "renamed" || file.status === "copied" ? `${file.oldPath} → ${file.newPath}` : file.path}
          </code>
        </header>
        {summary === "" ? null : <Prose text={summary} />}
        <PatchDiffView
          file={file}
          id={id}
          mode={mode}
          wrap={wrap}
          renderAnnotation={(side, line) => {
            const issues = placed.filter(
              (entry) =>
                entry.kind === "anchored" && entry.file.path === file.path && entry.side === side && entry.line === line
            )
            return issues.length === 0 ? null : (
              <>
                {issues.map(({ issue }) => (
                  <FindingCard
                    key={issue.id}
                    issue={issue}
                    issueId={fragmentId(`issue-${issue.id}`)}
                    readingId={fragmentId("reading")}
                    onReview={() => setReading("review")}
                  />
                ))}
              </>
            )
          }}
        />
      </article>
    )
  }
  return (
    <ThemeProvider theme={theme} className="review-guide">
      <a className="review-skip" href={`#${fragmentId("content")}`}>
        Skip to changes
      </a>
      <nav className="review-nav" aria-label="Guide chapters">
        <Text as="p" variant="label">
          CHANGE GUIDE & REVIEW
        </Text>
        <Text as="p" variant="body">
          {guide.title}
        </Text>
        <ol>
          {hasFindings ? (
            <li>
              <a href={`#${fragmentId("reading")}`} onClick={() => setReading("review")}>
                Review
              </a>
            </li>
          ) : null}
          {guide.sections.map((section, index) => (
            <li key={index}>
              <a href={`#${fragmentId(`s${index + 1}`)}`}>
                <span>{String(index + 1).padStart(2, "0")}</span>
                {section.title}
              </a>
            </li>
          ))}
          {guide.unplacedFiles.length > 0 ? (
            <li>
              <a href={`#${fragmentId("rest")}`}>Other files</a>
            </li>
          ) : null}
          {general.length > 0 ? (
            <li>
              <a href={`#${fragmentId("general")}`}>Outside the diff</a>
            </li>
          ) : null}
        </ol>
        <div className="review-controls">
          <Button size="compact" variant="secondary" onClick={() => setMode(mode === "split" ? "stacked" : "split")}>
            {mode === "split" ? "Unified view" : "Split view"}
          </Button>
          <label className="review-checkbox">
            <input type="checkbox" checked={wrap} onChange={(event) => setWrap(event.target.checked)} /> Wrap code
          </label>
          <div className="review-theme" role="group" aria-label="Theme">
            <Button size="compact" variant="quiet" aria-pressed={theme === "light"} onClick={() => setTheme("light")}>
              Light
            </Button>
            <Button size="compact" variant="quiet" aria-pressed={theme === "system"} onClick={() => setTheme("system")}>
              System
            </Button>
            <Button size="compact" variant="quiet" aria-pressed={theme === "dark"} onClick={() => setTheme("dark")}>
              Dark
            </Button>
          </div>
        </div>
      </nav>
      <main className="review-content" id={fragmentId("content")}>
        <header className="review-header">
          <div className="review-inline review-muted">
            <span>{patch.files.length} files</span>
            <span>{guide.sections.length} chapters</span>
            {guide.review.base === undefined ? null : (
              <span>
                Base: <code>{guide.review.base}</code>
              </span>
            )}
            <span>
              Head: <code>{guide.review.gitRef}</code>
            </span>
            {guide.source?.pr === undefined ? null : (
              <a href={guide.source.pr.url} title={guide.source.pr.title}>
                {guide.source.pr.number === undefined
                  ? guide.source.pr.title === undefined || guide.source.pr.title.trim() === ""
                    ? "Source pull request"
                    : guide.source.pr.title
                  : `PR ${guide.source.pr.number}`}
              </a>
            )}
          </div>
          <Text as="h1" variant="page-title">
            {guide.title}
          </Text>
          <Tabs
            aria-label="Read the change"
            className="review-reading"
            id={fragmentId("reading")}
            size="large"
            value={reading}
            onValueChange={setReading}
            items={[
              {
                value: "guide",
                label: "Change guide",
                forceMount: true,
                content: (
                  <section className="review-explanation">
                    <Prose text={guide.intent} />
                    <Text as="h2" variant="card-title">
                      Follow the change
                    </Text>
                    <ol className="review-roadmap">
                      {guide.sections.map((section, index) => (
                        <li key={index}>
                          <a href={`#${fragmentId(`s${index + 1}`)}`}>{section.title}</a>
                          {section.diffs.length === 0 ? null : (
                            <span className="review-muted">
                              {" "}
                              · {section.diffs.length} file{section.diffs.length === 1 ? "" : "s"}
                            </span>
                          )}
                        </li>
                      ))}
                    </ol>
                  </section>
                )
              },
              {
                value: "review",
                label: `Review${findings.issues.length === 0 ? "" : ` · ${findings.issues.length}`}`,
                forceMount: true,
                content: (
                  <Surface as="section" id={fragmentId("verdict")} className="review-verdict">
                    <Text as="h2" variant="section-title">
                      Review verdict
                    </Text>
                    {findings.source === undefined ? (
                      <p className="review-muted">No review source supplied.</p>
                    ) : (
                      <p className="review-muted">From {findings.source}</p>
                    )}
                    <dl className="review-checklist">
                      {findings.checklist.map((check, index) => (
                        <div key={index}>
                          <dt>{check.item}</dt>
                          <dd>
                            <StateLabel
                              size="compact"
                              label={check.verdict}
                              tone={
                                check.verdict === "No" ? "critical" : check.verdict === "Yes" ? "positive" : "neutral"
                              }
                            />
                            {check.note === undefined ? null : <Inline text={check.note} />}
                          </dd>
                        </div>
                      ))}
                    </dl>
                    <ol className="review-issues">
                      {[...findings.issues].sort(bySeverity).map((issue) => (
                        <li key={issue.id}>
                          <Severity issue={issue} />
                          <a href={`#${fragmentId(`issue-${issue.id}`)}`}>
                            <Inline text={issue.summary} links={false} />
                          </a>
                          <code className="review-issue-location">
                            {issue.file}
                            {issue.line === undefined ? "" : `:${issue.line}`}
                          </code>
                        </li>
                      ))}
                    </ol>
                  </Surface>
                )
              }
            ]}
          />
          <GuideUsage usage={guide.usage} />
        </header>
        {guide.sections.map((section, index) => (
          <section className="review-chapter" id={fragmentId(`s${index + 1}`)} key={index}>
            <header className="review-chapter-header">
              <span>{String(index + 1).padStart(2, "0")}</span>
              <Text as="h2" variant="section-title">
                {section.title}
              </Text>
            </header>
            <Prose text={section.overview} />
            {section.diffs.map((diff) => {
              const file = findFile(patch, diff.file)
              return file === undefined ? null : renderFile(file, diff.summary)
            })}
          </section>
        ))}
        {guide.unplacedFiles.length === 0 ? null : (
          <section className="review-chapter" id={fragmentId("rest")}>
            <Text as="h2" variant="section-title">
              Other files
            </Text>
            {guide.unplacedFiles.map((path) => {
              const file = findFile(patch, path)
              return file === undefined ? null : renderFile(file, "")
            })}
          </section>
        )}
        {general.length === 0 ? null : (
          <section className="review-chapter" id={fragmentId("general")}>
            <Text as="h2" variant="section-title">
              Outside the diff
            </Text>
            {general.map(({ issue, reason }) => (
              <div key={issue.id}>
                <p>
                  <code>
                    {issue.file}
                    {issue.line === undefined ? "" : `:${issue.line}`}
                  </code>{" "}
                  ·{" "}
                  {reason === "no-line"
                    ? "no line given"
                    : reason === "outside-hunks"
                      ? "line not in the diff"
                      : "file not in the diff"}
                </p>
                <FindingCard
                  issue={issue}
                  issueId={fragmentId(`issue-${issue.id}`)}
                  readingId={fragmentId("reading")}
                  onReview={() => setReading("review")}
                />
              </div>
            ))}
          </section>
        )}
        {(findings.preExisting?.length ?? 0) === 0 ? null : (
          <section className="review-chapter" aria-labelledby={fragmentId("pre-existing")}>
            <Text as="h2" id={fragmentId("pre-existing")} variant="section-title">
              Pre-existing context
            </Text>
            {findings.preExisting?.map((text, index) => (
              <Prose key={index} text={text} />
            ))}
          </section>
        )}
        {(findings.openQuestions?.length ?? 0) === 0 ? null : (
          <section className="review-chapter" aria-labelledby={fragmentId("open-questions")}>
            <Text as="h2" id={fragmentId("open-questions")} variant="section-title">
              Open questions
            </Text>
            {findings.openQuestions?.map((text, index) => (
              <Prose key={index} text={text} />
            ))}
          </section>
        )}
        <footer className="review-muted">
          {guide.generator?.model === undefined ? "" : `Guide by ${guide.generator.model}. `}Findings retain their
          source wording.
        </footer>
      </main>
    </ThemeProvider>
  )
}
