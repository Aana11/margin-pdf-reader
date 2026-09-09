const { parentPort, workerData } = require('node:worker_threads');
const { searchIndex } = require('./index-store.cjs');

function searchKnowledgeBooks(input) {
  const startedAt = Date.now();
  const matches = [];
  const skippedBooks = [];
  let searchedBooks = 0;
  for (const book of input.books) {
    try {
      if (book.indexProviderId !== input.providerId) {
        skippedBooks.push({
          bookId: book.id,
          bookName: book.name,
          reason: book.indexProviderId ? 'provider-mismatch' : 'not-indexed',
        });
        continue;
      }
      const results = searchIndex(
        book.directory,
        input.providerId,
        Float32Array.from(input.vector),
        input.limit,
        { pageFrom: input.pageFrom, pageTo: input.pageTo },
      );
      searchedBooks += 1;
      for (const match of results)
        matches.push({
          ...match,
          id: `${book.id}:${match.id}`,
          chunkId: match.id,
          bookId: book.id,
          bookName: book.name,
        });
    } catch (error) {
      skippedBooks.push({
        bookId: book.id,
        bookName: book.name,
        reason: 'index-error',
        detail: error instanceof Error ? error.message : String(error),
      });
    }
  }
  matches.sort((left, right) => right.score - left.score);
  return {
    matches: matches.slice(0, input.limit),
    searchedBooks,
    skippedBooks,
    elapsedMs: Date.now() - startedAt,
    workerCount: 1,
  };
}

if (parentPort) {
  try {
    parentPort.postMessage({
      ok: true,
      value: searchKnowledgeBooks(workerData),
    });
  } catch (error) {
    parentPort.postMessage({
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

module.exports = { searchKnowledgeBooks };
