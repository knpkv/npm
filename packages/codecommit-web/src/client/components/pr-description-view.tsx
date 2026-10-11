import { Surface, Text } from "@knpkv/rly/primitives"
import Markdown from "react-markdown"
import rehypeSanitize from "rehype-sanitize"
import remarkGfm from "remark-gfm"
import type { PRDescriptionViewProps } from "./pr-detail-view.js"
import styles from "./pr-detail.module.css"

export type { PRDescriptionViewProps } from "./pr-detail-view.js"

export function PRDescriptionView({ description }: PRDescriptionViewProps) {
  return (
    <Surface as="section" className={styles.contentSection} padding="spacious" form="grouped">
      <header className={styles.sectionHeading}>
        <Text as="h2" variant="card-title">
          Description
        </Text>
        <Text tone="secondary" variant="meta">
          What the author says this revision changes
        </Text>
      </header>
      <div className={`${styles.description ?? ""} prose prose-sm dark:prose-invert max-w-none`}>
        <Markdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeSanitize]}>
          {description}
        </Markdown>
      </div>
    </Surface>
  )
}
