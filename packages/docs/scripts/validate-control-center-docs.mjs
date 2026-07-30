import { readFile, stat } from "node:fs/promises"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const docsRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const workspaceRoot = resolve(docsRoot, "../..")
const sourceOnly = process.argv.includes("--source-only")
const docsFiles = [
  "control-center.mdx",
  "control-center-setup.mdx",
  "control-center-operations.mdx",
  "control-center-governance.mdx",
  "control-center-troubleshooting.mdx"
]
const docsSources = new Map(
  await Promise.all(
    docsFiles.map(async (file) => [file, await readFile(resolve(docsRoot, "src/content/docs", file), "utf8")])
  )
)
const allDocs = Array.from(docsSources.values()).join("\n")
const failures = []
const readJson = async (path) => JSON.parse(await readFile(path, "utf8"))

const controlCenterPackage = await readJson(resolve(workspaceRoot, "packages/control-center/package.json"))
const expectedEntries = Object.keys(controlCenterPackage.exports ?? {}).map((subpath) =>
  subpath === "." ? "@knpkv/control-center" : `@knpkv/control-center/${subpath.slice(2)}`
)
for (const entry of expectedEntries) {
  if (!allDocs.includes(`\`${entry}\``)) failures.push(`missing public package entry ${entry}`)
}
if (!allDocs.includes("`control-center`")) failures.push("missing control-center binary")

const cliSource = await readFile(resolve(workspaceRoot, "packages/control-center/src/server/cli.ts"), "utf8")
const configuredVariables = new Set(
  Array.from(
    cliSource.matchAll(/Config\.(?:boolean|int|redacted|string)\("(CONTROL_CENTER_[A-Z0-9_]+)"\)/g),
    (match) => match[1]
  )
)
for (const variable of configuredVariables) {
  if (!allDocs.includes(`\`${variable}\``)) failures.push(`missing server configuration ${variable}`)
}

const requiredSections = new Map([
  [
    "control-center.mdx",
    [
      "Start here",
      "Product model",
      "First-party providers",
      "Release-aware agents",
      "Presentation system",
      "Public package entries",
      "Stability"
    ]
  ],
  [
    "control-center-setup.mdx",
    [
      "Install and pair",
      "Connect providers",
      "Configure local AI",
      "Enable contained PR review",
      "Trusted remote access",
      "Server configuration reference"
    ]
  ],
  [
    "control-center-operations.mdx",
    [
      "Process lifecycle",
      "OpenTelemetry",
      "Owner recovery",
      "Offline backup and restore",
      "Retention and startup recovery",
      "Acceptance and benchmark gates"
    ]
  ],
  [
    "control-center-governance.mdx",
    [
      "Authority stays on the server",
      "Governed action lifecycle",
      "Provider-specific behavior",
      "Contained pull-request review",
      "Prevention proposals",
      "Audit and retention"
    ]
  ],
  [
    "control-center-troubleshooting.mdx",
    [
      "Startup rejects the data root",
      "Pairing code is rejected",
      "Atlassian OAuth callback fails",
      "Governed action remains pending",
      "PR-review sandbox is unavailable",
      "Benchmark validation fails"
    ]
  ]
])
for (const [file, headings] of requiredSections) {
  const source = docsSources.get(file) ?? ""
  for (const heading of headings) {
    if (!source.includes(`## ${heading}`)) failures.push(`${file} is missing ${heading}`)
  }
}

for (const route of [
  "/control-center-setup/",
  "/control-center-operations/",
  "/control-center-governance/",
  "/control-center-troubleshooting/",
  "/ai-runtime/",
  "/ai-codex/",
  "/ai-claude/",
  "/rly/",
  "/rly/catalog/"
]) {
  if (!allDocs.includes(`](${route})`)) failures.push(`missing required cross-link ${route}`)
}

const sourceRoutes = new Set([
  ...docsFiles.map((file) => `/${file.replace(/\.mdx$/u, "")}/`),
  "/ai-runtime/",
  "/ai-codex/",
  "/ai-claude/",
  "/rly/",
  "/rly/catalog/"
])
for (const [file, source] of docsSources) {
  for (const match of source.matchAll(/\]\((\/[^)#?]+\/)(?:#[^)]+)?\)/g)) {
    const route = match[1]
    if (!sourceRoutes.has(route)) failures.push(`${file} contains unknown internal route ${route}`)
  }
}

const providerClaims = [
  "CodeCommit",
  "CodePipeline",
  "Jira",
  "Confluence",
  "Clockify",
  "request changes",
  "proposals only",
  "Start, stop, manual approval, and retry",
  "Version-bound page publication",
  "Correct association"
]
const overview = docsSources.get("control-center.mdx") ?? ""
for (const claim of providerClaims) {
  if (!overview.includes(claim)) failures.push(`provider capability summary is missing ${claim}`)
}

const governance = docsSources.get("control-center-governance.mdx") ?? ""
const governanceSection = (provider) =>
  governance.match(new RegExp(`### ${provider}\\n([\\s\\S]*?)(?=\\n### |\\n## )`, "u"))?.[1] ?? ""
const governanceExample = (provider, kind) => {
  const section = governanceSection(provider)
  const marker = `{/* governance-example:${provider}:${kind} */}`
  const markerIndex = section.indexOf(marker)
  if (markerIndex < 0) return ""
  const afterMarker = section.slice(markerIndex + marker.length).trimStart()
  return /^```text\n([\s\S]*?)\n```/u.exec(afterMarker)?.[1] ?? ""
}
const providerExamples = new Map([
  [
    "CodePipeline",
    {
      canonical: [
        "governed_actions.envelope_json",
        "governed_action_authorizations",
        "authorizationId",
        "idempotencyKey",
        "payloadDigest"
      ],
      idempotency: ["clientRequestToken", "authorizationId", "idempotencyKey", "payloadDigest"]
    }
  ],
  [
    "Clockify",
    {
      canonical: [
        "governed_actions.envelope_json",
        "workspaceId",
        "userId",
        "entryId",
        "expectedRevision",
        "desiredRevision"
      ],
      idempotency: [
        "idempotencyKey",
        "schemaVersion",
        "workspaceId",
        "entityId",
        "request",
        "_tag",
        "expectedRevision",
        "jiraIssueKey"
      ]
    }
  ]
])
const rawProviderSecretField =
  /\b(?:access[_-]?key(?:[_-]?id)?|secret[_-]?access[_-]?key|session[_-]?token|approval[_-]?token|api[_-]?(?:token|key)|client[_-]?secret|access[_-]?token|refresh[_-]?token|private[_-]?key|password)\b/iu
for (const fixture of ["apiKey", "access_token"]) {
  if (!rawProviderSecretField.test(fixture)) {
    failures.push(`raw-provider-secret guardrail accepted invalid fixture ${fixture}`)
  }
}
for (const fixture of ["apiKeyReference", "access_token_digest"]) {
  if (rawProviderSecretField.test(fixture)) {
    failures.push(`raw-provider-secret guardrail rejected valid fixture ${fixture}`)
  }
}
for (const [provider, examples] of providerExamples) {
  for (const [kind, fields] of Object.entries(examples)) {
    const example = governanceExample(provider, kind)
    for (const field of fields) {
      if (!example.includes(field)) {
        failures.push(`${provider} ${kind} example is missing ${field}`)
      }
    }
    if (rawProviderSecretField.test(example)) {
      failures.push(`${provider} ${kind} example describes a raw provider secret as durable`)
    }
  }
}

const routerSource = await readFile(resolve(workspaceRoot, "packages/codecommit-web/src/client/router.tsx"), "utf8")
if (/prototypes?\/|ControlCenterPrototype/u.test(routerSource)) {
  failures.push("CodeCommit production router still references a prototype")
}
const viteSource = await readFile(resolve(workspaceRoot, "packages/codecommit-web/vite.config.ts"), "utf8")
if (!viteSource.includes("productionPrototypeBoundary(clientRoot)")) {
  failures.push("CodeCommit production build does not install the prototype graph boundary")
}
const boundarySource = await readFile(
  resolve(workspaceRoot, "packages/codecommit-web/src/tooling/production-prototype-boundary.ts"),
  "utf8"
)
if (!boundarySource.includes("this.getModuleIds()") || !boundarySource.includes("prototypes/")) {
  failures.push("prototype graph boundary does not inspect resolved production modules")
}
const fixture = await stat(
  resolve(workspaceRoot, "packages/codecommit-web/src/client/prototypes/control-center/control-center-prototype.tsx")
).catch(() => undefined)
if (!fixture?.isFile()) failures.push("approved Control Center visual fixture was not retained")
const staticRule = await readFile(
  resolve(workspaceRoot, "ast-grep/rules/typescript/no-production-prototype-import.yml"),
  "utf8"
)
if (!staticRule.includes("id: no-production-prototype-import") || !staticRule.includes("**/prototypes/**")) {
  failures.push("prototype import static-analysis boundary is missing")
}
if (!/prototype is retired from production routing/u.test(overview)) {
  failures.push("prototype retirement is not explicit in Control Center docs")
}

if (!sourceOnly) {
  for (const file of docsFiles) {
    const route = file.replace(/\.mdx$/u, "")
    const output = resolve(docsRoot, "dist", route, "index.html")
    const entry = await stat(output).catch(() => undefined)
    if (!entry?.isFile()) failures.push(`missing built Control Center page ${route}`)
  }
  const overviewHtml = await readFile(resolve(docsRoot, "dist/control-center/index.html"), "utf8").catch(() => "")
  for (const href of ["/control-center-setup/", "/control-center-governance/", "/rly/catalog/"]) {
    if (!overviewHtml.includes(`href="${href}"`)) failures.push(`built overview is missing ${href}`)
  }
}

if (failures.length > 0) {
  throw new Error(`Control Center docs validation failed:\n- ${failures.join("\n- ")}`)
}

console.log(
  `validated Control Center docs against ${expectedEntries.length} public exports, ${configuredVariables.size} server variables, and retired prototype boundaries${sourceOnly ? "" : " plus built links"}`
)
