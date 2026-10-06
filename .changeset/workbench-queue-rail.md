---
"@knpkv/codecommit-web": minor
"@knpkv/codecommit-core": patch
---

Pull request pages now show the review queue beside the pull request in windows 800px and wider: what needs your review, what waits on a role pool you may be in, your own pull requests with the reason each is stuck, and what you are watching. The open pull request is marked, and arrow keys move through the list. Phones and 768px tablets keep the pull request alone.

Enter on a focused link or button on a pull request page now does only that, instead of also opening the AWS console.

The review count on the Pull requests tab, the review reminder, the pull request list's "needs my review" filter and the queue now count the same pull requests. A rule with no approval pool asks everyone but the author for review, and a pull request waiting only on a wildcard role pool is listed apart, not counted.

The live events stream no longer sends `pendingReviewCount`; the web client counts reviews itself. `AppState.pendingReviewCount` in codecommit-core is documented as unused by the web app.
