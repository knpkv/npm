# Replace the pre-stable review model without migration

The full agentic review replaces the existing bounded analyzer, review schema, persistence shape, and `Review exact head` flow directly. Control Center is pre-stable and local-first, so the implementation does not add compatibility adapters, migrations, or a legacy report UI; existing local review records may be discarded. This keeps the new domain model and agent runtime coherent and avoids preserving restrictions that the feature is explicitly replacing.
