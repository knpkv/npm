---
"@knpkv/control-center": minor
---

Add owner-only AWS region discovery: `POST /api/v1/plugins/discovery/aws-regions` lists the enabled regions of a local AWS profile's account through one read-only `account:ListRegions` call, so the setup form can offer them; a profile without that action gets `{ _tag: "denied" }` rather than an outage. Resource discovery also reports `organizationPolicyDenied: true` when CodeCommit's denial names a service control policy and CodePipeline is denied too, so the form can say an organization policy blocks these services in the chosen region instead of showing two permission failures.
