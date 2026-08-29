# Control Center live AWS fixtures

This directory defines the persistent, non-production AWS fixtures used by the protected Control
Center live integration workflow. CloudFormation owns the IAM trust and permissions, CodeCommit
repository, CodePipeline pipeline, and encrypted artifact bucket. `bootstrap.sh` deploys the stack,
seeds one stable open pull request with a small diff, and leaves a successful pipeline execution
with source and approval action history.

The live-test role can be assumed only by `knpkv/npm` through the
`control-center-live-integration` GitHub environment. Its session can identify itself, list
CodeCommit repositories and CodePipeline pipelines, and read only the fixture repository and
pipeline. It has no provider write actions. The pipeline has a separate service role limited to
reading the fixture repository and using its private artifact bucket.

## Deploy or reconcile

Authenticate an administrator in the selected non-production account, then run:

```sh
AWS_PROFILE=dev-administratoraccess \
CONTROL_CENTER_LIVE_AWS_REGION=eu-central-1 \
./infra/control-center-live-aws/bootstrap.sh
```

The bootstrap reuses an account-level GitHub Actions OIDC provider when one already exists.
Otherwise, the CloudFormation stack creates it. The final four lines are the non-secret GitHub
environment variables required by the live integration and AWS-only probe workflows:

- `CONTROL_CENTER_TEST_AWS_ROLE_ARN`
- `CONTROL_CENTER_TEST_AWS_REGION`
- `CONTROL_CENTER_TEST_CODECOMMIT_REPOSITORY`
- `CONTROL_CENTER_TEST_CODEPIPELINE_PIPELINE`

Configure them on the `control-center-live-integration` GitHub environment. That environment must
use a custom deployment branch policy allowing only `main`; the IAM subject claim and environment
policy then enforce both the repository and protected execution boundary. Do not configure
long-lived AWS access keys.

### Fixture-coordinate boundary

The security boundary is coordinate-specific. The role ARN is persisted as an owner-visible GitHub
environment variable. Repository and environment administrators may read that durable protected
configuration; at workflow runtime `CONTROL_CENTER_TEST_AWS_ROLE_ARN` remains server-private, and
its permitted authenticated exposure is limited to GitHub environment configuration, protected
role assumption, and server-side account comparison. `CONTROL_CENTER_TEST_AWS_REGION`,
`CONTROL_CENTER_TEST_CODECOMMIT_REPOSITORY`, and
`CONTROL_CENTER_TEST_CODEPIPELINE_PIPELINE` are owner-visible fixture coordinates; their
persistence is allowed only as safe adapter settings, and their permitted authenticated exposure is
owner configuration and discovery. Forbidden surfaces for all four coordinates are logs, workflow
artifacts, and public responses; the role ARN is additionally forbidden from Control Center
authenticated API responses and every client-facing or normalized payload.

The protected OIDC probe supports role partitions `aws` and `aws-us-gov`. aws-cn is intentionally
rejected until the workflow, provider client ID, and trust policy support the China STS audience.
The local disposable PR-review evaluation below also supports `aws-cn` when its profile, region,
stack role, and CodeCommit repository all belong to that partition.

## Verify

Run the local static contract before deployment:

```sh
pnpm lint:live-aws
aws cloudformation validate-template \
  --region eu-central-1 \
  --template-body file://infra/control-center-live-aws/template.json
```

After deployment, inspect the stack outputs and rerun `bootstrap.sh`. A repeat run must report the
same fixture coordinates, retain an open pull request with a non-empty diff, and observe existing
successful pipeline action history without widening IAM policy. Every bootstrap run also reads the
two deployed role trust policies, managed-policy attachments, inline-policy inventories, and inline
documents. It fails closed on any operator-authored IAM drift before touching fixture data.

After the change is on `main`, manually dispatch `control-center-live-aws-probe.yml` from `main`.
An unprivileged job builds a checksummed runner before any AWS authority is available. The protected
job verifies that runner, proves GitHub OIDC role assumption and the bounded CLI reads, then invokes
the production Control Center CodeCommit and CodePipeline clients with profile `default`. Both
clients must resolve the expected STS account and read the stable pull request, exact diff,
pipeline, successful execution, and successful source/approval action history. The probe does not
depend on Atlassian configuration and emits no account identifier or raw provider payload.

The artifact bucket is private, encrypted, versioned, TLS-only, and expires each current artifact
after one day plus its noncurrent version after six more days, bounding total retention to seven
days. CloudFormation retains the bucket during stack deletion to avoid an implicit destructive
cleanup; remove it only through a deliberate operator procedure.

## Disposable PR-review evaluation

`pr-review-eval.sh` creates a unique pull request against `main` with one intentional
retry/idempotency defect. It writes the repository, branch, head, pull-request ID, and
partition-correct browser URL only to a mode-`0600` recovery journal beneath the current user's
mode-`0700` state directory. The absolute dedicated recovery root defaults to
`${XDG_STATE_HOME:-$HOME/.local/state}/control-center/pr-review-eval`; override it with
`CONTROL_CENTER_PR_REVIEW_RECOVERY_ROOT`. Before writing, it verifies that the current AWS account,
CloudFormation stack output, stack-owned repository ID, CodeCommit repository name, and repository
ARN agree. `RECOVERY <journal>` is printed before the first resource mutation; `READY <journal>` is
printed after the pull request is usable. The script stays alive while the fixture is in use; type
`stop` or terminate it to close the pull request and then delete the branch. Branch deletion uses
Git's exact-head force-with-lease transaction; a concurrent push fails cleanup and leaves the branch
and journal intact. The push runs from a private temporary bare repository beneath the recovery
state directory with inherited Git environment, repository, global, and system configuration
disabled, preventing URL rewrites or credential-helper substitution. Its credential helper clears
ambient static, session, web-identity, and region authority before selecting the requested profile;
container and instance-metadata sources remain available to profiles configured to use them.
Successful cleanup removes the temporary repository and journal. Incomplete cleanup reports the
failed stage without exposing provider stderr and keeps the journal. Cleanup is registered before
the first AWS resource is created and records ownership after each successful mutation. This
fixture does not inspect or modify CodePipeline and remains usable when that pipeline has drifted.
It requires Git, the AWS CLI, `jq`, and `uuidgen`. The selected profile needs CloudFormation
`DescribeStacks`/`DescribeStackResource`, STS `GetCallerIdentity`, and CodeCommit `GetRepository`,
`GetBranch`, `CreateBranch`, `PutFile`, `ListPullRequests`, `GetPullRequest`, `CreatePullRequest`,
`UpdatePullRequestStatus`, and `GitPush`; the last action authorizes conditional branch deletion.

```sh
AWS_PROFILE=dev-administratoraccess \
CONTROL_CENTER_LIVE_AWS_REGION=eu-central-1 \
./infra/control-center-live-aws/pr-review-eval.sh
```

After a process or host loss, rerun cleanup with the same profile and region:

```sh
AWS_PROFILE=dev-administratoraccess \
CONTROL_CENTER_LIVE_AWS_REGION=eu-central-1 \
./infra/control-center-live-aws/pr-review-eval.sh recover /path/from/the/RECOVERY/line/fixture.json
```

Recovery accepts only a private journal directly beneath the configured recovery root, re-verifies
the stack/account/repository boundary, and matches the exact tokenized pull request. The branch is
deleted only by a Git force-with-lease operation conditioned on the journaled head, so a change
between the preceding read and deletion cannot remove an unverified commit. Recovery reconciles an
uncertain pull-request create only when exactly one matching open pull request exists. It never
deletes an uncertain branch; inspect that retained journal and the provider state manually.

If the terminal output was lost, inspect the configured recovery root for a private
`*/fixture.json` journal. Do not move or copy a journal outside that root before recovery.

Expected evaluation result: a correctness finding that the idempotency key is regenerated inside
the retry loop, which can charge the same request more than once after an ambiguous provider
failure. The durable prevention is a focused test asserting every attempt receives the same key.
