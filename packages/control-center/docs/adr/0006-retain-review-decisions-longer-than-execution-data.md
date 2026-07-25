# Retain review decisions longer than execution data

Review Thread messages, Review Suggestions, Review Notes, lifecycle transitions, and remote publication links remain local until the Local Operator deletes them. Sanitized command timelines and Review Evidence excerpts are retained for 30 days, while full raw command output is retained for 7 days. The Review Sandbox filesystem is destroyed immediately when its run ends. This preserves durable review decisions and auditability without accumulating complete project copies or indefinite execution logs.
