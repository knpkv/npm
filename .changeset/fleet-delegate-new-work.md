---
"@knpkv/herdr-fleet": minor
"@knpkv/herdr-hub": minor
---

Check explicit durable operation rejection before settling an unaccepted Fleet job, including on restart recovery. Store bounded cause-tagged errors for definitively uncommitted failures while preserving recovery for uncertain outcomes and accepted receipts.

Validate optional delegate `newWork` branches and goal titles, bind both fields into the approval hash, and show the proposed goal in approvals, the dashboard, and fleetctl output so approval covers the goal that delegation will create. Failed job and follow output retain the operation error.

Keep credential-redacted Unicode titles decodable at the length boundary, and escape terminal controls in shared fleetctl job, follow, and pending-submit output so untrusted fields cannot alter terminal presentation.
