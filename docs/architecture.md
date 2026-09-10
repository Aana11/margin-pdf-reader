# Architecture

Margin is a local-first Electron PDF reader. It separates untrusted document rendering from filesystem, OCR, model-sidecar, and index responsibilities while keeping every local operation behind a narrow preload API.

## Runtime boundaries

- **Electron main process:** owns the managed library, `margin://` file protocol, Tesseract worker, vector and reading-workspace SQLite databases, logs, downloads, Markdown export, and llama.cpp sidecar. It never receives chat or remote-embedding API keys.
- **Sandboxed renderer:** owns PDF.js rendering, text extraction, page virtualization, UI state, chat orchestration, and embedding-provider requests. `nodeIntegration` is disabled; context isolation and sandboxing are enabled.
- **Model providers:** small interfaces isolate OpenAI-compatible chat/embedding services and the built-in Qwen embedding sidecar.

External navigation opens in the system browser. Filesystem access is restricted to validated IPC operations and app-owned book IDs.

## Large-file PDF path

For a real disk file, the preload obtains its native path through Electron `webUtils` and sends only that path to the main process. The main process validates the absolute path, size, and `%PDF-` signature, then copies it directly into the managed library. Byte-transfer IPC remains only as a fallback for programmatically constructed `File` objects and tests.

An opened book is exposed as `margin://app/library/<book-id>/document.pdf`. Electron serves this local resource through its network stack, so PDF.js can fetch it without first loading the complete file into a renderer `ArrayBuffer`. Page canvases are windowed and released after leaving the viewport margin.

## OCR and RAG pipeline

1. A persistent renderer-side task queue opens managed books through `margin://` and processes one book at a time without changing the document shown in the reader. Jobs survive renderer restarts as paused tasks and resume from the SQLite checkpoint.
2. PDF.js extracts selectable text with an adaptive two-to-eight-page concurrency window while preserving page order.
3. Pages with no text or only a small footer/page number are rasterized to a capped offscreen canvas. A downscaled luminance sample rejects near-blank pages before PNG encoding or OCR.
4. A bounded pool of one to four Tesseract.js workers (selected from logical processor count and installed memory) recognizes simplified Chinese plus English, traditional Chinese plus English, or English. Language data ships with the application; no OCR image leaves the machine. Along with structured text, the worker returns bounded line regions, confidence and pixel-space bounding boxes for layout-aware storage. A failed page is retried once and then recorded in the task.
5. Text is normalized and split into overlapping, page-addressable chunks.
6. The selected embedding provider generates vectors in bounded batches (8 for Vulkan Qwen, adaptive 1–4 for CPU Qwen, 16 for remote providers).
7. Completed vectors are transferred as `Float32Array` and accumulated into SQLite transactions of at most 64 entries.
8. Single-book search streams rows from SQLite, computes cosine similarity, and retains only the best K matches.
9. Cross-book search first resolves one user-selected knowledge pack, validates the query-level book/page filters as a subset of that pack, and computes the query vector once. It shards eligible indexes over at most four worker threads, applies page bounds inside SQLite, and merges per-book candidates into a global Top-K carrying book and page identity.
10. When optional GLM-OCR deep reading is enabled, both single-book and cross-book reading classify retrieved text for formulas, code, tables, or an explicit deep-reading request. Margin opens the exact source PDF, rasterizes at most two unique candidates, and sends them to the configured GLM-OCR endpoint.
11. The current page or user-selected knowledge-pack matches and successful visual-recognition results are sent to the configured chat model only after the user asks a question.
12. Explicit region reading crops the already-rendered page canvas, caps the longest edge at 1,800 pixels, and sends only that JPEG region to GLM-OCR before task-specific chat processing.
13. A manual OCR task can refresh an explicit page interval, including pages with an existing PDF text layer. Optional formula refinement sends at most 12 selected pages through GLM-OCR and stores its structured result while retaining Tesseract coordinates.
14. Searchable-PDF export loads the original managed PDF, overlays invisible Unicode text at saved OCR line coordinates, and writes a new user-selected file. It never mutates the managed original.

Automatic Tesseract OCR runs only when PDF.js finds no meaningful text layer and the page-density preflight indicates visible content. Manual range tasks can explicitly override that classifier. OCR output is used for assistant context and retrieval and may be exported into a separate searchable PDF; Margin never writes back into the source PDF.

## Optional GLM-OCR deep reading

GLM-OCR is a query-time precision layer, not a replacement for the embedding index. Vector search first supplies semantically relevant, page-addressable candidates. A deterministic classifier then chooses the official `Formula Recognition:`, `Table Recognition:`, or `Text Recognition:` task. User phrases such as “精读”, “公式”, “代码”, or “表格” explicitly request the same path.

GLM requests cross the context-isolated preload bridge and execute in the Electron main process, avoiding renderer CORS restrictions. The default managed mode uses llama.cpp's multimodal `/v1/chat/completions` endpoint; legacy Ollama mode follows `/api/generate`, while vLLM, SGLang, and remote providers use multimodal `/chat/completions`. The feature is disabled by default, sends at most two JPEG page images per question, runs sequentially, and caches results by book/page/task/provider/endpoint/model for the current session. A recognition error is logged with an actionable service/runtime/model diagnosis and degrades to ordinary RAG instead of failing the chat request.

GLM-OCR weights are not packaged by Margin. Managed mode downloads checksum-pinned `GLM-OCR-Q8_0.gguf` and `mmproj-GLM-OCR-Q8_0.gguf`, reuses the pinned llama.cpp CPU/Vulkan runtime, and starts a loopback-only sidecar on a random port. Downloads resume from partial files; the sidecar exits after five idle minutes or explicit unload. Starting GLM-OCR stops the embedding sidecar and vice versa so both large models do not compete for GPU memory. On startup, complete files in the stable Margin data root are auto-associated for legacy profiles that never chose a GLM mode; an explicit off setting remains authoritative. Existing Ollama and OpenAI-compatible services remain optional advanced providers and are never terminated by managed mode.

Managed vision inference caps image tokens at 2,048, uses a single slot and bounded physical batches, and chooses projector placement from detected GPU memory. GPUs below 10 GB keep the multimodal projector on CPU while retaining decoder layers on the selected backend. If a higher-memory Vulkan device still exhausts currently available VRAM, the main process identifies the sidecar's out-of-memory exit instead of treating the resulting connection reset as a remote-network failure, restarts in CPU-projector mode, and retries the recognition once. Status probing reports model weights and the shared runtime independently, logs inspected paths and byte counts, and ignores stale installation errors once complete assets are found; a missing or outdated runtime therefore requests repair without claiming that the GLM weights disappeared.

Manual region reading is independent of vector-index state. The renderer stores a normalized page rectangle plus a single in-memory crop, dispatches formula/table/text recognition according to the selected action, and caches recognition by SHA-256 + task + provider identity. Chat history stores the normalized rectangle but never the image bytes. Citation buttons restore the page and overlay exactly from these normalized coordinates.

The same normalized rectangle can be persisted without model inference as a highlight, annotation, or glossary source. Completed assistant output can be persisted as a summary card. These records and per-book messages live in the global `workspace.sqlite`; queries use bounded limits/offsets, so opening the app does not deserialize every historical conversation. A one-time renderer migration copies legacy `margin-chat-history-v1` records into SQLite and removes the old payload only after every known book succeeds.

Workspace schema version 4 also stores optional assistant reasoning, quoted-answer follow-ups, research items, and spaced-repetition study cards. Research rows are scoped to one book or knowledge pack and contain a question, evidence record, or generated outline plus bounded source metadata. Study cards retain a concept/formula/question type, front/back text, source metadata, due time, interval, ease, repetitions, and lapse count. Review scheduling is updated transactionally in SQLite and book cleanup removes its owned cards. These records support local search, source-page navigation, and Markdown export. Reasoning is presentation metadata: it is streamed separately from the final answer, remains user-collapsible, and is excluded from later chat prompts.

Selecting text inside an assistant answer creates a bounded quote attached to the next user message. The renderer sends the quote as material to verify alongside fresh page or retrieval context; it does not treat the previous answer as authoritative. Quote text is persisted separately from the user's question so the conversation can render and reload it without changing search semantics.

## Index storage

Each completed book index is stored beside the managed PDF as `index.sqlite`. Metadata records the schema version, provider identity, vector dimensions, completion state, and timestamps. Chunk rows contain page, ordinal, text, norm, and a little-endian Float32 BLOB.

Builds write to `index.sqlite.building` and replace the previous database only after a successful commit and close. The building database contains page-text checkpoints (including whether text came from PDF.js or OCR), optional bounded OCR layout JSON, and completed vector rows. Pause, process exit, and recoverable failure close but retain this database; the next compatible run resumes missing pages/chunks. Explicit cancellation removes only the building file through a separate IPC operation, preserving any previous complete index. A completed index also retains page text and layout so changing only the vector provider can reuse compatible OCR work. A version-1 `index.json` is migrated on first open; the JSON source is deleted only after the SQLite replacement succeeds.

Provider identity remains an invariant: an index opens only when its embedding provider/model/version matches the current selection. Search stays in the main process so the renderer does not deserialize or retain every vector. Measured results and the reproducible command are in [`index-benchmark.md`](index-benchmark.md).

## Cross-book knowledge packs

Knowledge packs are relational metadata in `workspace.sqlite`: `knowledge_packs` stores the user-visible folder and `knowledge_pack_books` stores its ordered book IDs. This avoids duplicating PDFs or vector BLOBs, permits one book to belong to several packs, and lets book deletion remove memberships transactionally without deleting the remaining pack.

The renderer computes one query embedding and invokes a narrow `knowledge:search` bridge with the selected pack ID. The main process resolves membership against the current catalog and rejects filter IDs outside the pack, so renderer-supplied IDs cannot widen scope. Eligible books are split over up to four `knowledge-search-worker.cjs` workers. Page bounds are included in each SQLite query before vector scanning; worker results are merged into one global Top-K. Every result carries `bookId`, `bookName`, `page`, score, and text; the assistant persists a bounded source list beside its message for later page navigation.

Knowledge-pack export is a versioned JSON manifest containing only the pack name, description, and book identity hints. Import matches current-library IDs first and then a unique normalized filename. It never embeds PDFs, indexes, model files, credentials, or chat history; unmatched books remain explicit in the import result.

No all-library fallback exists. Empty packs fail with an actionable message, removed books disappear from memberships, and provider-incompatible indexes are returned as skipped diagnostics. Exact per-book SQLite remains the compatibility path; ANN will be considered only after real pack sizes justify its additional native dependency and migration cost.

## Embedding providers

The built-in provider uses `Qwen/Qwen3-Embedding-4B`, produces 2560-dimensional embeddings, and runs the official Q4_K_M GGUF through a pinned llama.cpp sidecar bound only to `127.0.0.1`. The same pinned runtime also supports managed GLM-OCR. The main process selects a Vulkan runtime when an NVIDIA GPU is detected and otherwise uses CPU; `MARGIN_RUNTIME_BACKEND` can override it. Vulkan embedding runs eight parallel slots with a larger token batch, while CPU remains at four slots to avoid thread oversubscription. The embedding sidecar exits after two idle minutes or an explicit unload request.

The model and llama.cpp runtime are optional downloaded resources rather than Git-tracked blobs. Downloads are resumable, checksum-verified, and stored below the Margin data root. The remote provider follows the OpenAI-compatible `/embeddings` contract; document chunks leave the machine only when the user selects that mode.

## Local state and privacy

The managed PDF, catalog metadata, progress, OCR-derived index text, SQLite vectors, chat history, source citations, knowledge-pack membership, highlights, annotations, summary cards, glossary entries, and research items remain below the local Margin data root. Chat history, knowledge packs, reading materials, reasoning, and research items use `workspace.sqlite`; chat is capped to the latest 100 messages per book or pack in the active context, while history and material searches use bounded result pages. Model settings and the custom prompt are mirrored atomically to `preferences.json` as well as Electron browser storage so protocol/profile changes do not lose the selected local-model association. The last book ID, page in catalog, and split ratio restore the previous reading workspace. Removing a book also removes its workspace rows and knowledge-pack memberships.

Chat and embedding credentials are separate because users may choose different vendors. They are stored in the Electron browser profile, not committed to Git, and are sent only to their configured endpoint.

## Deliberate constraints

- A vector index contains embeddings from exactly one provider identity and one fixed dimension.
- Every match retains its PDF page number and source text.
- Library removal deletes only the app-managed PDF, metadata, and indexes after explicit confirmation; the original import source is untouched.
- OCR work is adaptively capped at one to four concurrent workers to improve scanned-book throughput without unbounded CPU or memory growth.
- GLM-OCR is optional, query-time only, and limited to two retrieved pages per question.
- Cross-book exact SQLite search is limited to explicit user-created packs and runs off the main thread; very large/million-chunk packs may later opt into ANN while retaining exact-search compatibility.
