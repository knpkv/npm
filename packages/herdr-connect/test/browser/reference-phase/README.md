# Paused orbit references

These four native `2i` frames replace the old unknown-phase comparison references
for 390/1280, light/dark. The orbit is paused at 0 ms before capture. The same
animation object, paused state, current time and target rectangle are checked
before and after the shot. Screenshot `animations: "allow"` preserves that phase.
`capturePinnedReference` retains an uncertain PNG for diagnosis when evidence
drifts; it does not approve a comparison from that PNG.

`references.json` pins the adopted PNGs, source document and renderer contract.
The PNGs retain their native dimensions and complete figure contents. Adoption
sets the comparison reference; it does not establish production pixel equality.
The former unknown-phase bytes remain historical evidence and are no longer the
comparison oracle for these cells.

The four `2i-v4` goals-board cells remain `Unmapped` in
[#896](https://github.com/knpkv/npm/issues/896). An ordinary agent stage or a
`2i-v5` frame cannot substitute for them. This change therefore references #896
and leaves it open.
