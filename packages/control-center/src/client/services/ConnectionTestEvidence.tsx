import { StateLabel, Text } from "@knpkv/rly/primitives"
import * as DateTime from "effect/DateTime"
import type { ReactElement } from "react"

import type { PluginConnectionTestResult } from "../../api/plugins.js"
import type { ConnectionTestState } from "./connectionState.js"
import styles from "./ServicesPage.module.css"

const checkedAt = (result: PluginConnectionTestResult): string => DateTime.formatIso(result.checkedAt)

/** Provider identity and timing evidence from the most recent explicit live test. */
export const ConnectionTestEvidence = ({
  state
}: {
  readonly state: ConnectionTestState | undefined
}): ReactElement | null => {
  if (state === undefined || state._tag === "testing") return null
  if (state._tag === "request-failed") {
    return (
      <div aria-live="polite" className={styles.testEvidence} role="status">
        <StateLabel label="Test failed" tone="critical" />
        <Text tone="secondary" variant="body">
          Control Center could not complete the test. Check the server and try again.
        </Text>
      </div>
    )
  }
  const result = state.result
  const checkedAtIso = checkedAt(result)
  return (
    <div aria-live="polite" className={styles.testEvidence} role="status">
      <StateLabel
        label={result._tag === "healthy" ? "Connection healthy" : "Test failed"}
        tone={result._tag === "healthy" ? "positive" : "critical"}
      />
      {result._tag === "healthy" ? (
        <div className={styles.identity}>
          <Text tone="secondary" variant="meta">
            {result.identity.label}
          </Text>
          <Text as="span" variant="card-title">
            {result.identity.displayName}
          </Text>
          <Text className={styles.identifier} tone="secondary" variant="body">
            {result.identity.providerImmutableId}
          </Text>
        </div>
      ) : (
        <Text tone="secondary" variant="body">
          {result.safeMessage}
        </Text>
      )}
      <Text tone="secondary" variant="meta">
        Checked <time dateTime={checkedAtIso}>{checkedAtIso}</time> · {result.latencyMilliseconds} ms
      </Text>
    </div>
  )
}
