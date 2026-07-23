import { PeopleStrip } from "@knpkv/rly/patterns"
import { StateLabel, Text } from "@knpkv/rly/primitives"
import { type ReactElement, type ReactNode, useState } from "react"

import type { WorkspaceConfluencePagePresentation } from "./presentWorkspaceConfluencePage.js"
import { WorkspaceRichText } from "./WorkspaceRichText.js"
import styles from "./WorkspaceConfluencePageDetails.module.css"

const Section = ({
  children,
  heading,
  meta
}: {
  readonly children: ReactNode
  readonly heading: string
  readonly meta: string
}): ReactElement => (
  <section className={styles.section}>
    <header className={styles.sectionHeading}>
      <Text as="h2" variant="section-title">
        {heading}
      </Text>
      <Text tone="secondary" variant="meta">
        {meta}
      </Text>
    </header>
    {children}
  </section>
)

/** Render one canonical Confluence page without exposing provider media or write controls. */
export const WorkspaceConfluencePageDetails = ({
  page
}: {
  readonly page: WorkspaceConfluencePagePresentation
}): ReactElement => {
  const [peopleExpanded, setPeopleExpanded] = useState(false)
  return (
    <article className={styles.document} data-workspace-confluence-page-detail>
      <section aria-label="Document identity" className={styles.folio}>
        <div className={styles.revision}>
          <span>Revision</span>
          <strong>{page.revision}</strong>
        </div>
        <div className={styles.folioMeta}>
          <StateLabel
            label={page.status}
            tone={page.status === "Superseded" ? "caution" : page.status === "Current" ? "positive" : "neutral"}
          />
          <dl>
            <div>
              <dt>Space</dt>
              <dd>{page.sourceSpaceId}</dd>
            </div>
            <div>
              <dt>Updated</dt>
              <dd>
                {page.updatedAt === null ? (
                  "Not synchronized"
                ) : (
                  <time dateTime={page.updatedAt.dateTime}>{page.updatedAt.label}</time>
                )}
              </dd>
            </div>
            <div>
              <dt>Created</dt>
              <dd>
                {page.createdAt === null ? (
                  "Not synchronized"
                ) : (
                  <time dateTime={page.createdAt.dateTime}>{page.createdAt.label}</time>
                )}
              </dd>
            </div>
          </dl>
        </div>
      </section>

      <Section heading="Document" meta="Safely converted text; raw provider markup and media stay outside this view">
        {page.contentState === "loaded" && page.content !== null ? (
          <WorkspaceRichText className={styles.richText} value={page.content} />
        ) : (
          <div className={styles.contentState} data-content-state={page.contentState}>
            <strong>
              {page.contentState === "lazy" ? "Content has not been loaded" : "No readable body was returned"}
            </strong>
            <Text tone="secondary">
              {page.contentState === "lazy"
                ? "The page is synchronized lazily. Open the authenticated Confluence source to read it now."
                : "Revision metadata remains available in this read-only view."}
            </Text>
          </div>
        )}
      </Section>

      <Section heading="People" meta={page.watcherInventoryLabel}>
        {page.contributors.length === 0 ? (
          <Text tone="secondary">No owner, contributor, or watcher identity was synchronized.</Text>
        ) : (
          <PeopleStrip
            aria-label="Page collaborators"
            expanded={peopleExpanded}
            limit={4}
            onExpandedChange={setPeopleExpanded}
            people={page.contributors}
          />
        )}
      </Section>

      <div className={styles.collections}>
        <Section heading="Revision history" meta={page.historyInventoryLabel}>
          {page.versions.length === 0 ? (
            <Text tone="secondary">No revision history was synchronized.</Text>
          ) : (
            <ol className={styles.versions}>
              {page.versions.map((version) => (
                <li key={`${String(version.number)}-${version.createdAt.dateTime}`}>
                  <strong>v{version.number}</strong>
                  <span>{version.message}</span>
                  <small>
                    {version.author} · <time dateTime={version.createdAt.dateTime}>{version.createdAt.label}</time>
                    {version.minorEdit ? " · Minor edit" : ""}
                  </small>
                </li>
              ))}
            </ol>
          )}
        </Section>

        <Section heading="Attachments" meta={page.attachmentInventoryLabel}>
          {page.attachments.length === 0 ? (
            <Text tone="secondary">No attachment metadata was synchronized.</Text>
          ) : (
            <ul className={styles.attachments}>
              {page.attachments.map((attachment) => (
                <li key={attachment.id}>
                  <strong>{attachment.title}</strong>
                  <span>
                    {attachment.mediaType} · {attachment.fileSize} · {attachment.version}
                  </span>
                  <small>Metadata only · authenticated proxy required</small>
                </li>
              ))}
            </ul>
          )}
        </Section>
      </div>

      <Section heading="Runbook evidence" meta="Immutable delivery evidence around this page">
        <div className={styles.evidenceCount}>
          <strong>{page.runbookEvidenceCount}</strong>
          <span>evidence item{page.runbookEvidenceCount === 1 ? "" : "s"} in the current bounded graph</span>
        </div>
      </Section>
    </article>
  )
}
