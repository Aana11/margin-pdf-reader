# Architecture

Margin is a local-first Electron PDF reader. It separates untrusted document rendering from filesystem, OCR, model-sidecar, and index responsibilities while keeping every local operation behind a narrow preload API.

## Runtime boundaries

- **Electron main process:** owns the managed library, `margin://` file protocol, Tesseract worker, SQLite indexes, logs, downloads, and llama.cpp sidecar. It never receives chat or remote-embedding API keys.
- **Sandboxed renderer:** owns PDF.js rendering, text extraction, page virtualization, UI state, chat orchestration, and embedding-provider requests. `nodeIntegration` is disabled; context isolation and sandboxing are enabled.
- **Model providers:** small interfaces isolate OpenAI-compatible chat/embedding services and the built-in Qwen embedding sidecar.

External navigation opens in the system browser. Filesystem access is restricted to validated IPC operations and app-owned book IDs.

## Large-file PDF path

For a real disk file, the preload obtains its native path through Electron `webUtils` and sends only that path to the main process. The main process validates the absolute path, size, and `%PDF-` signature, then copies it directly into the managed library. Byte-transfer IPC remains only as a fallback for programmatically constructed `File` objects and tests.

An opened book is exposed as `margin://app/library/<book-id>/document.pdf`. Electron serves this local resource through its network stack, so PDF.js can fetch it without first loading the complete file into a renderer `ArrayBuffer`. Page canvases are windowed and released after leaving the viewport margin.

## OCR and RAG pipeline

1. PDF.js extracts selectable text page by page.
2. If a page has no text and OCR is enabled, the renderer rasterizes it to a capped offscreen canvas and transfers a PNG to the main process.
3. A single queued Tesseract.js worker recognizes simplified Chinese plus English, traditional Chinese plus English, or English. Language data ships with the application; no OCR image leaves the machine.
4. Text is normalized and split into overlapping, page-addressable chunks.
5. The selected embedding provider generates vectors in bounded batches (4 for local Qwen, 16 for remote providers).
6. Each completed batch is transferred as `Float32Array` and immediately appended to SQLite.
7. Query search streams rows from SQLite, computes cosine similarity, and retains only the best K matches.
8. When optional GLM-OCR deep reading is enabled, the renderer classifies retrieved text for formulas, code, tables, or an explicit deep-reading request. It rasterizes at most two unique candidates and sends them to the configured GLM-OCR endpoint.
9. The current page, top-ranked chunks, and successful visual-recognition results are sent to the configured chat model only after the user asks a question.

Tesseract OCR runs only when PDF.js finds no text layer. Its output is used for assistant context and retrieval; Margin does not write an invisible selectable-text layer back into the PDF.

## Optional GLM-OCR deep reading

GLM-OCR is a query-time precision layer, not a replacement for the embedding index. Vector search first supplies semantically relevant, page-addressable candidates. A deterministic classifier then chooses the official `Formula Recognition:`, `Table Recognition:`, or `Text Recognition:` task. User phrases such as “精读”, “公式”, “代码”, or “表格” explicitly request the same path.

The integration uses an OpenAI-compatible multimodal `/chat/completions` endpoint, so users may run the official model through Ollama, vLLM, or SGLang. It is disabled by default, sends at most two JPEG page images per question, runs sequentially, and caches results by book/page/task/endpoint/model for the current session. A recognition error is logged and degrades to ordinary RAG instead of failing the chat request.

GLM-OCR weights and its inference framework are not packaged by Margin. This keeps the installer bounded and avoids imposing a GPU, Python, or Ollama runtime on readers who do not use precision recognition. Users control whether the endpoint is local or remote; the settings UI warns that a remote service receives selected page images.

## Index storage

Each completed book index is stored beside the managed PDF as `index.sqlite`. Metadata records the schema version, provider identity, vector dimensions, completion state, and timestamps. Chunk rows contain page, ordinal, text, norm, and a little-endian Float32 BLOB.

Builds write to `index.sqlite.building` and replace the previous database only after a successful commit and close. Stopping or failing a build removes the temporary database and preserves the last complete index. A version-1 `index.json` is migrated on first open; the JSON source is deleted only after the SQLite replacement succeeds.

Provider identity remains an invariant: an index opens only when its embedding provider/model/version matches the current selection. Search stays in the main process so the renderer does not deserialize or retain every vector. Measured results and the reproducible command are in [`index-benchmark.md`](index-benchmark.md).

## Embedding providers

The built-in provider uses `Qwen/Qwen3-Embedding-4B`, produces 2560-dimensional embeddings, and runs the official Q4_K_M GGUF through a pinned llama.cpp sidecar bound only to `127.0.0.1`. The main process selects a Vulkan runtime when an NVIDIA GPU is detected and otherwise uses CPU; `MARGIN_RUNTIME_BACKEND` can override it. The sidecar exits after two idle minutes or an explicit unload request.

The model and llama.cpp runtime are optional downloaded resources rather than Git-tracked blobs. Downloads are resumable, checksum-verified, and stored below the Margin data root. The remote provider follows the OpenAI-compatible `/embeddings` contract; document chunks leave the machine only when the user selects that mode.

## Local state and privacy

The managed PDF, catalog metadata, progress, OCR-derived index text, and SQLite vectors remain below the local Margin data root. Renderer preferences—including bookshelf collapse state, chat/embedding/GLM-OCR settings, custom system prompt, and per-book chat history—use Electron browser storage. Chat history is capped per book and removed when that book is deleted.

Chat and embedding credentials are separate because users may choose different vendors. They are stored in the Electron browser profile, not committed to Git, and are sent only to their configured endpoint.

## Deliberate constraints

- A vector index contains embeddings from exactly one provider identity and one fixed dimension.
- Every match retains its PDF page number and source text.
- Library removal deletes only the app-managed PDF, metadata, and indexes after explicit confirmation; the original import source is untouched.
- OCR work is sequential to bound CPU and memory use.
- GLM-OCR is optional, query-time only, and limited to two retrieved pages per question.
- Exact SQLite search targets individual large books; a future cross-library or million-chunk mode may require an ANN extension.
