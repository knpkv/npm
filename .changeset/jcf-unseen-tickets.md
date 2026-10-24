---
"@knpkv/jira-clockify": minor
---

Session transcripts are streamed by line, so a transcript larger than Node's maximum string length no longer fails the read as "invalid encoding". A ticket Jira answers 404 for (deleted, or in a project this account cannot read) no longer fails the whole read: its session time is reported on the new `jiraUnseen` report field and not offered as a proposal. A worklog POST that Jira refuses with 400, 404 or 413 is marked `refused` and releases its pending write intent, since nothing was written; ambiguous failures stay held for review. Jira read failures now name the status instead of a bare "Error".
