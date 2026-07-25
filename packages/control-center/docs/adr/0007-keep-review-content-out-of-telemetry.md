# Keep review content out of telemetry

OpenTelemetry records operational metadata for agent review—opaque run and pull-request identifiers, reviewed revision, provider and model, phase, command name, duration, exit status, suggestion counts, and error types. It does not record prompts, source snippets, model output, command output, credentials, or suggested replacement content. Traces correlate to the locally retained review record through run identifiers, keeping observability useful without exporting project content.
