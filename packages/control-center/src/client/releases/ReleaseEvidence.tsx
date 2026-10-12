import { ServiceMark } from "@knpkv/rly/patterns"
import { StateLabel, Surface, Text } from "@knpkv/rly/primitives"
import type { ReactElement } from "react"
import type { PortfolioReleasePresentation } from "../portfolio/presentPortfolio.js"
import styles from "./ReleaseRoute.module.css"

export interface ReleaseEvidenceProps {
  readonly release: PortfolioReleasePresentation
}

/** Show source health and preserved evidence for an explicit release presentation. */
export const ReleaseEvidence = ({ release }: ReleaseEvidenceProps): ReactElement => (
  <Surface as="section" className={styles.evidence} padding="compact" tone="secondary">
    <div className={styles.evidenceHeading}>
      {release.source.service === null ? null : <ServiceMark service={release.source.service} />}
      <div>
        <Text as="h2" variant="card-title">
          {release.source.displayName}
        </Text>
        <Text tone="secondary" variant="meta">
          Source evidence
        </Text>
      </div>
    </div>
    <StateLabel label={release.source.healthLabel} size="compact" tone={release.source.healthTone} />
    {release.source.warning === null ? (
      <Text tone="secondary">Detailed evidence is not evaluated in the tracer snapshot.</Text>
    ) : (
      <Text tone="secondary">{release.source.warning}</Text>
    )}
  </Surface>
)
