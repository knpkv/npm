---
"@knpkv/jira-clockify": minor
"@knpkv/jcf-web": minor
---

Allocate overlapping ticket credit into sequential blocks with the configured dwell floor, selecting the strongest tickets when fewer blocks fit. Keep actual active duration, idle gaps and standalone short work without inventing time. Reserve unplaced shares before scheduling known tickets so changing shares cannot fragment the calendar into sub-minute blocks.

Share proposed worklog selection, sizing and provider anchoring through one pure module so preview and confirmation cannot disagree.

Return exact written segments for partial provider outcomes and retain a stable source-block identity
when scheduling moves a block. JCF web uses those contracts to settle disjoint optimistic entries,
prevent corrected-ticket blocks from reappearing after a restart, reopen time removed by a saved-entry
duration edit or verified deletion, and share one machine writer guard with `jcf watch`. Corrected
session writes now retain their private provider-entry-ID binding across description edits and source
suffix removal; uncertain creates and unlinked earlier entries require manual recovery instead of an
automatic repeat.
