# Expected guided review

An illustrative PR, not a review of this repository. The patch is a readable excerpt; fixture helpers and existing approval types are omitted. Usage figures are synthetic and explicitly labeled.

Open the generated guide in both **Change guide** and **Review**. The explanatory side traces before/after behavior and module ownership. The review side explains each defect's trigger, code path, consequence, and fix. Both lead to the same diffs and line anchors.

Generate this example with `pnpm example:guide` from `packages/review`. The output is `example-guide.html`.

Use backticks for identifiers and exact values, such as `requestedRevision` and
`Rejected`. Keep intent and decisions in ordinary prose. Each finding separates
the trigger, a short value trace, the consequence, and a numbered fix. This makes
the example readable without requiring the reader to reconstruct the call path
from the diff alone.
