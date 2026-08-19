# Design

## Trust boundary

GitHub's OIDC token is accepted only when its audience is `sts.amazonaws.com` and its subject is
`repo:knpkv/npm:environment:control-center-live-integration`. The GitHub environment separately
allows only `main`. This keeps pull-request code outside the authority-bearing job even though the
repository is public.

The assumed role separates account-wide list operations, which AWS requires to use `Resource: *`,
from repository- and pipeline-specific reads. The latter resolve their exact CloudFormation
resource ARNs. STS identity is the only other wildcard resource operation.

## Stable provider material

The CodeCommit repository has:

- `main`, containing `fixture.txt`;
- `fixture-change`, containing a small deterministic edit;
- one open pull request from `fixture-change` to `main`.

The V1 CodePipeline pipeline reads `main` without polling and pauses at manual approval. The
bootstrap approves the first execution and retains its source and approval action history. No
build or deployment provider is involved.

Pipeline artifacts use a dedicated private S3 bucket with S3-managed encryption, versioning,
ownership enforcement, TLS-only access, public-access blocking, and seven-day lifecycle expiry.
The pipeline service role can read only the fixture repository and use only that bucket.

## Prevention

`scripts/check-control-center-live-aws.mjs` is the durable configuration guardrail. It validates
the exact trust subject, read-only action families, required wildcard exceptions, fixture resource
scoping, absence of managed or auxiliary role-policy attachments, exact pipeline-role trust,
non-polling source, approval action, bucket ownership/lifecycle controls, and separation of the
unprivileged build from the protected probe. Its embedded negative fixtures prove that one write
action, a broad subject, an attachment path, a resource wildcard, polling, or weakened bucket
control is rejected while the checked-in template remains valid. Shell fixtures exercise bootstrap
interruption/reconciliation, attest the deployed IAM trust and attachment surfaces, and reject a
malformed role ARN, wrong STS account, unrelated pull request, or failed-only pipeline history.
