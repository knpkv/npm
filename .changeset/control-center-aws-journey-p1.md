---
"@knpkv/control-center": minor
"@knpkv/codecommit-core": minor
---

AWS setup and source health say what went wrong and how to fix it:

- **Expired AWS sign-in:** discovery returns `AwsSignInRequiredApiError`. For an IAM Identity Center profile the form names the exact `aws sso login --profile` command to run; for other profiles it asks to renew the credentials in the AWS config.
- **Profile detection:** marks Identity Center profiles (`sso_session` or `sso_start_url`), and no longer lists `[sso-session …]` or `[services …]` sections as profiles.
- **Unknown profile:** a profile this machine doesn't have is refused before AWS is asked, with the detected profiles named.
- **Empty region:** a verified account with nothing in the region points at another region.
- **Configuration failures:** a missing repository is a new `configuration` failure class. It reads "Needs correction" with a sentence pointing at the connection, never "Sync again".
- **Overview Sources panel:** each source connection shows its own health (Healthy, Degraded, Unavailable, Disabled, Not checked) with its reason or check time. This replaces the sentence that called every enabled source connected. `PortfolioPresentation` gains `sources`.
