import { StateLabel, Text } from "@knpkv/rly/primitives"
import { getScoreTier, type HealthScoreCategory } from "@knpkv/codecommit-core/HealthScore.js"
import { Option } from "effect"
import type { PRHealthPresentation } from "./pr-detail-view.js"
import { healthTone, categoryTone } from "./pr-detail-presentation.js"
import styles from "./pr-detail.module.css"

export interface PRHealthBreakdownViewProps {
  readonly health: PRHealthPresentation
}

export function PRHealthBreakdownView({ health }: PRHealthBreakdownViewProps) {
  return <ScoreBreakdown {...health} />
}

function ScoreBreakdown({ score, unknownReason }: PRHealthPresentation) {
  if (score === undefined) {
    return (
      <Text tone="secondary" variant="meta">
        {`Not enough data to score: ${Option.getOrElse(unknownReason, () => "no dates")}.`}
      </Text>
    )
  }
  const tier = getScoreTier(score.total)

  return (
    <div className={styles.scoreBreakdown}>
      <div className={styles.scoreSummary}>
        <strong data-tone={healthTone(tier)}>{score.total.toFixed(1)}</strong>
        <span>/ 10</span>
        <div
          aria-label={`Health score ${score.total.toFixed(1)} out of 10`}
          aria-valuemax={10}
          aria-valuemin={0}
          aria-valuenow={score.total}
          className={styles.scoreTrack}
          role="progressbar"
        >
          <div className={styles.scoreFill} data-tone={healthTone(tier)} style={{ width: `${score.total * 10}%` }} />
        </div>
      </div>
      <ul className={styles.scoreCategories}>
        {score.categories.map((cat: HealthScoreCategory) => (
          <li key={cat.label} className={styles.scoreCategory}>
            <span className={styles.scoreDelta} data-direction={cat.value > 0 ? "up" : cat.value < 0 ? "down" : "flat"}>
              {cat.value > 0 ? `+${cat.value}` : cat.value}
            </span>
            <div className={styles.scoreCategoryCopy}>
              <div>
                <Text as="strong" variant="label">
                  {cat.label}
                </Text>
                <StateLabel label={cat.statusLabel} size="compact" tone={categoryTone(cat.status)} />
              </div>
              <Text tone="secondary" variant="meta">
                {cat.description}
              </Text>
            </div>
          </li>
        ))}
      </ul>
    </div>
  )
}
