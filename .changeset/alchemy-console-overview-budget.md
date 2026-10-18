---
"@knpkv/alchemy-console": minor
---

Overview discovery stops the local project walk after 5 seconds or 50,000 directories and keeps the projects already found. The walk checks that clock before each directory entry, so one wide directory stops on the same budget. `discoverProjects` now returns `truncated` with those projects. A stopped walk reports one `local: truncated` issue and still reads the projects it found. A state file past its size limit stays `local: limit`. The walk and every AWS profile share one 20 second deadline. Profiles are read three at a time. A profile holds its slot for at most 8 seconds, and only while time remains in that deadline. A profile that has not finished is one `s3: provider` issue. Stacks from profiles that finished stay. Two profile names for the same account, role, start URL, session and region are read once. SSO resolution leaves the session token cache in use.
