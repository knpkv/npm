---
"@knpkv/codecommit-web": minor
"@knpkv/codecommit": patch
---

Relay in CodeCommit web can read a pull request's changed files at its current revision (`get_pull_request_diff`) and post a comment on one line (`post_line_comment`). A line comment is pinned to the revision it was written against: it is refused if the pull request has moved on, or if the line is outside the changes. The person confirms the exact file, side, line, revision and text first.
