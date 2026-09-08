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
4. A bounded pool of one to four Tesseract.js workers (selected from logical processor count and installed memory) recognizes simplified Chinese plus English, traditional Chinese plus English, or English. Language data ships with the application; no OCR image leaves the machine. A failed page is retried once and then recorded in the task.
5. Text is normalized and split into overlapping, page-addressable chunks.
6. The selected embedding provider generates vectors in bounded batches (8 for Vulkan Qwen, adaptive 1–4 for CPU Qwen, 16 for remote providers).
7. Completed vectors are transferred as `Float32Array` and accumulated into SQLite transactions of at most 64 entries.
8. Single-book search streams rows from SQLite, computes cosine similarity, and retains only the best K matches.
9. Cross-book search first resolves one user-selected knowledge pack, computes the query vector once, and sends only its member indexes to a worker thread. The worker skips missing/provider-incompatible indexes and merges per-book candidates into a global Top-K carrying book and page identity.
10. When optional GLM-OCR deep reading is enabled, single-book reading classifies retrieved text for formulas, code, tables, or an explicit deep-reading request. It rasterizes at most two unique candidates and sends them to the configured GLM-OCR endpoint.
11. The current page or user-selected knowledge-pack matches and successful visual-recognition results are sent to the configured chat model only after the user asks a question.
12. Explicit region reading crops the already-rendered page canvas, caps the longest edge at 1,800 pixels, and sends only that JPEG region to GLM-OCR before task-specific chat processing.

Tesseract OCR runs only when PDF.js finds no meaningful text layer and the page-density preflight indicates visible content. Its output is used for assistant context and retrieval; Margin does not write an invisible selectable-text layer back into the PDF.

## Optional GLM-OCR deep reading

GLM-OCR is a query-time precision layer, not a replacement for the embedding index. Vector search first supplies semantically relevant, page-addressable candidates. A deterministic classifier then chooses the official `Formula Recognition:`, `Table Recognition:`, or `Text Recognition:` task. User phrases such as “精读”, “公式”, “代码”, or “表格” explicitly request the same path.

GLM requests cross the context-isolated preload bridge and execute in the Electron main process, avoiding renderer CORS restrictions. The default managed mode uses llama.cpp's multimodal `/v1/chat/completions` endpoint; legacy Ollama mode follows `/api/generate`, while vLLM, SGLang, and remote providers use multimodal `/chat/completions`. The feature is disabled by default, sends at most two JPEG page images per question, runs sequentially, and caches results by book/page/task/provider/endpoint/model for the current session. A recognition error is logged with an actionable service/runtime/model diagnosis and degrades to ordinary RAG instead of failing the chat request.

GLM-OCR weights are not packaged by Margin. Managed mode downloads checksum-pinned `GLM-OCR-Q8_0.gguf` and `mmproj-GLM-OCR-Q8_0.gguf`, reuses the pinned llama.cpp CPU/Vulkan runtime, and starts a loopback-only sidecar on a random port. Downloads resume from partial files; the sidecar exits after five idle minutes or explicit unload. Starting GLM-OCR stops the embedding sidecar and vice versa so both large models do not compete for GPU memory. On startup, complete files in the stable Margin data root are auto-associated for legacy profiles that never chose a GLM mode; an explicit off setting remains authoritative. Existing Ollama and OpenAI-compatible services remain optional advanced providers and are never terminated by managed mode.

Manual region reading is independent of vector-index state. The renderer stores a normalized page rectangle plus a single in-memory crop, dispatches formula/table/text recognition according to the selected action, and caches recognition by SHA-256 + task + provider identity. Chat history stores the normalized rectangle but never the image bytes. Citation buttons restore the page and overlay exactly from these normalized coordinates.

The same normalized rectangle can be persisted without model inference as a highlight, annotation, or glossary source. Completed assistant output can be persisted as a summary card. These records and per-book messages live in the global `workspace.sqlite`; queries use bounded limits/offsets, so opening the app does not deserialize every historical conversation. A one-time renderer migration copies legacy `margin-chat-history-v1` records into SQLite and removes the old payload only after every known book succeeds.

## Index storage

Each completed book index is stored beside the managed PDF as `index.sqlite`. Metadata records the schema version, provider identity, vector dimensions, completion state, and timestamps. Chunk rows contain page, ordinal, text, norm, and a little-endian Float32 BLOB.

Builds write to `index.sqlite.building` and replace the previous database only after a successful commit and close. The building database contains page-text checkpoints (including whether text came from PDF.js or OCR) and completed vector rows. Pause, process exit, and recoverable failure close but retain this database; the next compatible run resumes missing pages/chunks. Explicit cancellation removes only the building file through a separate IPC operation, preserving any previous complete index. A completed index also retains page text so changing only the vector provider can reuse compatible OCR work. A version-1 `index.json` is migrated on first open; the JSON source is deleted only after the SQLite replacement succeeds.

Provider identity remains an invariant: an index opens only when its embedding provider/model/version matches the current selection. Search stays in the main process so the renderer does not deserialize or retain every vector. Measured results and the reproducible command are in [`index-benchmark.md`](index-benchmark.md).

## Cross-book knowledge packs

Knowledge packs are relational metadata in `workspace.sqlite`: `knowledge_packs` stores the user-visible folder and `knowledge_pack_books` stores its ordered book IDs. This avoids duplicating PDFs or vector BLOBs, permits one book to belong to several packs, and lets book deletion remove memberships transactionally without deleting the remaining pack.

The renderer computes one query embedding and invokes a narrow `knowledge:search` bridge with the selected pack ID. The main process resolves membership against the current catalog, so renderer-supplied IDs cannot widen scope. Exact searches execute in `knowledge-search-worker.cjs`, keeping synchronous `node:sqlite` vector scans off the Electron main thread. Every result carries `bookId`, `bookName`, `page`, score, and text; the assistant persists a bounded source list beside its message for later page navigation.

No all-library fallback exists. Empty packs fail with an actionable message, removed books disappear from memberships, and provider-incompatible indexes are returned as skipped diagnostics. Exact per-book SQLite remains the compatibility path; ANN will be considered only after real pack sizes justify its additional native dependency and migration cost.

## Embedding providers

The built-in provider uses `Qwen/Qwen3-Embedding-4B`, produces 2560-dimensional embeddings, and runs the official Q4_K_M GGUF through a pinned llama.cpp sidecar bound only to `127.0.0.1`. The same pinned runtime also supports managed GLM-OCR. The main process selects a Vulkan runtime when an NVIDIA GPU is detected and otherwise uses CPU; `MARGIN_RUNTIME_BACKEND` can override it. Vulkan embedding runs eight parallel slots with a larger token batch, while CPU remains at four slots to avoid thread oversubscription. The embedding sidecar exits after two idle minutes or an explicit unload request.

The model and llama.cpp runtime are optional downloaded resources rather than Git-tracked blobs. Downloads are resumable, checksum-verified, and stored below the Margin data root. The remote provider follows the OpenAI-compatible `/embeddings` contract; document chunks leave the machine only when the user selects that mode.

## Local state and privacy

The managed PDF, catalog metadata, progress, OCR-derived index text, SQLite vectors, chat history, source citations, knowledge-pack membership, highlights, annotations, summary cards, and glossary entries remain below the local Margin data root. Chat history, knowledge packs, and reading materials use `workspace.sqlite`; chat is capped to the latest 100 messages per book or pack in the active context, while history search and material lists load bounded result pages. Renderer preferences—including chat/embedding/GLM-OCR settings and the custom system prompt—use Electron browser storage. Removing a book also removes its workspace rows and knowledge-pack memberships.

Chat and embedding credentials are separate because users may choose different vendors. They are stored in the Electron browser profile, not committed to Git, and are sent only to their configured endpoint.

## Deliberate constraints

- A vector index contains embeddings from exactly one provider identity and one fixed dimension.
- Every match retains its PDF page number and source text.
- Library removal deletes only the app-managed PDF, metadata, and indexes after explicit confirmation; the original import source is untouched.
- OCR work is adaptively capped at one to four concurrent workers to improve scanned-book throughput without unbounded CPU or memory growth.
- GLM-OCR is optional, query-time only, and limited to two retrieved pages per question.
- Cross-book exact SQLite search is limited to explicit user-created packs and runs off the main thread; very large/million-chunk packs may later opt into ANN while retaining exact-search compatibility.
