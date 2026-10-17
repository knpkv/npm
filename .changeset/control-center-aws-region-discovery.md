---
"@knpkv/control-center": minor
---

Add owner-only AWS region discovery: `POST /api/v1/plugins/discovery/aws-regions` lists the enabled regions of a local AWS profile's account through one read-only `account:ListRegions` call, so the setup form can offer them. Resource discovery also reports `regionDenied: true` when a service control policy denies the chosen region (both CodeCommit and CodePipeline refused with an SCP denial), so the form can name the region instead of two permission failures.
