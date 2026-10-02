import { mountGuideDiagrams } from "./diagrams.js"

const start = () => {
  const root = document.getElementById("review-root")
  if (root !== null) mountGuideDiagrams(root)
}
if (document.documentElement.dataset.reviewReady === "true") start()
else document.addEventListener("review-ready", start, { once: true })
