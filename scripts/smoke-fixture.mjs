import { mkdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

function escapePdfText(value) {
  return value.replaceAll('\\', '\\\\').replaceAll('(', '\\(').replaceAll(')', '\\)');
}

function createSmokePdf() {
  const pageStreams = [
    [
      'Margin PDF Reader Smoke Test',
      'Page 1: The retrieval index stores searchable textbook content.',
      'Formula example: x squared plus y squared equals z squared.',
      'Code example: function add(a, b) returns a plus b.',
    ],
    [
      'Margin PDF Reader Smoke Test',
      'Page 2: Semantic search finds the exact supporting passage.',
      'Large books use concurrent extraction, OCR, and binary vectors.',
      'The reading assistant keeps citations connected to page numbers.',
    ],
  ].map((lines) => {
    const commands = ['BT', '/F1 24 Tf', '72 730 Td'];
    lines.forEach((line, index) => {
      if (index > 0) commands.push('0 -42 Td');
      commands.push(`(${escapePdfText(line)}) Tj`);
    });
    commands.push('ET');
    return `${commands.join('\n')}\n`;
  });

  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [4 0 R 6 0 R] /Count 2 >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents 5 0 R >>',
    `<< /Length ${Buffer.byteLength(pageStreams[0])} >>\nstream\n${pageStreams[0]}endstream`,
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents 7 0 R >>',
    `<< /Length ${Buffer.byteLength(pageStreams[1])} >>\nstream\n${pageStreams[1]}endstream`,
  ];

  const parts = ['%PDF-1.4\n'];
  const offsets = [0];
  objects.forEach((body, index) => {
    offsets[index + 1] = Buffer.byteLength(parts.join(''));
    parts.push(`${index + 1} 0 obj\n${body}\nendobj\n`);
  });
  const xrefOffset = Buffer.byteLength(parts.join(''));
  const xref = ['xref\n0 8\n', '0000000000 65535 f \n'];
  offsets.slice(1).forEach((offset) => xref.push(`${String(offset).padStart(10, '0')} 00000 n \n`));
  parts.push(`${xref.join('')}trailer\n<< /Size 8 /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`);
  return Buffer.from(parts.join(''), 'ascii');
}

export async function ensureSmokePdf(pdfPath) {
  try {
    const existing = await stat(pdfPath);
    if (existing.size > 0) return pdfPath;
  } catch {
    // The fixture is intentionally generated in clean CI checkouts.
  }
  await mkdir(path.dirname(pdfPath), { recursive: true });
  await writeFile(pdfPath, createSmokePdf());
  return pdfPath;
}
