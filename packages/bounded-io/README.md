# @knpkv/bounded-io

Byte-capped Effect streams. Read a child process's output or an HTTP body without letting it grow past a budget: the stream fails with `ByteLimitExceeded` on the chunk that crosses the limit, before anything past it is buffered.

```ts
import { collectBoundedText } from "@knpkv/bounded-io"

const stdout =
  yield *
  collectBoundedText(handle.stdout, 1024 * 1024).pipe(
    Effect.catchTag("ByteLimitExceeded", ({ limit, observedBytes }) =>
      Effect.fail(new MyOutputTooLarge({ limit, observedBytes }))
    )
  )
```

- `limitBytes(stream, limit)` passes chunks through and fails once the running total exceeds `limit`.
- `collectBounded(stream, limit)` collects into one `Uint8Array`.
- `collectBoundedText(stream, limit)` collects and decodes UTF-8 exactly like `Stream.decodeText` + `Stream.mkString`: invalid sequences become U+FFFD and a truncated sequence at the very end is dropped.

`limit` is inclusive: exactly `limit` bytes succeed. `observedBytes` is the running total at the chunk that crossed it. The package has no Node imports and runs in browsers.
