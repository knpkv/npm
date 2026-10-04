import { describe, expect, it } from "@effect/vitest"
import { Option, Schema } from "effect"
import { spawn, spawnSync } from "node:child_process"
import { chmodSync, mkdtempSync, rmSync } from "node:fs"
import { createServer } from "node:net"
import { join } from "node:path"
import { LoginReplyInvalid, ServerNotRunning, SocketPathUnsafe, SocketRefused } from "../src/server/ControlSocket.js"
import { describeLoginFailure, openerFor } from "../src/server/Login.js"

describe("login messages", () => {
  it("tells the owner what to do about each failure", () => {
    expect(describeLoginFailure(new ServerNotRunning({ path: "/s" }))).toContain("agent-usage serve")
    expect(describeLoginFailure(new SocketPathUnsafe({ path: "/s", reason: "it is a symbolic link" })))
      .toContain("it is a symbolic link")
    expect(describeLoginFailure(new SocketRefused({ path: "/s", reason: "EACCES" }))).toContain("EACCES")
    expect(describeLoginFailure(new LoginReplyInvalid({ reply: "nope" }))).toContain("did not answer with a link")
  })

  it("opens links with the platform's opener, and nowhere else", () => {
    expect(openerFor("linux")).toBe("xdg-open")
    expect(openerFor("darwin")).toBe("open")
    expect(openerFor("win32")).toBeUndefined()
  })
})

const main = join(import.meta.dirname, "..", "src", "main.ts")

const decodePort = Schema.decodeUnknownOption(Schema.Struct({ port: Schema.Number }))

const freePort = () =>
  new Promise<number>((resolve) => {
    const server = createServer()
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
      const env = {
        PATH: process.env["PATH"] ?? "",
        HOME: empty,
        USER: "agent-usage-test",
        AGENT_USAGE_HOME: join(home, "store"),
        PORT: String(await freePort())
      }
      const tsx = ["--import", "tsx", main]
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
        const login = () => spawnSync(process.execPath, [...tsx, "login"], { env, encoding: "utf8" })
        const first = login()
        const second = login()
        expect(first.status).toBe(0)
        expect(second.status).toBe(0)
        expect(first.stdout.trim()).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/#bootstrap_token=/u)
        expect(second.stdout.trim()).not.toBe(first.stdout.trim())
        // A second server on the same store refuses to start.
        const rival = spawnSync(process.execPath, [...tsx, "serve"], {
          env: { ...env, PORT: String(await freePort()) },
          encoding: "utf8",
          timeout: 20_000
        })
        expect(rival.status).not.toBe(0)
        expect(`${rival.stdout}${rival.stderr}`).toContain("already running")
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
      // A configuration it cannot read is a failure like any other: stderr only.
      const { HOME: _home, ...withoutHome } = env
      const broken = spawnSync(process.execPath, [...tsx, "login"], { env: withoutHome, encoding: "utf8" })
      expect(broken.status).not.toBe(0)
      expect(broken.stdout).toBe("")
      expect(broken.stderr).toContain("agent-usage")
    } finally {
      rmSync(home, { recursive: true, force: true })
      rmSync(empty, { recursive: true, force: true })
    }
  }, 60_000)
})
