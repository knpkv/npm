import { expect, it } from "@effect/vitest"
import { Effect, type Schema } from "effect"
import { decodeResource } from "../src/state.js"

const row = (resourceType: string, attr: Schema.JsonObject, providerMode: Schema.Json = "live") =>
  JSON.stringify({
    fqn: "Api",
    logicalId: "Api",
    resourceType,
    status: "created",
    providerMode,
    attr,
    downstream: [],
    props: { accountId: "999999999999", region: "us-east-1", token: "fixture-secret" },
    old: { attr: { functionName: "fixture-secret" } },
    consoleUrl: "https://untrusted.example.com/fixture-secret"
  })

it.effect("selects validated own AWS identity and an encoded allowlisted console resolver, ignoring source-like extras", () =>
  Effect.gen(function*() {
    const arn = "arn:aws:lambda:eu-west-1:123456789012:function:storefront-prod-api"
    const resource = yield* decodeResource(
      row("AWS.Lambda.Function", { functionName: "storefront-prod-api", functionArn: arn })
    )
    expect(resource).toMatchObject({
      providerId: "storefront-prod-api",
      account: "123456789012",
      region: "eu-west-1",
      consoleUrl: `https://console.aws.amazon.com/go/view?arn=${encodeURIComponent(arn)}`,
      updatedAt: null,
      downstream: []
    })
    expect(JSON.stringify(resource)).not.toContain("fixture-secret")
    expect(JSON.stringify(resource)).not.toContain("999999999999")
  }))

it.effect("rejects unknown types, commercial partition mismatches, own-name conflicts and selected marker siblings", () =>
  Effect.gen(function*() {
    const attr = {
      functionName: "docs-preview-api",
      functionArn: "arn:aws:lambda:eu-west-1:123456789012:function:docs-preview-api"
    }
    for (
      const text of [
        row("Custom.Function", attr),
        row("AWS.Lambda.Function", { ...attr, functionName: "different-resource" }),
        row("AWS.Lambda.Function", { ...attr, functionArn: attr.functionArn.replace("arn:aws:", "arn:aws-cn:") }),
        row("AWS.Lambda.Function", {
          ...attr,
          functionArn: { __redacted__: "fixture-secret", sibling: attr.functionArn }
        }),
        row("AWS.Lambda.Function", { ...attr, __redacted__: "fixture-secret" }),
        row("AWS.Lambda.Function", attr, "local")
      ]
    ) {
      const resource = yield* decodeResource(text)
      expect(resource).toMatchObject({ providerId: null, account: null, region: null, consoleUrl: null })
      expect(JSON.stringify(resource)).not.toContain("fixture-secret")
    }
    expect((yield* decodeResource(row("AWS.Lambda.Function", attr, "unknown")))?.consoleUrl).toBeNull()
  }))

it.effect("S3 identity requires its own region/account and a matching bucket ARN, never backend routing context", () =>
  Effect.gen(function*() {
    const attr = { bucketName: "storefront-prod-assets", bucketArn: "arn:aws:s3:::storefront-prod-assets" }
    expect((yield* decodeResource(row("AWS.S3.Bucket", attr)))?.consoleUrl).toBeNull()
    const resource = yield* decodeResource(
      row("AWS.S3.Bucket", { ...attr, accountId: "123456789012", region: "eu-west-1" })
    )
    expect(resource).toMatchObject({ providerId: attr.bucketName, account: "123456789012", region: "eu-west-1" })
    expect(resource?.consoleUrl).toContain(encodeURIComponent(attr.bucketArn))
  }))

it.effect("Worker routes contain own account/name and exclude dispatch, parent-owned versions and local dev identities", () =>
  Effect.gen(function*() {
    const attr = {
      workerId: "11111111111111111111111111111111",
      workerName: "relay-dev-bot",
      accountId: "22222222222222222222222222222222"
    }
    const resource = yield* decodeResource(row("Cloudflare.Worker", attr))
    expect(resource).toMatchObject({
      providerId: attr.workerId,
      account: attr.accountId,
      region: null,
      consoleUrl: `https://dash.cloudflare.com/${attr.accountId}/workers/services/view/relay-dev-bot/production`
    })
    expect(resource?.consoleUrl).not.toContain(":account")
    for (
      const input of [
        { ...attr, namespace: "dispatch" },
        { ...attr, versionOf: "parent-worker" },
        { ...attr, workerId: "dev:relay-dev-bot" },
        { ...attr, accountId: { __redacted__: "fixture-secret", sibling: attr.accountId } }
      ]
    ) {
      expect((yield* decodeResource(row("Cloudflare.Worker", input)))?.consoleUrl).toBeNull()
    }
    expect((yield* decodeResource(row("Cloudflare.Workers.Worker", attr)))?.providerId).toBeNull()
  }))

it.effect("DNS own timestamp is strictly validated; DNS/R2 never invent a route or transport content/data", () =>
  Effect.gen(function*() {
    const attr = {
      recordId: "33333333333333333333333333333333",
      zoneId: "44444444444444444444444444444444",
      modifiedOn: "2026-10-11T13:42:00.000Z",
      content: "fixture-secret",
      data: { value: "fixture-secret" }
    }
    const resource = yield* decodeResource(row("Cloudflare.DNS.Record", attr))
    expect(resource).toMatchObject({
      providerId: attr.recordId,
      updatedAt: attr.modifiedOn,
      account: null,
      consoleUrl: null
    })
    expect(JSON.stringify(resource)).not.toContain("fixture-secret")
    for (const modifiedOn of ["2026-02-30T13:42:00.000Z", "yesterday", "2026-10-11"]) {
      expect((yield* decodeResource(row("Cloudflare.DNS.Record", { ...attr, modifiedOn })))?.updatedAt).toBeNull()
    }
    expect(
      yield* decodeResource(row("Cloudflare.R2.Bucket", {
        bucketName: "docs-preview-assets",
        accountId: "22222222222222222222222222222222",
        jurisdiction: "eu"
      }))
    ).toMatchObject({
      providerId: "docs-preview-assets",
      account: "22222222222222222222222222222222",
      consoleUrl: null
    })
  }))

/** Regression Q6: absent mode is legacy cloud, while explicit unsupported modes never authorize a provider link. */
it.effect("legacy cloud rows retain their own links without accepting invalid modes or dev identities", () =>
  Effect.gen(function*() {
    const cases = [
      {
        type: "AWS.Lambda.Function",
        attr: {
          functionName: "docs-preview-api",
          functionArn: "arn:aws:lambda:eu-west-1:123456789012:function:docs-preview-api"
        }
      },
      {
        type: "Cloudflare.Worker",
        attr: {
          workerId: "11111111111111111111111111111111",
          workerName: "relay-dev-bot",
          accountId: "22222222222222222222222222222222"
        }
      }
    ]
    for (const fixture of cases) {
      const live = yield* decodeResource(row(fixture.type, fixture.attr))
      const legacy = yield* decodeResource(
        JSON.stringify({
          fqn: "Api",
          logicalId: "Api",
          resourceType: fixture.type,
          status: "created",
          attr: fixture.attr,
          downstream: []
        })
      )
      expect(legacy?.consoleUrl).toBe(live?.consoleUrl)
      expect(legacy?.consoleUrl).not.toBeNull()
      for (const mode of ["local", "unknown", null, { __redacted__: "fixture-secret", sibling: "live" }]) {
        expect((yield* decodeResource(row(fixture.type, fixture.attr, mode)))?.consoleUrl).toBeNull()
      }
    }
  }))

/** Regression Q7: provider timestamps preserve their supported precision rather than requiring millisecond formatting. */
it.effect("DNS accepts complete UTC instants with variable precision and rejects invalid calendar/time fields", () =>
  Effect.gen(function*() {
    const attr = { recordId: "33333333333333333333333333333333", zoneId: "44444444444444444444444444444444" }
    for (
      const modifiedOn of [
        "2014-01-01T05:20:00.12345Z",
        "2014-01-01T05:20:00Z",
        "2014-01-01T05:20:00.1Z",
        "2014-01-01T05:20:00.123Z",
        "2014-01-01T05:20:00.123456Z"
      ]
    ) {
      expect((yield* decodeResource(row("Cloudflare.DNS.Record", { ...attr, modifiedOn })))?.updatedAt).toBe(modifiedOn)
    }
    for (
      const modifiedOn of [
        "2014-02-30T05:20:00Z",
        "2014-01-01T24:20:00Z",
        "2014-01-01T05:60:00Z",
        "2014-01-01T05:20:60Z",
        "2014-01-01",
        "2014-01-01T05:20:00+01:00",
        { __date__: "2014-01-01T05:20:00Z", sibling: "2014-01-01T05:20:00Z" }
      ]
    ) {
      expect((yield* decodeResource(row("Cloudflare.DNS.Record", { ...attr, modifiedOn })))?.updatedAt).toBeNull()
    }
  }))

/** Each enabled mapping names the actual beta.74/beta.77 attr fields and must produce an exact own-ARN resolver link. */
it.effect("all enabled AWS mappings validate their own provider fields", () =>
  Effect.gen(function*() {
    const fixtures = [
      {
        type: "AWS.Lambda.Function",
        attr: {
          functionName: "docs-preview-api",
          functionArn: "arn:aws:lambda:eu-west-1:123456789012:function:docs-preview-api"
        },
        arn: "arn:aws:lambda:eu-west-1:123456789012:function:docs-preview-api"
      },
      {
        type: "AWS.S3.Bucket",
        attr: {
          bucketName: "docs-preview-assets",
          bucketArn: "arn:aws:s3:::docs-preview-assets",
          accountId: "123456789012",
          region: "eu-west-1"
        },
        arn: "arn:aws:s3:::docs-preview-assets"
      },
      {
        type: "AWS.DynamoDB.Table",
        attr: { tableName: "sessions", tableArn: "arn:aws:dynamodb:eu-west-1:123456789012:table/sessions" },
        arn: "arn:aws:dynamodb:eu-west-1:123456789012:table/sessions"
      },
      {
        type: "AWS.SQS.Queue",
        attr: { queueName: "events", queueArn: "arn:aws:sqs:eu-west-1:123456789012:events" },
        arn: "arn:aws:sqs:eu-west-1:123456789012:events"
      },
      {
        type: "AWS.IAM.Role",
        attr: { roleName: "api-role", roleArn: "arn:aws:iam::123456789012:role/service/api-role" },
        arn: "arn:aws:iam::123456789012:role/service/api-role"
      },
      {
        type: "AWS.IAM.Policy",
        attr: { policyArn: "arn:aws:iam::123456789012:policy/api-policy" },
        arn: "arn:aws:iam::123456789012:policy/api-policy"
      },
      {
        type: "AWS.CloudFront.Distribution",
        attr: {
          distributionId: "E123SYNTHETIC",
          distributionArn: "arn:aws:cloudfront::123456789012:distribution/E123SYNTHETIC"
        },
        arn: "arn:aws:cloudfront::123456789012:distribution/E123SYNTHETIC"
      },
      {
        type: "AWS.Logs.LogGroup",
        attr: {
          logGroupName: "/aws/lambda/docs-preview-api",
          logGroupArn: "arn:aws:logs:eu-west-1:123456789012:log-group:/aws/lambda/docs-preview-api"
        },
        arn: "arn:aws:logs:eu-west-1:123456789012:log-group:/aws/lambda/docs-preview-api"
      },
      {
        type: "AWS.ACM.Certificate",
        attr: { certificateArn: "arn:aws:acm:eu-west-1:123456789012:certificate/11111111-1111-1111-1111-111111111111" },
        arn: "arn:aws:acm:eu-west-1:123456789012:certificate/11111111-1111-1111-1111-111111111111"
      },
      {
        type: "AWS.CloudWatch.Alarm",
        attr: { alarmName: "api-errors", alarmArn: "arn:aws:cloudwatch:eu-west-1:123456789012:alarm:api-errors" },
        arn: "arn:aws:cloudwatch:eu-west-1:123456789012:alarm:api-errors"
      },
      {
        type: "AWS.CloudWatch.Dashboard",
        attr: { dashboardName: "overview", dashboardArn: "arn:aws:cloudwatch::123456789012:dashboard/overview" },
        arn: "arn:aws:cloudwatch::123456789012:dashboard/overview"
      }
    ]
    for (const fixture of fixtures) {
      const resource = yield* decodeResource(row(fixture.type, fixture.attr))
      expect(resource?.consoleUrl).toBe(`https://console.aws.amazon.com/go/view?arn=${encodeURIComponent(fixture.arn)}`)
      expect(JSON.stringify(resource)).not.toContain("fixture-secret")
    }
  }))

/** Q9: provider-specific names remain exact own identities, including documented spaces, Unicode and log-group #. */
it.effect("alarm and log-group links accept documented own names without widening other AWS types", () =>
  Effect.gen(function*() {
    for (const name of ["High latency", "遅延警告", "Alarm:exact*name"]) {
      const arn = `arn:aws:cloudwatch:eu-west-1:123456789012:alarm:${name}`
      const resource = yield* decodeResource(row("AWS.CloudWatch.Alarm", { alarmName: name, alarmArn: arn }))
      expect(resource?.consoleUrl).toBe(`https://console.aws.amazon.com/go/view?arn=${encodeURIComponent(arn)}`)
    }
    const name = "/service/docs#preview"
    const arn = `arn:aws:logs:eu-west-1:123456789012:log-group:${name}`
    expect((yield* decodeResource(row("AWS.Logs.LogGroup", { logGroupName: name, logGroupArn: arn })))?.consoleUrl)
      .toBe(`https://console.aws.amazon.com/go/view?arn=${encodeURIComponent(arn)}`)
  }))

it.effect("alarm and log-group identity rejects controls, oversize, mismatches, markers and wildcard log ARNs", () =>
  Effect.gen(function*() {
    for (const name of ["", "a".repeat(256), "High\nlatency", "High\u007flatency", "\ud800"]) {
      expect(
        (yield* decodeResource(row("AWS.CloudWatch.Alarm", {
          alarmName: name,
          alarmArn: `arn:aws:cloudwatch:eu-west-1:123456789012:alarm:${name}`
        })))?.consoleUrl
      ).toBeNull()
    }
    const arn = "arn:aws:cloudwatch:eu-west-1:123456789012:alarm:High latency"
    for (const alarmName of ["Different latency", { __redacted__: "fixture-secret", sibling: "High latency" }]) {
      expect((yield* decodeResource(row("AWS.CloudWatch.Alarm", { alarmName, alarmArn: arn })))?.consoleUrl).toBeNull()
    }
    for (const name of ["", "a".repeat(513), "/service/docs:preview", "/service/docs*", "/service/docs\npreview"]) {
      expect(
        (yield* decodeResource(row("AWS.Logs.LogGroup", {
          logGroupName: name,
          logGroupArn: `arn:aws:logs:eu-west-1:123456789012:log-group:${name}`
        })))?.consoleUrl
      ).toBeNull()
    }
    expect(
      (yield* decodeResource(row("AWS.Logs.LogGroup", {
        logGroupName: "/service/docs#preview",
        logGroupArn: "arn:aws:logs:eu-west-1:123456789012:log-group:/service/docs#preview:*"
      })))?.consoleUrl
    ).toBeNull()
    expect(
      (yield* decodeResource(row("AWS.Lambda.Function", {
        functionName: "High latency",
        functionArn: "arn:aws:lambda:eu-west-1:123456789012:function:High latency"
      })))?.consoleUrl
    ).toBeNull()
  }))
