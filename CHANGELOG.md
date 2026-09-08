# Changelog

All notable changes to Margin are documented here.

## [0.3.0] - 2026-09-09

### Added

- User-managed cross-book knowledge packs. A folder-style manager shows every pack and its nested books in one view, with same-screen membership selection and index compatibility status.
- Assistant scope switching between the current book and a selected knowledge pack. Pack questions search only explicitly selected members and never fall back to the entire bookshelf.
- Cross-book source cards with book name, page, similarity score, persisted excerpts, and one-click navigation back to the exact source page.
- Unit and packaged desktop coverage for pack CRUD, deletion cleanup, provider filtering, global ranking, a deliberately more-similar excluded book, one-query/one-embedding behavior, chat context isolation, source persistence, and page navigation.

### Changed

- Knowledge-pack relations and cross-book chat sources are stored in the existing `workspace.sqlite`; PDFs and per-book Float32 indexes are not duplicated.
- Cross-book exact search runs in a worker thread. It computes the query embedding once, streams only selected compatible per-book SQLite indexes, and globally merges their Top-K results without blocking the Electron main process.
- Books without an index or with a different embedding-provider identity are reported as skipped rather than silently mixed into an incompatible result set.
- Removing a book now also removes its membership from every knowledge pack while preserving the packs and their remaining books.

## [0.2.9] - 2026-09-08

### Added

- A reading workspace in the left sidebar for page-region highlights, annotations, AI summary cards, and a searchable concept glossary.
- One-click saving of any completed assistant answer as a Markdown/KaTeX-preserving summary card.
- Cross-book question-history search, reading-material filters, page/region navigation, pagination, and Markdown export through a native save dialog.
- Unit and packaged desktop coverage for workspace persistence, legacy-history migration, search, export generation, and cleanup.

### Changed

- Per-book chat history moved from renderer `localStorage` to a dedicated `workspace.sqlite` database. Existing `margin-chat-history-v1` records migrate automatically on the first 0.2.9 launch.
- Long histories and reading-material collections are loaded in bounded pages instead of being deserialized into the renderer at startup.
- Removing a managed book now also removes its associated messages, highlights, notes, summary cards, and glossary entries from the workspace database.

## [0.2.8] - 2026-09-08

### Added

- A persistent background index task center in the application sidebar. Books can be queued individually or in bulk, processed without switching the reader, paused/resumed from SQLite checkpoints, or cancelled with explicit checkpoint cleanup.
- Per-task stage timing, page/chunk/OCR counters, failed-page reporting, active CPU/Vulkan backend, and adaptive text/OCR/embedding lane telemetry.
- OCR preflight classification for pages with no or very little extracted text. Near-blank pages skip Tesseract, while individual OCR failures retry once before being reported.
- Packaged desktop coverage for automatic local-model association and persisted background task results.

### Changed

- Index progress remains monotonic across extraction, OCR, chunking, embedding, and SQLite completion, including resumed tasks and books queued behind another active job.
- The application now discovers already-downloaded Qwen, GLM-OCR, and pinned llama.cpp files at startup. If a legacy profile never explicitly chose a GLM-OCR mode, complete local files are associated with managed on-demand mode automatically; an explicit user choice to keep it off is preserved.
- CPU concurrency now also considers installed memory, while Vulkan/CPU embedding lanes are reported and selected from the main-process hardware profile.
- Cancelling an index is distinct from pausing: pause retains `index.sqlite.building`, while cancel removes only that unfinished checkpoint and leaves the last completed index intact.

## [0.2.7] - 2026-09-08

### Added

- Page-region precision reading: enable “框选精读”, drag over a formula, table, code block, or paragraph, then directly explain, recognize, analyze, or translate it.
- Region citations on both the question and answer. Clicking a citation scrolls back to the exact normalized rectangle on the source page.
- Packaged desktop coverage for real pointer selection, cropped GLM-OCR input, KaTeX output, citation navigation, and repeated-selection cache hits.

### Changed

- Explicit region reading sends only the selected JPEG crop to GLM-OCR rather than rasterizing the full PDF page. Crops are capped at 1,800 pixels on the longest edge.
- Region recognition is cached by image SHA-256, OCR task, and model-provider identity for the current session, avoiding duplicate visual inference while keeping chat requests independent.
- Formula, table, code, and translation actions now route through task-specific prompts and preserve LaTeX, Markdown tables, and code blocks in the assistant output.
- The first Tesseract worker now warms a pre-created shared language cache before the remaining adaptive worker pool starts, avoiding missing-directory and concurrent first-run cache contention on Windows.
- Current-page detection now resolves the page at the viewport focus point with a binary search in one scheduled callback per scroll burst, covering programmatic jumps without scanning every page layout or relying on late intersection notifications.
- OCR and deep-reading rasters use PDF.js's independent print-render intent, preventing background index rendering from contending with visible page canvases.

## [0.2.6] - 2026-09-08

### Added

- Application-managed GLM-OCR using the official community GGUF main model and multimodal projector through the same pinned llama.cpp runtime used by local embeddings.
- Resumable, checksum-verified GLM-OCR download with pause/continue, model-folder access, explicit memory release, and uninstall controls.
- Automatic migration from the former default Ollama setting to the managed local provider; existing Ollama and OpenAI-compatible endpoints remain available as advanced options.

### Changed

- Local GLM-OCR no longer requires users to install Ollama or Python. Margin starts a loopback-only sidecar on demand and stops it after five idle minutes.
- The embedding and GLM-OCR sidecars now release one another before startup, avoiding simultaneous GPU-memory pressure.
- Updated the shared llama.cpp CPU/Vulkan runtime to build `b10516`, with a version marker that repairs outdated local runtimes automatically.

## [0.2.5] - 2026-09-07

### Added

- Resumable SQLite index checkpoints preserve extracted/OCR page text and completed vectors across pause, app exit, or failure. Re-indexing with another vector provider reuses compatible cached page text.
- Built-in Ollama management for GLM-OCR: runtime/service/model detection, install link, service auto-start, model pull/preload progress, native vision requests, and explicit memory release.
- Safe Markdown rendering for assistant answers, including GFM tables/code and KaTeX for inline and display LaTeX formulas.
- Adaptive extraction and OCR concurrency based on available logical processors.

### Changed

- Index progress is monotonically increasing within a run; concurrent worker status can no longer move the progress bar backwards.
- Removed the reading toolbar/banner. The detected current page appears briefly in a centered overlay at the bottom while scrolling.
- Ollama GLM-OCR calls now use the official native `/api/generate` image contract from the Electron main process, avoiding renderer CORS failures. vLLM, SGLang, and remote services retain the OpenAI-compatible path.
- “Stop” is now a safe pause: the `.building` SQLite checkpoint remains available for continuation instead of being deleted.

### Fixed

- Replaced the opaque `Failed to fetch` GLM-OCR fallback with actionable diagnostics for missing Ollama, stopped services, absent models, invalid endpoints, and timeouts.

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
