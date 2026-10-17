---
"@knpkv/herdr-hub": patch
---

The Stacks overview no longer reports S3-backed stacks as unreadable. Their listing carries no resource count, which isn't a failure. Their resources now read "Not counted", and no stacks are named as unreadable. Source problems collapse to one line per cause, with what was skipped and how to fix it, for example "Sign-in expired for 8 AWS profiles, so their state buckets weren't read. Fix: run aws sso login for them on the stacks host." When nothing could be read, a single card names the cause and the fix.
