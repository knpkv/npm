---
"@knpkv/herdr-hub": minor
---

The Sandboxes page signs the hub in to AWS: the owner presses Sign in to AWS, sees the code with a link to the sign-in page while it waits, and the page says until when it is signed in. A sign-in that ended says so, and spend readings show when they were last read. `AwsSignInState` and the aws-session answer's `SignInRequired` now carry `reason` (`never` or `ended`, remembered across a restart). The caller read gains `poolMode` and `awsSignedIn`, which tells anyone but the owner only whether the hub is signed in. Observe mode, and a live pool without a sign-in, now disable the jobs they would refuse up front, with one line under the heading saying why.
