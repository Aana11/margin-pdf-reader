# Changelog

All notable changes to Margin are documented here.

## [0.2.4] - 2026-09-06

### Added

- A permanent compact application sidebar with reserved module positions; the local bookshelf now opens as a focused management dialog and model settings live at the bottom.
- Live vector-index throughput and estimated remaining time, plus stage-level timing in diagnostic logs.

### Changed

- Removed the top Margin banner to return vertical space to the document and assistant.
- PDF text extraction now uses bounded six-page concurrency.
- Textless pages are rendered and recognized through a three-worker local Tesseract pool instead of one global serial queue.
- Vulkan-backed Qwen indexing uses eight llama.cpp slots and eight-chunk requests; CPU remains capped at four to avoid oversubscription.
- Text chunks are moderately larger and SQLite appends are grouped into batches of up to 64, reducing model requests, IPC transfers, and transactions for large books.

### Performance diagnosis

- Direct inspection of the reported 421-page algebra book found no PDF text layer on any page, making serial OCR its immediate bottleneck. Earlier electronic-book logs separately showed 411 pages of text extraction completing in about 2.2 seconds while 4-chunk embedding requests took 18–22 seconds on the CPU path. SQLite storage was not the bottleneck in either case.

## [0.2.1] - 2026-09-06

### Added

- Optional GLM-OCR precision reading through OpenAI-compatible Ollama, vLLM, or SGLang endpoints.
- Query-time coordination in which the embedding model retrieves relevant pages and GLM-OCR re-reads up to two formula, code, table, or explicitly requested pages from their rendered images.
- Official task routing for formula, table, and text recognition, with session caching, visible status, diagnostics, and graceful fallback to ordinary RAG.
- Unit-level protocol coverage and a packaged desktop vector → image → GLM-OCR → chat integration smoke test.

### Privacy and packaging

- GLM-OCR is disabled by default and its weights/runtime are not bundled. Local endpoints keep page images on-device; remote endpoints receive only the selected candidate pages.

## [0.2.0] - 2026-09-06

### Added

- Fully local Tesseract OCR for textless PDF pages in simplified Chinese + English, traditional Chinese + English, or English.
- SQLite indexes with Float32 binary vectors, provider validation, atomic builds, safe cancellation, and automatic migration from version-1 `index.json` files.
- End-to-end OCR/index smoke coverage and a reproducible large-book index benchmark.

### Changed

- Real disk PDFs are copied by native path and opened through a local application protocol, avoiding an extra whole-file renderer transfer.
- Embeddings are generated and persisted in bounded batches; queries stream SQLite rows and retain only Top-K matches.
- Release tags publish tested Windows installer and portable artifacts directly to GitHub Releases.

### Performance

- The 2,000-chunk × 2,560-dimension benchmark produced a 24,678,400-byte SQLite index versus 99,230,308-byte JSON (75.1% smaller).
- SQLite write time was 138 ms versus 532 ms for JSON in the recorded run, with a 31 ms exact Top-5 query.

## [0.1.0] - 2026-09-05

- Initial Windows desktop release with continuous reading, local bookshelf and progress, per-book question history, configurable prompts, and local/remote embeddings.
