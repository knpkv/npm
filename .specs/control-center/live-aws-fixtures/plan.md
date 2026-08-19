# Plan

1. Define the OIDC provider, read-only live role, stable provider resources, and pipeline service
   boundary in CloudFormation.
2. Add an idempotent bootstrap that deploys the stack and creates the stable pull request and
   pipeline execution.
3. Add a static contract with invalid fixtures and include it in the complete lint gate.
4. Deploy to the selected non-production account and verify IAM, CodeCommit, and CodePipeline
   behavior.
5. Create the protected GitHub environment, restrict it to `main`, and configure the four
   non-secret stack outputs.
6. Run repository checks and an exact-head review before merge.
7. Dispatch the protected AWS probe on merged `main` and retain the successful exact-head run URL.
