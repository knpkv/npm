---
"@knpkv/codecommit-core": patch
---

A failed comment fetch no longer reads as "no comments". The bulk and the single refresh write nothing: the comment count stays as it was (not loaded until a fetch succeeds), the cached comments are kept, and nothing is announced. Before, a failure stored 0 comments, and the single refresh also replaced the comment cache with an empty set, so the next successful fetch re-announced every existing comment.
