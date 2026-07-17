# @knpkv/control-center-sql

Typed, dialect-specific SQL plans used by Control Center persistence.

The public boundary returns only rendered SQL and parameters. `effect-qb` plans,
tables, and types stay private so persistence repositories remain independent of
query-builder implementation details.

The first plan reads current readiness for a bounded set of releases in one
workspace-scoped query. It replaces portfolio N+1 reads while retaining Control
Center's Schema decoding, materialization verification, and quarantine boundary.

This package does not own database initialization or migrations. During the MVP,
Control Center uses one exact unstable schema snapshot; versioned migrations begin
only after that persistence model is stable and released databases need upgrades.
