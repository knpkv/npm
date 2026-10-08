---
"@knpkv/atlassian-common": patch
"@knpkv/jira-cli": patch
---

Failures that used to read as "nothing there" are now reported. A token or profile file whose existence cannot be checked fails with a FileSystemError instead of reading as signed out. A token the system refuses to delete fails the logout instead of reporting success; an already-deleted token still succeeds. An unreadable legacy auth file is skipped with a warning naming it. In jira-cli, a Jira user that cannot be read is still shown by account id, now with a warning naming them.
