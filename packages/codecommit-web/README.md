# CodeCommit web

The browser view of the CodeCommit review queue: pull requests that need a decision, their diffs and
approvers, Relay reviews, and sandboxes.

## Start it

You need [Bun](https://bun.sh) 1.3 or later and an AWS CLI profile that can read CodeCommit.

1. Create a profile if you don't have one: `aws configure sso` (or `aws configure --profile NAME` for keys).
   Profiles are read from `~/.aws/config` and `~/.aws/credentials`, or from `AWS_CONFIG_FILE` and
   `AWS_SHARED_CREDENTIALS_FILE` when those are set. The app never edits these files.
2. Run `codecommit web`. It prints one sign-in link and opens it; the link works once, within 60 seconds.
   Lost it? Run the command again for a new one.
3. The first screen says what's missing, if anything: "No AWS profiles yet" links to Settings → Accounts,
   which shows where it looked, the commands that create a profile, and "Detect again".

Settings live in `~/.codecommit/config.json`. Until the first setting is saved there is no file and the
defaults apply.

## AWS calls ask first

Every AWS call is gated. A fresh install asks before each one (`~/.codecommit/permissions.json` starts
empty). Reads (listing pull requests, approval status, your identity) ask in a bar at the top of the page,
where "Allow every read" grants the whole read category in one saved step. Writes (creating pull requests,
posting comments, changing approval rules) ask in a dialog with "Allow once" as the default; "Always
allow" there covers only that one operation. Settings → Permissions shows and resets every grant.

## Pairing boundary

CodeCommit web owns an ephemeral, process-scoped owner session. Each bind rotates
the owner, CSRF, and bootstrap credentials; the bootstrap credential is valid for
60 seconds, single-use, and limited to five failed unauthenticated attempts. The
owner cookie is HttpOnly and SameSite=Strict. This intentionally differs from
Control Center's durable workspace session (12-hour idle and 30-day absolute
lifetimes). The policy is the shared single-operator Owner Session from
`@knpkv/browser-pairing/owner-session` (ADR-0008); CodeCommit web keeps its API
middleware, wire errors, `cc_owner` cookie name, and dev-proxy model.

Origin checks use the configured loopback authority captured at bind time. The
request `Host` header is not an authority source. Browser reads that Fetch
Metadata marks as cross-site, or as same-site/`none` without the bound Origin,
are refused; explicit clients without Fetch Metadata still need the owner
cookie.
