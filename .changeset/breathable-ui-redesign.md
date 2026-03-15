---
"@knpkv/codecommit-web": minor
---

Breathable UI redesign: sidebar filters, rolling status, recent activity

- Card layout for PR rows with status dot badges, large health score, repo pill
- Structured rolling status in header (phase-based: cache→fetch→comments→diffs→health)
- Filter sidebar with mutually exclusive modes (Hot/All/Mine/Review), searchable combobox popovers, sortBy/groupBy query params
- Recent Activity right aside with clickable PR links, filtered to PR notifications only
- Full-width sidebar layout (left filters + main content + right activity)
