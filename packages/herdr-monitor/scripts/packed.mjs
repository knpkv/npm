import { Schema } from "effect"
import assert from "node:assert/strict"
import { execFileSync, spawn } from "node:child_process"
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises"
import { createServer, get } from "node:http"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import process from "node:process"
import { test } from "node:test"
import { clearTimeout, setTimeout } from "node:timers"

const status = (url, headers = {}) =>
  new Promise((resolveStatus, reject) => {
    get(url, { headers }, (response) => {
      response.resume()
      resolveStatus(response.statusCode)
    }).on("error", reject)
  })
const root = resolve(import.meta.dirname, "..")
const temp = await mkdtemp(join(tmpdir(), "herdr monitor packed-"))
const publishToken = `publish_${"p".repeat(43)}`
const viewToken = `view_${"v".repeat(43)}`
const env = {
  ...process.env,
  MONITOR_PUBLISH_TOKEN: publishToken,
  MONITOR_VIEW_TOKEN: viewToken,
  MONITOR_BOARD: "main"
}
const run = (args, overrides = {}) =>
  new Promise((resolveResult, reject) => {
    const child = spawn(process.execPath, args, {
      cwd: temp,
      env: { ...env, ...overrides },
      stdio: ["ignore", "pipe", "pipe"]
    })
    let stdout = ""
    let stderr = ""
    const timeout = setTimeout(() => {
      child.kill()
      reject(new Error("Packed CLI timed out"))
    }, 12000)
    child.stdout.on("data", (value) => {
      stdout += value
    })
    child.stderr.on("data", (value) => {
      stderr += value
    })
    child.on("error", (error) => {
      clearTimeout(timeout)
      reject(error)
    })
    child.on("close", (code) => {
      clearTimeout(timeout)
      resolveResult({ code, stdout, stderr })
    })
  })

try {
  execFileSync("pnpm", ["pack", "--out", join(temp, "monitor.tgz")], { cwd: root, stdio: "pipe" })
  await mkdir(join(temp, "node_modules", "@knpkv"), { recursive: true })
  execFileSync("tar", ["-xzf", join(temp, "monitor.tgz"), "-C", temp])
  await symlink(join(temp, "package"), join(temp, "node_modules", "@knpkv", "herdr-monitor"))
  await symlink(join(root, "node_modules", "effect"), join(temp, "node_modules", "effect"))
  await mkdir(join(temp, "node_modules", "@effect"))
  await symlink(
    join(root, "node_modules", "@effect", "platform-node"),
    join(temp, "node_modules", "@effect", "platform-node")
  )
  const cli = join(temp, "package", "dist", "cli.js")
  const web = await readFile(join(temp, "package", "dist", "web", "board.js"), "utf8")
  const css = await readFile(join(temp, "package", "dist", "web", "board.css"), "utf8")
  await test("packed exports and browser bundle exclude upstream and publish authority", async () => {
    const result = await run([
      "--input-type=module",
      "-e",
      `import { Snapshot } from "@knpkv/herdr-monitor"; import { publish } from "@knpkv/herdr-monitor/publisher"; import { makeMonitor } from "@knpkv/herdr-monitor/server"; if (!Snapshot || !publish || !makeMonitor) throw new Error("Missing export")`
    ])
    assert.equal(result.code, 0, result.stderr)
    await writeFile(
      join(temp, "consumer.mts"),
      `import { Redacted } from "effect";
import { type Snapshot } from "@knpkv/herdr-monitor";
import { publish } from "@knpkv/herdr-monitor/publisher";
import { makeMonitor } from "@knpkv/herdr-monitor/server";
const snapshot: Snapshot = { version: 1, boardId: "main", sequence: 1, sourceAt: 0, title: "Synthetic", agents: [] };
const publication = publish("http://127.0.0.1:4319", Redacted.make("synthetic"), snapshot);
const monitor = makeMonitor({ boardId: "main", origin: "http://127.0.0.1:4319", publishToken: "synthetic", viewToken: "synthetic" }, { html: "", script: "", css: "" });
void [publication, monitor];`
    )
    execFileSync(
      process.execPath,
      [
        join(root, "node_modules", "typescript", "bin", "tsc6"),
        "--noEmit",
        "--strict",
        "--module",
        "NodeNext",
        "--target",
        "ES2022",
        "--skipLibCheck",
        "consumer.mts"
      ],
      { cwd: temp, stdio: "pipe" }
    )
    assert.doesNotMatch(
      web,
      /MONITOR_PUBLISH_TOKEN|publish_|herdr-connect|hostd|localStorage|sessionStorage|WebSocket|\.innerHTML/
    )
    assert.doesNotMatch(css, /url\(["']?\/(?!\/)/)
    const manifest = JSON.parse(await readFile(join(temp, "package", "package.json"), "utf8"))
    assert.deepEqual(Object.keys(manifest.dependencies).sort(), ["@effect/platform-node", "effect"])
    for (const entry of Object.values(manifest.exports)) await readFile(join(temp, "package", entry.types))
  })
  await test("packed CLI fails closed without leaking input paths or keys", async () => {
    const privatePath = join(temp, "sensitive-input.json")
    await writeFile(privatePath, "x".repeat(65537))
    const oversized = await run([cli, "publish", privatePath])
    await writeFile(privatePath, "{}")
    const malformed = await run([cli, "publish", privatePath])
    const invalid = await run([cli, "serve"], { MONITOR_PUBLISH_TOKEN: viewToken })
    for (const result of [oversized, malformed, invalid]) {
      assert.notEqual(result.code, 0)
      for (const secret of [privatePath, publishToken, viewToken]) {
        assert.ok(!(result.stdout + result.stderr).includes(secret))
      }
      assert.match(result.stderr, /Monitor failed/)
    }
  })
  await test("packed server remains listening after ready and restarts empty", async () => {
    const restartFile = join(temp, "restart.json")
    await writeFile(
      restartFile,
      JSON.stringify({
        version: 1,
        boardId: "main",
        sequence: 1,
        sourceAt: Date.now(),
        title: "Synthetic restart",
        agents: []
      })
    )
    // A new process must lose the old copy and accept explicit republication with a reset sequence.
    for (let lifetime = 0; lifetime < 2; lifetime++) {
      const child = spawn(process.execPath, [cli, "serve"], {
        cwd: temp,
        env: { ...env, MONITOR_PORT: "14319", MONITOR_ORIGIN: "http://127.0.0.1:14319" },
        stdio: ["ignore", "pipe", "pipe"]
      })
      const exited = new Promise((resolveExit) => child.once("close", resolveExit))
      try {
        await new Promise((resolveReady, reject) => {
          const timeout = setTimeout(() => reject(new Error("Monitor readiness timeout")), 10000)
          child.once("error", reject)
          child.once("exit", () => {
            clearTimeout(timeout)
            reject(new Error("Monitor exited before ready"))
          })
          child.stdout.on("data", (data) => {
            if (String(data).includes("Monitor ready")) {
              clearTimeout(timeout)
              resolveReady()
            }
          })
        })
        assert.equal(await status("http://127.0.0.1:14319/boards/main", { authorization: `Bearer ${viewToken}` }), 204)
        assert.equal(await status("http://127.0.0.1:14319/"), 200)
        const published = await run([cli, "publish", restartFile], { MONITOR_ORIGIN: "http://127.0.0.1:14319" })
        assert.equal(published.code, 0, published.stderr)
        assert.equal(await status("http://127.0.0.1:14319/boards/main", { authorization: `Bearer ${viewToken}` }), 200)
      } finally {
        child.kill()
        await exited
      }
    }
  })
  await test("packed CLI publishes successfully, rejects bad auth and unreachable destination", async () => {
    const server = createServer((req, res) => {
      req.resume()
      res.writeHead(req.headers.authorization === `Bearer ${publishToken}` ? 204 : 401)
      res.end()
    })
    try {
      await new Promise((resolveListening) => server.listen(0, "127.0.0.1", resolveListening))
      const address = Schema.decodeUnknownSync(Schema.Struct({ port: Schema.Number }))(server.address())
      const origin = `http://127.0.0.1:${address.port}`
      const file = join(temp, "valid.json")
      await writeFile(
        file,
        JSON.stringify({
          version: 1,
          boardId: "main",
          sequence: 1,
          sourceAt: Date.now(),
          title: "Synthetic",
          agents: []
        })
      )
      assert.equal((await run([cli, "publish", file], { MONITOR_ORIGIN: origin })).code, 0)
      const denied = await run([cli, "publish", file], {
        MONITOR_ORIGIN: origin,
        MONITOR_PUBLISH_TOKEN: `publish_${"z".repeat(43)}`
      })
      assert.notEqual(denied.code, 0)
      await new Promise((resolveClosed) => server.close(resolveClosed))
      const unreachable = await run([cli, "publish", file], { MONITOR_ORIGIN: origin })
      assert.notEqual(unreachable.code, 0)
      for (const result of [denied, unreachable]) {
        for (const secret of [file, publishToken, viewToken, origin]) {
          assert.ok(!(result.stdout + result.stderr).includes(secret))
        }
      }
    } finally {
      server.close()
    }
  })
} finally {
  await rm(temp, { recursive: true, force: true })
}
