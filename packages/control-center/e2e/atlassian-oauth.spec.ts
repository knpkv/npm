import { AuthProfilesFileSchema } from "@knpkv/atlassian-common/config"
import { expect, test } from "@playwright/test"
import * as Predicate from "effect/Predicate"
import * as Schema from "effect/Schema"
import { type ChildProcess, type ChildProcessByStdio, spawn } from "node:child_process"
import { access, mkdtemp, readdir, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { delimiter, join } from "node:path"
import type { Readable } from "node:stream"
import { browserSurfaceExposesSecret, snapshotBrowserReadableSurface } from "./browserSecretSurface.js"

const enabled = process.env.CONTROL_CENTER_TEST_ATLASSIAN_OAUTH === "1"

const requiredConfiguration = (name: string): string => {
  const value = process.env[name]?.trim()
  if (value === undefined || value.length === 0) {
    throw new Error(`Missing ${name}; see the opt-in Atlassian OAuth acceptance command documentation.`)
  }
  return value
}

interface StartedServer {
  readonly process: ChildProcessByStdio<null, Readable, Readable>
  readonly pairingCode: string
  readonly output: ReadonlyArray<string>
}

interface ServerEnvironment {
  readonly configRoot: string
  readonly homeRoot: string
}

const stopServer = async (server: ChildProcess): Promise<void> => {
  const exited = new Promise<void>((resolve) => server.once("exit", () => resolve()))
  if (server.exitCode !== null) return
  server.kill("SIGTERM")
  const didExit = await Promise.race([
    exited.then(() => true),
    new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 10_000))
  ])
  if (didExit || server.exitCode !== null) return
  server.kill("SIGKILL")
  await Promise.race([exited, new Promise<void>((resolve) => setTimeout(resolve, 5_000))])
}

const isMissingPathError = (cause: unknown): boolean =>
  Predicate.isObjectOrArray(cause) && cause !== null && "code" in cause && cause.code === "ENOENT"

const startServer = async (
  dataRoot: string,
  port: number,
  environment: ServerEnvironment
): Promise<StartedServer> => {
  const output: Array<string> = []
  const inheritedEnvironment = Object.fromEntries(
    Object.entries(process.env).filter(
      ([name]) => !name.startsWith("CONTROL_CENTER_TEST_ATLASSIAN_") || name === "CONTROL_CENTER_TEST_ATLASSIAN_OAUTH"
    )
  )
  const server = spawn(process.execPath, [join(process.cwd(), "dist/server/server/cli.js")], {
    cwd: process.cwd(),
    env: {
      ...inheritedEnvironment,
      CONTROL_CENTER_ALLOWED_ORIGINS: `http://127.0.0.1:${port}`,
      CONTROL_CENTER_DATA_ROOT: dataRoot,
      CONTROL_CENTER_HOST: "127.0.0.1",
      CONTROL_CENTER_PORT: String(port),
      CONTROL_CENTER_PUBLIC_ORIGIN: `http://127.0.0.1:${port}`,
      HOME: environment.homeRoot,
      PATH: process.env.PATH ?? delimiter,
      XDG_CONFIG_HOME: environment.configRoot
    },
    stdio: ["ignore", "pipe", "pipe"]
  })
  const ready = new Promise<void>((resolve, reject) => {
    const onOutput = (chunk: Buffer): void => {
      output.push(chunk.toString())
      if (output.join("").match(/Pairing code: ([a-zA-Z0-9]{64})/u) !== null) resolve()
    }
    server.stdout.on("data", onOutput)
    server.stderr.on("data", onOutput)
    server.once("error", reject)
    server.once("exit", (code, signal) => {
      reject(new Error(`Control Center exited before pairing (${code ?? signal}): ${output.join("")}`))
    })
  })
  try {
    await ready
  } catch (cause) {
    await stopServer(server)
    throw cause
  }
  const pairingCode = output.join("").match(/Pairing code: ([a-zA-Z0-9]{64})/u)?.[1]
  if (pairingCode === undefined) throw new Error("Control Center did not print a pairing code")
  return { pairingCode, output, process: server }
}

const collectFiles = async (root: string, excludedDirectory?: string): Promise<ReadonlyArray<Buffer>> => {
  const contents: Array<Buffer> = []
  const entries = await readdir(root, { withFileTypes: true }).catch((cause: unknown) => {
    if (isMissingPathError(cause)) return []
    throw cause
  })
  for (const entry of entries) {
    const path = join(root, entry.name)
    if (entry.isDirectory() && entry.name !== excludedDirectory) {
      for (const content of await collectFiles(path, excludedDirectory)) contents.push(content)
    }
    if (entry.isFile()) {
      const content = await readFile(path).catch((cause: unknown) => {
        if (isMissingPathError(cause)) return undefined
        throw cause
      })
      if (content !== undefined) contents.push(content)
    }
  }
  return contents
}

const collectCredentialStrings = <UnparsedInput>(value: UnparsedInput, key = ""): Array<string> => {
  if (Predicate.isString(value)) {
    return /(?:token|secret|credential)/iu.test(key) && value.length > 20 ? [value] : []
  }
  if (Array.isArray(value)) return value.flatMap((item) => collectCredentialStrings(item, key))
  if (value !== null && Predicate.isObjectOrArray(value)) {
    return Object.entries(value).flatMap(([entryKey, entryValue]) => collectCredentialStrings(entryValue, entryKey))
  }
  return []
}

const readJsonCredentialStrings = async (root: string): Promise<ReadonlyArray<string>> => {
  const values: Array<string> = []
  for (const content of await collectFiles(root)) {
    try {
      for (const value of collectCredentialStrings(JSON.parse(content.toString("utf8")))) values.push(value)
    } catch {
      // Non-JSON files are not profile records.
    }
  }
  return values
}

const dataRootContains = async (root: string, needle: string): Promise<boolean> => {
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name)
    if (entry.isDirectory() && entry.name !== "secrets" && (await dataRootContains(path, needle))) return true
    if (entry.isFile()) {
      const content = await readFile(path).catch(() => undefined)
      if (content?.includes(needle)) return true
    }
  }
  return false
}

const waitForRemoved = async (path: string): Promise<void> => {
  await expect.poll(async () => access(path).then(() => true).catch(() => false)).toBe(false)
}

test.describe("opt-in real Atlassian OAuth journey", () => {
  test.skip(!enabled, "set CONTROL_CENTER_TEST_ATLASSIAN_OAUTH=1 to run the real-provider journey")

  test("shares one OAuth profile across Jira and Confluence", async ({ page }) => {
    test.setTimeout(30 * 60 * 1_000)
    const clientId = requiredConfiguration("CONTROL_CENTER_TEST_ATLASSIAN_CLIENT_ID")
    const clientSecret = requiredConfiguration("CONTROL_CENTER_TEST_ATLASSIAN_CLIENT_SECRET")
    const projectId = requiredConfiguration("CONTROL_CENTER_TEST_ATLASSIAN_PROJECT_ID")
    const spaceId = requiredConfiguration("CONTROL_CENTER_TEST_ATLASSIAN_SPACE_ID")
    const pageId = requiredConfiguration("CONTROL_CENTER_TEST_ATLASSIAN_PAGE_ID")
    const expectedEmail = requiredConfiguration("CONTROL_CENTER_TEST_ATLASSIAN_EXPECTED_ACCOUNT_EMAIL")
    const expectedSiteUrl = requiredConfiguration("CONTROL_CENTER_TEST_ATLASSIAN_EXPECTED_SITE_URL")
    const configuredPort = Number(process.env.CONTROL_CENTER_TEST_ATLASSIAN_PORT ?? "4173")
    if (!Number.isInteger(configuredPort) || configuredPort < 1 || configuredPort > 65_535) {
      throw new Error("CONTROL_CENTER_TEST_ATLASSIAN_PORT must be an integer between 1 and 65535")
    }
    const temporaryRoots: Array<string> = []
    const makeTemporaryRoot = async (prefix: string): Promise<string> => {
      const root = await mkdtemp(join(tmpdir(), prefix))
      temporaryRoots.push(root)
      return root
    }
    let roots: { readonly configRoot: string; readonly dataRoot: string; readonly homeRoot: string } | undefined
    let server: ChildProcess | undefined
    const browserConsole: Array<string> = []
    page.on("console", (message) => browserConsole.push(message.text()))
    let cleanupFailure: AggregateError | undefined
    try {
      roots = {
        configRoot: await makeTemporaryRoot("control-center-atlassian-config-"),
        dataRoot: await makeTemporaryRoot("control-center-atlassian-oauth-"),
        homeRoot: await makeTemporaryRoot("control-center-atlassian-home-")
      }
      const { configRoot, dataRoot, homeRoot } = roots
      const started = await startServer(dataRoot, configuredPort, { configRoot, homeRoot })
      server = started.process
      const origin = `http://127.0.0.1:${configuredPort}`

      await page.goto(`${origin}/pair`)
      await page.getByLabel("Pairing code").fill(started.pairingCode)
      await page.getByRole("button", { name: "Pair browser" }).click()
      await expect(page).toHaveURL(`${origin}/`)

      await page.goto(`${origin}/services?enable=jira&atlassianProvider=jira&atlassianProvider=confluence`)
      await page.getByLabel("Account name").fill("Real Atlassian OAuth acceptance")
      await page.getByRole("button", { name: "Sign in with Atlassian" }).click()
      await page.getByLabel("OAuth client ID").fill(clientId)
      await page.getByLabel("OAuth client secret").fill(clientSecret)
      await page.getByRole("button", { name: "Save OAuth app and continue" }).click()

      // The external consent and login are deliberately the only human step.
      await page.waitForURL(/auth\.atlassian\.com/u, { timeout: 0 })
      await page.waitForURL(/\/services\/oauth\/atlassian\/callback/u, { timeout: 0 })
      await expect(page.getByText(expectedEmail)).toBeVisible()
      await expect(page.getByText(expectedSiteUrl)).toBeVisible()
      await page.getByRole("button", { name: "Use this site" }).click()

      await page.getByLabel("Jira project ID").fill(projectId)
      await page.getByLabel("Confluence space ID").fill(spaceId)
      await page.getByLabel("Health page ID").fill(pageId)
      await page.getByRole("button", { name: "Connect Atlassian" }).click()

      await expect(page.getByRole("heading", { name: "Services" })).toBeVisible()
      const testConnectionButtons = page.getByRole("button", { name: "Test connection" })
      await expect(testConnectionButtons).toHaveCount(2)
      for (const button of await testConnectionButtons.all()) {
        await button.click()
        await expect(page.getByText(expectedEmail)).toBeVisible()
        await expect(page.getByText(expectedSiteUrl)).toBeVisible()
      }

      const sharedProfiles = await page.evaluate<
        Array<{ readonly providerId: string; readonly oauthProfileId: string }>
      >(`(async () => {
        const overview = await (await fetch("/api/v1/plugins/overview")).json()
        return Promise.all(overview.connections
          .filter(({ providerId }) => providerId === "jira" || providerId === "confluence")
          .map(async ({ pluginConnectionId, providerId }) => {
            const administration = await (await fetch(
              "/api/v1/plugins/" + pluginConnectionId + "/administration"
            )).json()
            return {
              oauthProfileId: administration.configuration.values.find(({ key }) => key === "oauthProfileId")?.value ?? "",
              providerId
            }
          }))
      })()`)
      expect(sharedProfiles.map(({ providerId }) => providerId).sort()).toEqual(["confluence", "jira"])
      expect(sharedProfiles[0]?.oauthProfileId).toBeTruthy()
      expect(sharedProfiles[0]?.oauthProfileId).toBe(sharedProfiles[1]?.oauthProfileId)
      const canonicalProfiles = Schema.decodeUnknownSync(
        AuthProfilesFileSchema
      )(JSON.parse((await readFile(join(configRoot, "atlassian", "control-center", "profiles.json"))).toString("utf8")))
      expect(canonicalProfiles.profiles).toHaveLength(1)
      expect(canonicalProfiles.profiles?.[0]?.id).toBe(sharedProfiles[0]?.oauthProfileId)
      const providerTokens = [
        canonicalProfiles.profiles[0]?.token.access_token,
        canonicalProfiles.profiles[0]?.token.refresh_token
      ]
      expect(providerTokens.every((token): token is string => token !== undefined && token.length > 20)).toBe(true)

      const browserSurface = await snapshotBrowserReadableSurface(page, await page.context().cookies())
      const database = await readFile(join(dataRoot, "control-center.db"))
      const sqlArtifacts = (await collectFiles(dataRoot, "secrets")).filter((content) => content !== database)
      const privateSecretFiles = await collectFiles(join(dataRoot, "secrets"))
      const outputArtifacts = await collectFiles("test-results/control-center/atlassian-oauth")
      const forbiddenValues = [clientSecret, ...providerTokens.filter((token): token is string => token !== undefined)]
      for (const secret of forbiddenValues) {
        expect(browserSurfaceExposesSecret(browserSurface, secret)).toBe(false)
        expect(database.includes(secret)).toBe(false)
        expect(sqlArtifacts.some((content) => content.includes(secret))).toBe(false)
        expect(outputArtifacts.some((content) => content.includes(secret))).toBe(false)
        expect(started.output.join("")).not.toContain(secret)
        expect(browserConsole.some((entry) => entry.includes(secret))).toBe(false)
      }
      const profileCredentials = await readJsonCredentialStrings(configRoot)
      expect(profileCredentials.length).toBeGreaterThan(0)
      for (const credential of profileCredentials) {
        expect(browserSurfaceExposesSecret(browserSurface, credential)).toBe(false)
        expect(database.includes(credential)).toBe(false)
        expect(sqlArtifacts.some((content) => content.includes(credential))).toBe(false)
        expect(outputArtifacts.some((content) => content.includes(credential))).toBe(false)
        expect(started.output.join("")).not.toContain(credential)
        expect(browserConsole.some((entry) => entry.includes(credential))).toBe(false)
      }
      for (const secret of privateSecretFiles) {
        if (secret.length < 20) continue
        expect(browserSurfaceExposesSecret(browserSurface, secret.toString("utf8"))).toBe(false)
        expect(database.includes(secret)).toBe(false)
        expect(sqlArtifacts.some((content) => content.includes(secret))).toBe(false)
        expect(outputArtifacts.some((content) => content.includes(secret))).toBe(false)
        expect(started.output.join("")).not.toContain(secret.toString("utf8"))
        expect(browserConsole.some((entry) => entry.includes(secret.toString("utf8")))).toBe(false)
      }
      expect(await dataRootContains(dataRoot, clientSecret)).toBe(false)
    } finally {
      if (server !== undefined) await stopServer(server)
      const cleanupFailures: Array<unknown> = []
      for (const root of temporaryRoots) {
        try {
          await rm(root, { force: true, recursive: true })
          await waitForRemoved(root)
        } catch (cause) {
          cleanupFailures.push(cause)
        }
      }
      if (cleanupFailures.length > 0) {
        cleanupFailure = new AggregateError(cleanupFailures, "Failed to clean up temporary roots")
      }
    }
    if (cleanupFailure !== undefined) throw cleanupFailure
  })
})
