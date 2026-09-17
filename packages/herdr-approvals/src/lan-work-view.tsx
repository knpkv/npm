import { Button, Field, Surface, Text } from "@knpkv/rly/primitives"
import type { ReactElement } from "react"
import { WorkBoard, type WorkSnapshotWindow, type WorkSnapshots } from "@knpkv/herdr-work"

/** The LAN boundary is a plain form so the pairing code never enters a URL or client storage. */
export const LanWorkPairPage = ({ error }: { readonly error?: string }): ReactElement => (
  <section aria-labelledby="lan-work-pair-title" className="lan-work-pair">
    <header>
      <Text as="h1" id="lan-work-pair-title" variant="page-title">
        Pair this browser
      </Text>
      <Text tone="secondary" variant="body-large">
        Use the one-time code printed by the local Work server. It expires after five minutes.
      </Text>
    </header>
    <Surface as="section" padding="spacious" form="grouped" tone="secondary">
      <form action="/pair" method="post">
        <Field
          description="The code stays in this request and is never placed in a URL."
          label="Pairing code"
          required
          {...(error === undefined ? {} : { error })}
        >
          {(controlProps) => (
            <input
              {...controlProps}
              autoComplete="one-time-code"
              inputMode="text"
              maxLength={64}
              name="pairingCode"
              spellCheck={false}
            />
          )}
        </Field>
        <Button size="principal" type="submit" variant="primary">
          Pair browser
        </Button>
      </form>
    </Surface>
  </section>
)

export const LanWorkPage = ({
  goalId,
  snapshots,
  window = "now"
}: {
  readonly goalId?: string | null
  readonly snapshots: WorkSnapshots
  readonly window?: WorkSnapshotWindow
}): ReactElement => (
  <main className="lan-work-page">
    <WorkBoard
      externalLinks="disabled"
      {...(goalId === undefined ? {} : { initialGoalId: goalId })}
      initialWindow={window}
      navigation={({ goalId: selectedGoalId, window: selectedWindow }) => {
        const params = new URLSearchParams({ window: selectedWindow })
        if (selectedGoalId !== null) params.set("goal", selectedGoalId)
        return `/?${params.toString()}`
      }}
      snapshots={snapshots}
    />
  </main>
)
