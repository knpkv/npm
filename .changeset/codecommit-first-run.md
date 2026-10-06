---
"@knpkv/codecommit-core": minor
"@knpkv/codecommit-web": minor
---

A first run of the CodeCommit web app now leads somewhere at every step.

- The page shows whether its live stream is connecting, not signed in (the browser has no session: open the sign-in link `codecommit web` printed), failing (with the cause and "Retry now"), or live. Counts read as unknown, never 0, until the first update arrives. A lost stream no longer looks like an empty queue.
- An empty queue says why: no AWS profiles yet (with "Set up accounts"), filters hiding cached pull requests, or nothing open.
- Settings → Accounts with no profiles shows where profiles are read from, the `aws configure` commands that create one, and "Detect again", which reports what it found. It never edits AWS files.
- Settings → Config says a missing config file means defaults are in use.
- Error notifications name what failed, the provider's own error and the fix ("Couldn't list pull requests in dev (eu-central-1): ExpiredTokenException: … Sign in again in Settings → Accounts.") instead of "getPullRequests — AwsApiError".
- `@knpkv/codecommit-core`: AWS profile detection follows `AWS_CONFIG_FILE` and `AWS_SHARED_CREDENTIALS_FILE` like the AWS CLI. New exports: `ConfigService.awsProfileSources`, `awsProfileSourcesIn`, `AwsProfileSources`, and `Errors.describeAwsClientError`.
- A read the app hasn't been allowed yet asks in a bar at the top of the page instead of a blocking dialog; "Allow every read" grants every read operation in one saved step, and the queue says it is waiting for that answer. Writes still ask in a dialog, now with "Allow once" as the default. `@knpkv/codecommit-core`: `PermissionService.setCategory` sets a whole category in one atomic write and fails with `ConfigError` when it can't save.
- Settings → Accounts lists each profile as a switch named by the profile, and auto-detect is a checkbox. A settings or stats read that fails stays in its region with the reason (and Retry for stats) instead of replacing the page.
- `codecommit web` prints the sign-in link on its own, saying it works once within 60 seconds.
- Approval rules this page created can be removed.
