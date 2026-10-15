---
"@knpkv/review": minor
"@knpkv/codecommit-web": minor
"@knpkv/herdr-hub": minor
---

Show recorded reviews and cached discussions on a full Code page with the PR header, checks and stacked pull-request diffs in the hub. Add read-only Review and Conversation views with severity groups, counted lower-priority disclosure, All/Findings/Comments index filters, stable thread links, retained-reading warnings and host-owned retries. Guide selections return to Review until a guide reader is available.

Persist completed owner reviews with their original revisions. Keep the completed result visible when history cannot be saved, distinguish absent and unreadable history, and preserve Explain output and P0–P4 findings. Add bounded workspace contracts and exported read-only views that preserve recorded provenance, disposition, requirements and deleted comments without inventing missing data.

Place findings only on matching revisions and verified diff lines; retain separate cards when placement is unavailable. Keep retry and rerun focus inside the workspace, preserve browser history and file selection, and announce accepted read completions without stealing focus.

Make Rly an optional peer of `@knpkv/review` instead of a runtime dependency, keeping headless contract installs free of the UI dependency tree. Consumers of the React controls, guide placement or guide exports must install `@knpkv/rly` explicitly alongside the React peers.
