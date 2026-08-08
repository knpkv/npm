# Requirements

## Goal

Provision reproducible, least-privilege AWS fixtures for Control Center's opt-in live provider
journey without storing long-lived AWS credentials in GitHub.

## Functional requirements

- Use a selected non-production AWS account in one explicit region.
- Trust GitHub Actions OIDC only for `knpkv/npm` executions in the
  `control-center-live-integration` environment.
- Expose a temporary read-only role through the standard AWS credential chain.
- Prove the Control Center production CodeCommit and CodePipeline clients resolve that role through
  profile `default` and return the role ARN's exact AWS account.
- Keep one CodeCommit repository with an open pull request and a non-empty stable diff.
- Keep one CodePipeline pipeline with bounded source and approval action history.
- Publish the role ARN, region, repository name, and pipeline name as stack outputs while preserving
  their distinct exposure boundaries.
- Permit the live journey's STS, CodeCommit, and CodePipeline read operations and no provider
  mutations.

## Operational requirements

- Define infrastructure as reviewable CloudFormation and reconcile fixture data idempotently.
- Reuse the account's GitHub OIDC provider when present.
- Protect the GitHub environment with a `main`-only deployment branch policy.
- Encrypt and block public access to pipeline artifacts, require TLS, and expire artifacts after
  seven days.
- Retain the artifact bucket on stack deletion so teardown cannot silently destroy stored objects.
- Reject policy widening, broad OIDC subjects, resource wildcards on fixture reads, source polling,
  and public bucket settings through a repository check.
- Attest the deployed roles after every stack reconciliation and fail on trust drift, managed
  attachments, extra inline policies, or inline-document drift.
- Build the executable probe runner without AWS authority, checksum it, and run only that sealed
  artifact in the protected environment.
- Require a successful protected `main` workflow run at the merged head SHA as closure evidence.

## Fixture-coordinate boundary

The four coordinates are not interchangeable merely because none is a credential:

| Coordinate                                  | Security boundary                                                               | Persistence                                | Permitted authenticated exposure                                                                                       | Forbidden surfaces                                                           |
| ------------------------------------------- | ------------------------------------------------------------------------------- | ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| `CONTROL_CENTER_TEST_AWS_ROLE_ARN`          | Owner-visible protected environment setting; server-private at workflow runtime | Persisted as a GitHub environment variable | Authenticated GitHub environment configuration, protected workflow role assumption, and server-side account comparison | Logs, workflow artifacts, public responses, and Control Center API responses |
| `CONTROL_CENTER_TEST_AWS_REGION`            | Owner-visible fixture coordinate                                                | May be persisted in safe adapter settings  | Authenticated owner configuration and discovery                                                                        | Logs, workflow artifacts, and public responses                               |
| `CONTROL_CENTER_TEST_CODECOMMIT_REPOSITORY` | Owner-visible fixture coordinate                                                | May be persisted in safe adapter settings  | Authenticated owner configuration and discovery                                                                        | Logs, workflow artifacts, and public responses                               |
| `CONTROL_CENTER_TEST_CODEPIPELINE_PIPELINE` | Owner-visible fixture coordinate                                                | May be persisted in safe adapter settings  | Authenticated owner configuration and discovery                                                                        | Logs, workflow artifacts, and public responses                               |

The role ARN is persisted as an owner-visible GitHub environment variable. GitHub repository and
environment administrators may read that durable configuration, while workflow execution keeps it
server-private and forbids it from Control Center responses.

Supported role partitions are `aws` and `aws-us-gov`. aws-cn is intentionally rejected until the
workflow, provider client ID, and trust policy support the China STS audience.
