# Keep a durable per-machine usage store

Claude Code prunes its transcripts and Claude's subscription limits are observable only live, so usage cannot be recomputed from source files on demand the way session-counter does. Each Machine runs one long-lived `agent-usage serve` process that tails transcripts and rollouts through Ingest Cursors into a SQLite store and polls limits, and serves the UI from that store. Machines stay standalone in v1: every row names its Machine so a later cross-machine view needs no migration, but no data leaves the Machine.

## Considered Options

- On-demand recompute when the UI opens: loses pruned Claude history and every Limit Snapshot taken while closed.
- JSONL append log: cheap to write, but every graph becomes a full scan.
