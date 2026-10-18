---
"@knpkv/alchemy-console": minor
---

Overview discovery stops the local project walk after 5 seconds or 50,000 directories and keeps the projects already found. `discoverProjects` now returns `truncated` with those projects. A stopped walk reports one `local: limit` issue and still reads the projects it found. AWS profiles are read three at a time. Each profile has its own deadline, and a profile that misses it is one `s3: provider` issue without dropping stacks from the profiles that finished. Two profile names for the same account, role, start URL, session and region are read once. SSO resolution leaves the session token cache in use.
