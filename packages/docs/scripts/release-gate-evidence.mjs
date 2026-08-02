const evidenceRowPattern =
  /^\|\s*(SC7\.\d+|Product completion journey)\s*\|\s*([^|]+)\s*\|\s*([^|]+)\s*\|\s*([^|]+)\s*\|\s*$/gmu
const shaPattern = /\b[0-9a-f]{40}\b/u
const isoTimestampPattern = /\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z\b/u
const statuses = new Set(["PENDING", "PASS", "FAIL", "BLOCKED"])

export const parseReleaseGateRows = (markdown) =>
  Array.from(markdown.matchAll(evidenceRowPattern), (match) => ({
    criterion: match[1],
    status: match[2].trim(),
    reviewed: match[3].trim(),
    cleanup: match[4].trim(),
    raw: match[0]
  }))

const validateCanonicalFields = (row) => {
  const failures = []
  const fieldValue = (text, fieldPattern) =>
    text.match(new RegExp(`(?:${fieldPattern})\\s*[:=]\\s*([^;|]*)`, "iu"))?.[1]?.trim() ?? ""
  const commandResult = fieldValue(row.reviewed, "commandResult")
  const artifact = fieldValue(row.reviewed, "artifact|CI link")
  const cleanupResult = fieldValue(row.cleanup, "cleanupResult")
  if (!shaPattern.test(row.reviewed))
    failures.push(`${row.criterion} PASS row must include a 40-character reviewedHead SHA`)
  if (commandResult.length === 0) failures.push(`${row.criterion} PASS row must include a non-blank commandResult`)
  if (artifact.length === 0) failures.push(`${row.criterion} PASS row must include an artifact or CI link`)
  if (!isoTimestampPattern.test(row.reviewed))
    failures.push(`${row.criterion} PASS row must include an ISO-8601 executedAt timestamp`)
  if (cleanupResult.length === 0) failures.push(`${row.criterion} PASS row must include a non-blank cleanupResult`)
  return failures
}

export const validateReleaseGateEvidence = (markdown, { releaseGate = false } = {}) => {
  const rows = parseReleaseGateRows(markdown)
  const failures = []
  const seen = new Set()
  for (const row of rows) {
    if (seen.has(row.criterion)) failures.push(`release-gate evidence contains duplicate ${row.criterion}`)
    seen.add(row.criterion)
    if (!statuses.has(row.status)) failures.push(`${row.criterion} has invalid status ${row.status}`)
    if (row.status === "PASS") failures.push(...validateCanonicalFields(row))
    if (releaseGate && row.status !== "PASS") failures.push(`${row.criterion} is not PASS in release-gate mode`)
  }
  for (const criterion of Array.from({ length: 25 }, (_, index) => `SC7.${index + 1}`)) {
    if (!seen.has(criterion)) failures.push(`release-gate evidence is missing ${criterion}`)
  }
  const completion = rows.find((row) => row.criterion === "Product completion journey")
  if (completion === undefined) failures.push("release-gate evidence is missing the product completion journey")
  else if (releaseGate && completion.status !== "PASS")
    failures.push("product completion journey is not PASS in release-gate mode")
  return failures
}
