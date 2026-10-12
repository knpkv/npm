import type { DatabaseSync } from "node:sqlite"

/** Both stores share posts and self-state so closure snapshots words and clears self-state atomically. */
export const initializePosts = (database: DatabaseSync): void => {
  database.exec(`
    CREATE TABLE IF NOT EXISTS connect_self_state (
      host TEXT COLLATE NOCASE NOT NULL, agent_id TEXT NOT NULL,
      state_json TEXT NOT NULL, tokens REAL NOT NULL, refilled_at INTEGER NOT NULL,
      PRIMARY KEY (host, agent_id)
    );
    CREATE TABLE IF NOT EXISTS connect_posts (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      host TEXT COLLATE NOCASE NOT NULL, agent_id TEXT NOT NULL, event_id TEXT NOT NULL,
      kind TEXT NOT NULL, text TEXT NOT NULL, goal_step TEXT, created_at INTEGER NOT NULL,
      UNIQUE (host, agent_id, event_id)
    );
    CREATE INDEX IF NOT EXISTS connect_posts_agent ON connect_posts (host, agent_id, sequence DESC);
    CREATE INDEX IF NOT EXISTS connect_posts_age ON connect_posts (created_at);
  `)
}
