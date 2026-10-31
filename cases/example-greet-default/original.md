greet() returned 'Hello, undefined!' when called with no name. It now falls back to 'world' for missing or blank names.

Added a test for both cases; `bun test` passes locally.
