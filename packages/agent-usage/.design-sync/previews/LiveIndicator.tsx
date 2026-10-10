// States from the LiveState union in src/client/useLiveUpdates.ts. The indicator ticks against the
// page clock, so each card stamps its last update twelve seconds before it mounts.
import { LiveIndicator } from "@knpkv/agent-usage-design-system"
import { useState } from "react"
import { Page } from "../fixtures/page.js"

const useTwelveSecondsAgo = () => useState(() => performance.timeOrigin + performance.now() - 12_000)[0]

/** Connecting to the live update stream. */
export const Connecting = () => (
  <Page>
    <LiveIndicator state={{ _tag: "Connecting" }} />
  </Page>
)

/** Live: the last update's age. */
export const Live = () => {
  const updatedAt = useTwelveSecondsAgo()
  return (
    <Page>
      <LiveIndicator state={{ _tag: "Live", refetchFailing: false, updatedAt }} />
    </Page>
  )
}

/** Live, but the latest refetch failed. */
export const RefetchFailing = () => {
  const updatedAt = useTwelveSecondsAgo()
  return (
    <Page>
      <LiveIndicator state={{ _tag: "Live", refetchFailing: true, updatedAt }} />
    </Page>
  )
}

/** The stream dropped. */
export const Disconnected = () => {
  const updatedAt = useTwelveSecondsAgo()
  return (
    <Page>
      <LiveIndicator state={{ _tag: "Disconnected", updatedAt }} />
    </Page>
  )
}
