# Large-book vector index benchmark

This benchmark compares the legacy JSON representation with the SQLite + Float32 BLOB format introduced in Margin 0.2.0.

## Scenario

- 2,000 chunks, approximating a 1,000-page book at two chunks per page
- 2,560 dimensions per vector, matching the built-in Qwen3-Embedding-4B provider
- Identical chunk text and vector values for both formats
- Windows x64, Node.js 24.16.0, Intel Core i5-14600KF

Run it again with:

```powershell
npm run benchmark:index
# Optional: npm run benchmark:index -- 4000 2560
```

## Result (re-run for 0.2.8 on 2026-09-08)

| Metric | Legacy JSON | SQLite Float32 | Change |
| --- | ---: | ---: | ---: |
| File size | 99.23 MB | 24.68 MB | **75.1% smaller** |
| Fresh write | 471 ms | 140 ms | **3.4× faster** |
| Top-5 scan search | N/A | 29 ms | Bounded-memory streaming scan |
| One-time legacy migration | N/A | 423 ms | Produces the same 24.68 MB database |

The old path also expanded every Float32 value into a JavaScript number, serialized the entire index into one JSON string, and kept both representations alive during persistence. The new desktop path embeds a small batch, transfers Float32 arrays, commits that batch to SQLite, and releases it before continuing. Reopening a book reads only index metadata; search iterates BLOB rows and retains only the best matches.

Peak process RSS during this intentionally in-memory comparison was 571 MB. Production indexing does not retain the synthetic JSON and SQLite representations together, so this number is a conservative test-harness observation rather than an application target.

These numbers are a repeatable synthetic comparison rather than a promise for every machine. Embedding inference and OCR usually dominate total indexing time; their throughput depends on document content, CPU/GPU, OCR language, and model backend. Version 0.2.8 exposes those stages separately in the task center so a slow scanned book can be diagnosed without guessing from total progress alone.
