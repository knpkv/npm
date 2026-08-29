# Own managed review in Control Center

Control Center is the only owner of durable pull-request review state. The web UI and CodeCommit TUI may present the same Review Thread through its local authenticated API; when Control Center is unavailable, the TUI may offer a clearly labeled Relay-only Review whose state is non-durable and never merges silently into the managed history. This removes three incompatible definitions of a review while retaining an explicit offline escape hatch.
