# Architecture

Margin is a local-first desktop PDF reader. The renderer owns PDF parsing, page rendering, text extraction, embedding inference, vector search, and chat orchestration. PDF bytes are never sent to a service unless a future, explicit feature says otherwise.

## Runtime boundaries

- **Electron main process:** window lifecycle and operating-system integration only. It does not receive model keys or document text.
- **Sandboxed renderer:** PDF.js, local embedding inference, the vector index, and the reading UI.
- **Model providers:** small interfaces isolate chat and embedding vendors from the reader and index.

The Electron renderer has `nodeIntegration` disabled, `contextIsolation` enabled, and sandboxing enabled. External navigation opens in the system browser.

## RAG pipeline

1. PDF.js extracts text page by page.
2. Text is normalized and split into overlapping, page-addressable chunks.
3. The selected embedding provider generates normalized vectors.
4. The local index ranks chunks with cosine similarity.
5. The current page and top-ranked chunks are sent to the configured chat model.

The first index implementation is intentionally in memory. The next storage step should be SQLite with a document fingerprint and provider/model schema version so indexes can be reused safely without mixing incompatible vector spaces.

## Embedding providers

The built-in provider uses `Qwen/Qwen3-Embedding-4B`, produces 2560-dimensional embeddings, and currently runs the official AVX2 Q8 ONNX artifact through Transformers.js/WASM. Document chunks are embedded as-is; queries receive a retrieval instruction prefix, matching Qwen's recommended asymmetric-retrieval usage.

The model is an optional application resource rather than a Git-tracked blob. `npm run model:bundle` streams a pinned artifact from Hugging Face, falls back to ModelScope, verifies the published SHA-256, and places it under the ignored `public/models/` directory before a bundled build. The Q8 artifact alone is about 4.03 GB, so it is deliberately not part of ordinary CI or the source repository. A native sidecar with resumable first-run model installation is the next production step; the WASM path is an initial implementation for validation on AVX2 Windows machines.

The remote provider follows the OpenAI-compatible `/embeddings` contract. Provider configuration belongs to the local user profile and must never be committed.

## Deliberate constraints

- A vector index may contain embeddings from exactly one provider/model/version.
- Every match retains its PDF page number and source text.
- Scanned pages are reported as missing text until an OCR module is added.
- Chat and embedding credentials remain separate because users may choose different vendors.
