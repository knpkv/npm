---
"@knpkv/control-center": minor
---

Rebuild the AWS account setup form to its design. The open form is one panel across CodeCommit and CodePipeline that spans the card row. Opening it scrolls it into view and moves focus to its heading.

- **Profile and region:** the profile is a select of the profiles detected on this machine, and the region is a select of the account's enabled regions, starting on the profile's own. A profile that can't list regions types one instead.
- **Errors:** a missing value is marked on its own field, with no banner. When an organization policy blocks CodeCommit and CodePipeline is denied too, the region field says the region may not be allowed. Per-service discovery failures are listed with a short label each.
- **Discovered resources:** they appear as checkbox grids with their counts, and a service that fails on refresh still lists the names already selected.
- **Following:** manual name entry starts closed, and the submit button counts the resources it will follow.
