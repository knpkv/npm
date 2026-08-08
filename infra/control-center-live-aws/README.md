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

Supported role partitions are `aws` and `aws-us-gov`. aws-cn is intentionally rejected until the
workflow, provider client ID, and trust policy support the China STS audience.

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
