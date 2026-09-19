# @knpkv/herdr-monitor

A read-only browser board for explicitly published agent status. Works at tablet and phone widths. The terminal session decides what to publish. The browser never reads the terminal session.

```
Trusted session → explicit publisher → isolated monitor memory ← authenticated viewer
```

The publisher accepts a sanitized JSON file. It does not discover agents, read repositories, associate Jira tickets or fetch Clockify time. Work/Fleet contracts currently provide no Jira/Clockify association to reuse. Unknown fields stay `null`. A `clockify` duration must come from an explicitly associated Clockify observation; `elapsedSeconds` is separate and must never be presented as logged time.

## Run

Requires Node 26+. Build from this workspace with `pnpm --filter @knpkv/rly build` then `pnpm --filter @knpkv/herdr-monitor build`. The npm package includes the built browser assets.

Provide configuration through your deployment's secret manager or a private process environment. Do not put keys in command arguments or URLs. Generate two independent random 32-byte base64url values, without padding. Prefix the publishing value with `publish_` and the viewing value with `view_`. The server rejects wrong prefixes, lengths, or equal random values.

| Variable                | Meaning                                                   |
| ----------------------- | --------------------------------------------------------- |
| `MONITOR_PUBLISH_TOKEN` | Publish-only board key, server and trusted publisher only |
| `MONITOR_VIEW_TOKEN`    | View-only board key, server and viewer only               |
| `MONITOR_BOARD`         | Board identifier, default `main`                          |
| `MONITOR_ORIGIN`        | Exact browser origin, default `http://127.0.0.1:4319`     |
| `MONITOR_BIND`          | Listener address, default `127.0.0.1`                     |
| `MONITOR_PORT`          | Listener port, default `4319`                             |

Run `herdr-monitor serve` in the isolated monitor environment. On the trusted publishing side run `herdr-monitor publish sanitized.json`. `herdr-monitor demo` publishes three synthetic agents using the same authenticated endpoint. It never reads live session data. Each successful command prints only a short acknowledgment; failures exit nonzero with a generic diagnostic.

The origin must be a valid canonical URL origin. Invalid ports and noncanonical spellings fail startup. Use `https://monitor.example`, without an explicit default `:443` port; nondefault ports such as `:8443` are supported.

Open the configured origin and enter the board identifier and view key. The page polls the monitor every ten seconds. The key lives only in page memory, is cleared from the input after submission and is forgotten on Lock or page exit. No application cookies, local storage or session storage are used. Browser password managers and extensions remain outside this guarantee.

## Snapshot contract

Import `Snapshot` and `decodeSnapshot` from `@knpkv/herdr-monitor`. Import the Effect `publish` function separately from `@knpkv/herdr-monitor/publisher`; the function owns a scoped Node HTTP transport.

A complete file looks like this. Replace the example source timestamp with the actual observation time in Unix milliseconds before publication.

```json
{
  "version": 1,
  "boardId": "main",
  "sequence": 1,
  "sourceAt": 1790000000000,
  "title": "Main session",
  "agents": [
    {
      "id": "builder",
      "name": "Builder",
      "task": "Tablet board",
      "state": "working",
      "status": "Running focused tests",
      "blocker": null,
      "jiraKey": null,
      "branch": "feat/herdr-monitor",
      "pullRequest": null,
      "clockify": null,
      "elapsedSeconds": 120
    }
  ]
}
```

Agent states are `working`, `blocked`, `idle`, `done`, and `unknown`. `clockify`, when known, is `{ "source": "clockify", "seconds": 120, "observedAt": 1790000000000 }`. The explicit observation timestamp is required. PR and branch fields are plain display labels. Version 1 deliberately accepts no URL fields or clickable links, including Connect links. All displayed strings use text nodes, never executable HTML.

## Guarantees and limits

- One board per process, two independent board-scoped keys. View authority cannot publish. Publish authority cannot read status. Successful publication returns an empty 204 response. Unauthenticated requests receive only the static locked application, never status.
- Exact Host and Origin checks, no CORS, no arbitrary routes, no proxy, no transcript/log endpoints. Publication rejects browser Origin and Fetch Metadata mode headers. Authentication remains required even on a private network.
- Maximum 64 KiB request bodies, 64 unique agents, bounded identifiers and text, one accepted publication per second, separate 60-request-per-second public and viewer budgets and a 10-request-per-second authenticated publisher budget, five-second request processing timeout and bounded HTTP headers. A reverse proxy must additionally bound connections and slow clients for hostile deployments.
- Every update must increase the sequence. Same-sequence retries and changed same-sequence payloads both return 409. Out-of-order publication cannot replace newer state. Coordinate multiple publishers outside this package.
- Source time must be within the last five minutes and no more than 30 seconds in the future. Clockify observation time cannot exceed source time or the server's future allowance. Freshness uses trusted server receipt time, never source time. Status becomes stale after one minute.
- Only the latest snapshot is retained in memory. Reads remove it after 15 minutes; the scoped cleanup loop removes unread expired data within another 30 seconds. The sequence high-water mark remains until restart. No snapshot history or disk persistence.
- Restart loses both status and sequence history. The viewer shows no published data until a new explicit publication. An old sequence may be accepted after restart if its source time still passes validation. This is not durable anti-replay storage. Rotate keys on restart if replay across process lifetimes is unacceptable.
- Publisher transport is ordinary bidirectional HTTP. It has a five-second timeout, follows no redirects and does not consume response bodies, trace HTTP headers, execute instructions or retry. An attacker-controlled response can still delay or reject a publication. This is not a physical data diode.
- Schema validation cannot recognize a secret pasted into an allowed status string. The trusted publisher is responsible for sanitization. Never publish raw provider credentials, private paths, transcript fragments or sensitive task details.

## Private iPad deployment

The loopback default is for local development. For iPad access, deploy on a private host with authenticated HTTPS and an exact `MONITOR_ORIGIN`. Use a TLS reverse proxy that preserves the original Host, strips untrusted forwarded headers, rejects other origins, disables request/authorization/body logging, disables caching and limits connections. Keep both monitor credentials independently managed. Enter only the view key on the iPad. No public endpoint, firewall change, Tailscale ACL or persistent service is installed by this package.

The monitor process must have no Herdr socket, checkout, terminal descriptors, hostd access, Jira/Clockify credentials or agent-provider credentials. Deploy under a separate OS identity/container with no host sockets or shared mounts and deny outbound network access, including localhost, LAN and metadata services. A same-user process on the session host is **not isolated** merely because application imports are restricted: filesystem access, inherited environment, process inspection and loopback services may bridge privileges. Private networking alone does not enforce this boundary. The trusted publisher runs separately and only knows the monitor destination and publish key. The browser receives only the published copy.

The server's startup filesystem access loads three fixed packaged web assets. The request handler receives those strings and has no filesystem or HTTP-client service dependency. No Herdr, Fleet, Work, Connect, hostd, Jira, Clockify or agent-provider package is a runtime dependency.

Desktop Chromium viewport validation is not physical iPad testing. The completed acceptance and independent security review are recorded in `test/acceptance.md` in the repository.
