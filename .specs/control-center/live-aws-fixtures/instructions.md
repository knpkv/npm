# Operator instructions

Use `infra/control-center-live-aws/bootstrap.sh` as the only normal deployment entry point. Select
the AWS account through `AWS_PROFILE` or the standard credential chain; never add access keys to
the script, repository, or GitHub environment.

After the stack deploys:

1. Copy the four printed non-secret values into the `control-center-live-integration` GitHub
   environment.
2. Configure that environment with a custom deployment branch policy for `main` only.
3. Verify the role trust policy still names the exact environment subject.
4. Verify the bootstrap's deployed-IAM attestation reports no managed attachment, extra inline
   policy, trust drift, or inline-document drift on either stack role.
5. Verify the live role has no CodeCommit or CodePipeline write action.
6. Verify the fixture pull request remains open with at least one difference.
7. Verify the pipeline retains at least one successful execution and action records.
8. After merging the exact revision to `main`, dispatch `control-center-live-aws-probe.yml` and
   record its successful GitHub Actions run URL. Do not treat local mocks, a branch run, or a run
   whose head SHA differs from the merged revision as closure evidence.

Do not merge or close the fixture pull request. If the source branch is changed accidentally,
restore it by deliberately recreating `fixture-change`; do not widen live-role permissions to
work around missing fixture data.
