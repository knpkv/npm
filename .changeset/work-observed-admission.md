---
"@knpkv/herdr-work": minor
---

`admitObserved` admits a worker the reconciler observed, without an approval: the same write as `admitExistingOwner`, checked against the same absence token, with `observedAdmission` provenance on the binding (actor `reconciler` and the observation id) in place of an approval. Its admission activity is credited to the reconciler, and the goal can still be closed by the reconciler when its pull request merges or closes.
