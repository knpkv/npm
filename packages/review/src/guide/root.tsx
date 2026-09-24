import { useEffect } from "react"
import { GuidePage, type GuidePageProps } from "./view.js"

const Ready = () => {
  useEffect(() => {
    document.documentElement.dataset.reviewReady = "true"
    document.dispatchEvent(new Event("review-ready"))
  }, [])
  return null
}

/** Render the same guide tree on the server and during hydration, then signal readiness after commit. */
export const GuideRoot = (props: GuidePageProps) => (
  <>
    <GuidePage {...props} />
    <Ready />
  </>
)
