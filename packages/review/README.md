# @knpkv/review

Provider-neutral review contracts, pure browser runtime transitions, and controlled review UI.

The package owns exact thread identity, complete execution-profile selection, and retained-result presentation. Product adapters keep authentication, CSRF, provider execution, governance, publication, and persistence local.

```ts
import { presentReviewResult, resolveReviewProfile } from "@knpkv/review"
import { ReviewProfileControl, ReviewResultStatus } from "@knpkv/review/react"
```
