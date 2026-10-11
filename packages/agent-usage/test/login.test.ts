import { describe, expect, it } from "@effect/vitest"
import { Option, Schema } from "effect"
import { spawn, spawnSync } from "node:child_process"
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { createServer } from "node:net"
import { join } from "node:path"
import { LoginReplyInvalid, ServerNotRunning, SocketPathUnsafe, SocketRefused } from "../src/server/ControlSocket.js"
import { describeLoginFailure } from "../src/server/Login.js"

describe("login messages", () => {
  it("tells the owner what to do about each failure", () => {
    const notRunning = describeLoginFailure(new ServerNotRunning({ path: "/s" }))
    expect(notRunning).toContain("agent-usage serve")
    // A server from before login has no socket: say so rather than invite a second one.
    expect(notRunning).toContain("older version")
    expect(describeLoginFailure(new SocketPathUnsafe({ path: "/s", reason: "it is a symbolic link" })))
      .toContain("it is a symbolic link")
    expect(describeLoginFailure(new SocketRefused({ path: "/s", reason: "EACCES" }))).toContain("EACCES")
    expect(describeLoginFailure(new LoginReplyInvalid({ reply: "nope" }))).toContain("did not answer with a link")
  })
})

const main = join(import.meta.dirname, "..", "src", "main.ts")

const decodePort = Schema.decodeUnknownOption(Schema.Struct({ port: Schema.Number }))

const freePort = () =>
  new Promise<number>((resolve) => {
    const server = createServer()
    // ast-grep-ignore: no-released-ephemeral-test-port -- the spawned server takes PORT from its environment; follow-up: let it bind 0 and report its port.
    server.listen(0, "127.0.0.1", () => {
      const address = server.address()
      const port = Option.getOrElse(Option.map(decodePort(address), (bound) => bound.port), () => 0)
      server.close(() => resolve(port))
    })
  })

describe("agent-usage login against a running server", () => {
  it("serve starts with no terminal; login prints a fresh link each time; no server says so", async () => {
    // Under /tmp, not the inherited temp root, which can be too deep for a Unix socket path.
    const home = mkdtempSync("/tmp/au-")
    chmodSync(home, 0o700)
    const empty = mkdtempSync("/tmp/au-roots-")
    try {
      // Only what the process needs: an empty home, so no real transcripts or credentials are read.
      // A stand-in browser opener that, like xdg-open, starts the browser and returns at once.
      const bin = join(empty, "bin")
      mkdirSync(bin)
      const browserPid = join(empty, "browser.pid")
      for (const opener of ["xdg-open", "open"]) {
        writeFileSync(join(bin, opener), `#!/bin/sh\nsleep 30 &\necho $! > ${browserPid}\n`, { mode: 0o755 })
      }
      const env = {
        PATH: `${bin}:${process.env["PATH"] ?? ""}`,
        HOME: empty,
        USER: "agent-usage-test",
        AGENT_USAGE_HOME: join(home, "store"),
        PORT: String(await freePort())
      }
      const tsx = ["--import", "tsx", main]
      const login = () => spawnSync(process.execPath, [...tsx, "login"], { env, encoding: "utf8" })
      // stdin from /dev/null and output to pipes: no TTY anywhere, as under systemd or launchd.
      const server = spawn(process.execPath, [...tsx, "serve"], { env, stdio: ["ignore", "pipe", "pipe"] })
      try {
        const startup = await new Promise<string>((resolve, reject) => {
          let out = ""
          server.stdout.on("data", (chunk: Buffer) => {
            out += chunk.toString()
            const line = /agent usage: (\S+)/u.exec(out)
            if (line?.[1] !== undefined) resolve(line[1])
          })
          server.on("exit", (code) => reject(new Error(`serve exited with ${code}`)))
        })
        expect(startup).toContain("#bootstrap_token=")
        const first = login()
        const second = login()
        expect(first.status).toBe(0)
        expect(second.status).toBe(0)
        expect(first.stdout.trim()).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/#bootstrap_token=/u)
        expect(second.stdout.trim()).not.toBe(first.stdout.trim())
        // The root reuses this listener, ignores start-only port settings, and exits.
        const reused = spawnSync(process.execPath, [...tsx, "--no-open", "--port", "1"], {
          env: { ...env, PORT: "not-a-port" },
          encoding: "utf8",
          timeout: 10_000
        })
        expect(reused.status).toBe(0)
        expect(reused.stdout.split("\n")[0]).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/#bootstrap_token=/u)
        expect(reused.stdout).toContain("Not opening a browser (--no-open)")
        expect(reused.stdout).not.toContain("agent usage:")
        expect(reused.stderr).toBe("")
        expect(server.exitCode).toBeNull()
        expect(server.signalCode).toBeNull()
        // --open hands the link to the opener, and the browser it started outlives login.
        const opened = spawnSync(process.execPath, [...tsx, "login", "--open"], { env, encoding: "utf8" })
        expect(opened.status).toBe(0)
        const browser = Number(readFileSync(browserPid, "utf8").trim())
        expect(() => process.kill(browser, 0)).not.toThrow()
        process.kill(browser, "SIGTERM")
        // A second server on the same store refuses to start, on another port or on the same one.
        for (const port of [String(await freePort()), env.PORT]) {
          const rival = spawnSync(process.execPath, [...tsx, "serve"], {
            env: { ...env, PORT: port },
            encoding: "utf8",
            timeout: 20_000
          })
          expect(rival.status).not.toBe(0)
          expect(`${rival.stdout}${rival.stderr}`).toContain("already running")
        }
      } finally {
        // It may have exited already, failing to start: then there is no exit event left to wait for.
        if (server.exitCode === null && server.signalCode === null) {
          const exited = new Promise((resolve) => server.once("exit", resolve))
          server.kill("SIGTERM")
          await exited
        }
      }
      const after = spawnSync(process.execPath, [...tsx, "login"], { env, encoding: "utf8" })
      expect(after.status).not.toBe(0)
      expect(after.stderr).toContain("agent-usage serve")
      expect(after.stdout).toBe("")
      // The root starts a foreground listener when there is none; its flag outranks PORT.
      const port = await freePort()
      const started = spawn(process.execPath, [...tsx, "--no-open", "--port", String(port)], {
        env: { ...env, PORT: "not-a-port" },
        stdio: ["ignore", "pipe", "pipe"]
      })
      try {
        const startup = await new Promise<string>((resolve, reject) => {
          let out = ""
          started.stdout.on("data", (chunk: Buffer) => {
            out += chunk.toString()
            if (out.includes("Not opening a browser (--no-open); open the link above.\n")) resolve(out)
          })
          started.on("exit", (code) => reject(new Error(`root exited before readiness with ${code}`)))
        })
        const lines = startup.trim().split("\n")
        expect(lines).toHaveLength(2)
        expect(lines[0]).toMatch(new RegExp(`^http://127\\.0\\.0\\.1:${port}/#bootstrap_token=`))
        expect(lines[1]).toBe("Not opening a browser (--no-open); open the link above.")
        expect(started.exitCode).toBeNull()
        expect(started.signalCode).toBeNull()
      } finally {
        if (started.exitCode === null && started.signalCode === null) {
          const exited = new Promise((resolve) => started.once("exit", resolve))
          started.kill("SIGTERM")
          await exited
        }
      }
      const stopped = login()
      expect(stopped.status).not.toBe(0)
      expect(stopped.stdout).toBe("")
      expect(stopped.stderr).toContain("agent-usage serve")
      // An unsafe path is a refusal, never permission to start another listener.
      writeFileSync(join(env.AGENT_USAGE_HOME, "serve.sock"), "not a socket", { mode: 0o600 })
      const refused = spawnSync(process.execPath, [...tsx, "--no-open"], { env, encoding: "utf8", timeout: 10_000 })
      expect(refused.status).not.toBe(0)
      expect(refused.stdout).toBe("")
      expect(refused.stderr).toContain("not a socket")
      // A configuration it cannot read is a failure like any other: stderr only.
      const { HOME: _home, ...withoutHome } = env
      const broken = spawnSync(process.execPath, [...tsx, "login"], { env: withoutHome, encoding: "utf8" })
      expect(broken.status).not.toBe(0)
      expect(broken.stdout).toBe("")
      expect(broken.stderr).toContain("agent-usage")
      const brokenRoot = spawnSync(process.execPath, [...tsx, "--no-open"], { env: withoutHome, encoding: "utf8" })
      expect(brokenRoot.status).not.toBe(0)
      expect(brokenRoot.stdout).toBe("")
      expect(brokenRoot.stderr).toContain("its configuration could not be read")
    } finally {
      rmSync(home, { recursive: true, force: true })
      rmSync(empty, { recursive: true, force: true })
    }
  }, 60_000)
})
