# `@knpkv/herdr-coordinator`

Persistent chat contracts over the Herdr fleet job protocol.

Ask mode submits an `agent.delegate` consult job. Work mode submits a locally authorized work job and therefore follows the fleet approval policy. Chat turns persist beside their job IDs and history derives current state from the owning host's durable job record. The browser-facing history contains the newest 32 turns in chronological order; older turns remain durable and addressable by job ID.

Coordinator output is newline-delimited `herdr.coordinator.child.v1` lifecycle events. Both events carry the exact fleet job ID and request ID. A `started` event with the exact sanitized worker identity must arrive before the matching `completed` event. Root coordinator identities omit `relationship` and are valid only for coordinator-handled consult or chat jobs. Delegated child identities carry their exact `parentAgentId` and `relation`; ordinary work without that relationship is rejected. Missing, malformed, duplicate, reordered, job-mismatched, or request-mismatched events fail with named lifecycle errors. Terminal transcripts are never accepted as chat replies. Chat history exposes the same persisted worker and canonical Connect target after restart.

Browser-safe schemas are exported from `@knpkv/herdr-coordinator/model`.
