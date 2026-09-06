# Architecture

Margin is a local-first desktop PDF reader. The renderer owns PDF parsing, page rendering, text extraction, embedding inference, vector search, and chat orchestration. PDF bytes are never sent to a service unless a future, explicit feature says otherwise.

## Runtime boundaries

- **Electron main process:** window lifecycle, local library persistence, and the llama.cpp sidecar. It does not receive model keys.
- **Sandboxed renderer:** PDF.js, a Float32 in-memory vector index, and the reading UI. PDF canvases are windowed and released after leaving the viewport margin.
- **Model providers:** small interfaces isolate chat and embedding vendors from the reader and index.

The Electron renderer has `nodeIntegration` disabled, `contextIsolation` enabled, and sandboxing enabled. External navigation opens in the system browser.

## RAG pipeline

1. PDF.js extracts text page by page.
2. Text is normalized and split into overlapping, page-addressable chunks.
3. The selected embedding provider generates normalized vectors.
4. The local index ranks chunks with cosine similarity.
5. The current page and top-ranked chunks are sent to the configured chat model.

Search executes against an in-memory index. The Electron main process persists each completed index beside its book under the local Margin library and restores it only when the provider identity matches. PDF bytes, catalog metadata, reading progress, and indexes stay on the machine. A future storage migration can replace JSON vectors with SQLite without changing the provider or search boundary.

## Embedding providers

The built-in provider uses `Qwen/Qwen3-Embedding-4B`, produces 2560-dimensional embeddings, and runs the official Q4_K_M GGUF through a pinned llama.cpp sidecar bound only to `127.0.0.1`. The main process selects a Vulkan runtime when an NVIDIA GPU is detected and otherwise uses CPU; `MARGIN_RUNTIME_BACKEND` can override that choice. The Electron main process owns the sidecar lifecycle, uses a 2048-token context and 512-token batches for this retrieval workload, and terminates the process after two idle minutes or an explicit unload request. The sandboxed renderer invokes a narrow, validated IPC method and never receives filesystem or sidecar network access. Document chunks are embedded as-is; queries receive a retrieval instruction prefix, matching Qwen's recommended asymmetric-retrieval usage.

The model is an optional application resource rather than a Git-tracked blob. `npm run model:bundle` and the in-app model manager perform resumable downloads from Hugging Face, ModelScope, or the domestic Hugging Face mirror, verify pinned SHA-256 values for both the model and llama.cpp runtime, and install them under the user's Margin data directory. The manager checks available disk space and supports pause, resume, opening the data directory, and uninstall. The Q4_K_M artifact is about 2.50 GB, so it is deliberately not part of ordinary CI or the source repository.

Indexing performs a model preflight. A missing runtime is reconstructed from the pinned, checksum-verified archive when possible; otherwise the renderer receives a component-specific error with the expected path instead of a combined “model or runtime missing” message.

The remote provider follows the OpenAI-compatible `/embeddings` contract. Provider configuration belongs to the local user profile and must never be committed.

Renderer-only preferences—including bookshelf collapse state, model settings, the custom system prompt, and per-book chat history—are persisted in browser storage. Chat history is capped per book and is removed when the corresponding library book is deleted; it never enters the PDF/vector-index directory or leaves the machine automatically.

## Deliberate constraints

- A vector index may contain embeddings from exactly one provider/model/version.
- Every match retains its PDF page number and source text.
- Library removal deletes the app-managed PDF copy and its saved vector index after explicit confirmation.
- Scanned pages are reported as missing text until an OCR module is added.
- Chat and embedding credentials remain separate because users may choose different vendors.
