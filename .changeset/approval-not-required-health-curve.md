---
"@knpkv/codecommit-core": minor
"@knpkv/codecommit-web": minor
"@knpkv/codecommit": minor
---

Approval and health now read honestly on real queues.

- `approvalOf` gains `NotRequired`, labelled "No approval required" (`approvalNotRequiredLabel`): CodeCommit evaluates a pull request with no approval rules as approved, though nobody signed off. "Approved" now appears only when rules exist and are satisfied. The CLI flags, TUI badge, web row, detail page and health score all show it. Status filters and counts treat it as neither approved nor pending.
- No "Approval granted" or "revoked" notification is sent for a pull request without rules. An identical pull-request notification that is still unread is not added again, so a restart no longer re-announces it.
- The cache records whether a pull request's approval baseline is known (migration 0024). A sign-off or withdrawal made while approval evaluation was failing is announced once evaluation recovers. A pull request first seen while evaluation fails holds only a placeholder, so its recovery is not announced.
- The health score uses a saturating curve: a base of 8, minus up to 6 for idleness and up to 2 for age, plus up to 1.5 for comments (3 counted), 2 for an approval and 1 for "No approval required". Long-idle pull requests are now ranked instead of all reading 0.0, and fresh ones stay green. A pull request CodeCommit gave no dates for scores Unknown ("Health —") and sorts last; comments that haven't loaded make the score a lower bound.
