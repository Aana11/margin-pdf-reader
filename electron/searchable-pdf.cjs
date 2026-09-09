const { existsSync } = require('node:fs');
const { readFile, writeFile } = require('node:fs/promises');
const path = require('node:path');
const { PDFDocument, StandardFonts } = require('pdf-lib');
const fontkit = require('@pdf-lib/fontkit');

function findSearchablePdfFont() {
  const fontRoot = path.join(process.env.WINDIR || 'C:\\Windows', 'Fonts');
  return ['simhei.ttf', 'Deng.ttf', 'NotoSansSC-VF.ttf']
    .map((name) => path.join(fontRoot, name))
    .find(existsSync);
}

async function exportSearchablePdfFile({
  sourceFile,
  outputFile,
  pages,
  producer,
  fontPath = findSearchablePdfFont(),
}) {
  const document = await PDFDocument.load(await readFile(sourceFile), {
    updateMetadata: false,
  });
  document.registerFontkit(fontkit);
  const limitedCharset = !fontPath;
  const font = fontPath
    ? await document.embedFont(await readFile(fontPath), { subset: true })
    : await document.embedFont(StandardFonts.Helvetica);
  const prepareText = limitedCharset
    ? (value) => String(value || '').replace(/[^\x20-\x7e]/g, ' ')
    : (value) => String(value || '');
  let overlaidPages = 0;
  for (const entry of pages) {
    const pdfPage = document.getPage(entry.page - 1);
    if (!pdfPage) continue;
    const { width: pageWidth, height: pageHeight } = pdfPage.getSize();
    const layout = entry.layout;
    const regions = Array.isArray(layout?.regions) ? layout.regions : [];
    if (regions.length > 0 && layout.width > 0 && layout.height > 0) {
      for (const region of regions) {
        const text = prepareText(region.text).slice(0, 2_000).trim();
        if (!text) continue;
        const boxWidth =
          ((region.bbox.x1 - region.bbox.x0) / layout.width) * pageWidth;
        const boxHeight =
          ((region.bbox.y1 - region.bbox.y0) / layout.height) * pageHeight;
        const naturalWidth = Math.max(font.widthOfTextAtSize(text, 1), 0.01);
        const size = Math.max(
          1,
          Math.min(boxHeight * 0.82, boxWidth / naturalWidth),
        );
        pdfPage.drawText(text, {
          x: (region.bbox.x0 / layout.width) * pageWidth,
          y: pageHeight - (region.bbox.y1 / layout.height) * pageHeight,
          size,
          font,
          opacity: 0,
        });
      }
    } else {
      const fallbackLines = prepareText(entry.text)
        .split(/\r?\n/)
        .filter(Boolean);
      fallbackLines.slice(0, 2_000).forEach((line, lineIndex) => {
        pdfPage.drawText(line.slice(0, 2_000), {
          x: 1,
          y: Math.max(1, pageHeight - 2 - lineIndex * 0.2),
          size: 0.1,
          font,
          opacity: 0,
        });
      });
    }
    overlaidPages += 1;
  }
  document.setProducer(producer);
  document.setModificationDate(new Date());
  await writeFile(outputFile, await document.save());
  return { pages: overlaidPages, limitedCharset };
}

module.exports = { exportSearchablePdfFile, findSearchablePdfFont };
