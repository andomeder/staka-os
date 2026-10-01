/**
 * Export helpers for the admin dashboard.
 *
 * CSV is RFC 4180 serialized by hand. The letterhead PDF is built with
 * pdf-lib (pure JS, no native deps) so the output opens correctly in every
 * viewer, with the Staka mark, wordmark and report metadata on page one.
 */

import { PDFDocument, StandardFonts, rgb, type PDFFont } from "pdf-lib";

/** Escapes a value for RFC 4180 CSV output. */
export function csvCell(value: string | number | null | undefined): string {
  const s = value === null || value === undefined ? "" : String(value);
  if (/[",\r\n]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

export function csvDocument(header: string[], rows: Array<Array<string | number | null | undefined>>): string {
  const lines = [header, ...rows].map((r) => r.map(csvCell).join(","));
  // Trailing CRLF per RFC 4180.
  return `${lines.join("\r\n")}\r\n`;
}

// WinAnsi (pdf-lib standard font encoding) has no em dash / smart quotes;
// normalize the characters we might emit from data or labels.
function winAnsi(s: string): string {
  return s
    .replace(/[\u2010-\u2015]/g, "-")
    .replace(/[\u2018\u2019\u201B]/g, "'")
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/[\u2022]/g, "*")
    .replace(/[\u2026]/g, "...")
    .replace(/[^\x00-\xFF]/g, "?");
}

export type PdfSection = {
  heading?: string;
  lines?: Array<{ text: string; bold?: boolean }>;
  table?: { header: string[]; rows: string[][] };
};

const PAGE_W = 595.28; // A4 portrait, points
const PAGE_H = 841.89;
const MARGIN = 56;
const BRAND = rgb(0x1e / 255, 0x5e / 255, 0xff / 255);
const INK = rgb(0x10 / 255, 0x18 / 255, 0x28 / 255);
const MUTED = rgb(0x5a / 255, 0x64 / 255, 0x74 / 255);
const LINE = rgb(0xc6 / 255, 0xce / 255, 0xdb / 255);

/**
 * Builds a letterhead PDF: Staka mark + wordmark, org line, title, metadata,
 * then content sections flowing across pages with page-number footers.
 */
export async function letterheadPdf(input: {
  orgName: string;
  title: string;
  subtitle?: string;
  generatedBy: string;
  generatedAt: string;
  sections: PdfSection[];
}): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.setTitle(winAnsi(input.title));
  doc.setAuthor(winAnsi(`${input.orgName} admin console`));
  doc.setProducer("staka org-server");

  const regular = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);

  const contentW = PAGE_W - MARGIN * 2;

  let page = doc.addPage([PAGE_W, PAGE_H]);
  let y = 0; // y counts DOWN from the top margin

  const fontFor = (f: PDFFont, size: number, text: string) =>
    f.widthOfTextAtSize(text, size);

  const drawRight = (
    text: string,
    size: number,
    f: PDFFont,
    yTop: number,
    color = MUTED,
  ) => {
    const w = fontFor(f, size, text);
    page.drawText(winAnsi(text), {
      x: PAGE_W - MARGIN - w,
      y: PAGE_H - yTop - size,
      size,
      font: f,
      color,
    });
  };

  const drawLeft = (
    text: string,
    size: number,
    f: PDFFont,
    yTop: number,
    color = INK,
    x = MARGIN,
  ) => {
    page.drawText(winAnsi(text), {
      x,
      y: PAGE_H - yTop - size,
      size,
      font: f,
      color,
    });
  };

  const footer = (pageIndex: number, total: number) => {
    const label = winAnsi(
      `${input.orgName} - AI-native enterprise desktop    Page ${pageIndex} of ${total}`,
    );
    page.drawText(label, {
      x: MARGIN,
      y: 34,
      size: 8,
      font: regular,
      color: MUTED,
    });
  };

  const newPage = () => {
    page = doc.addPage([PAGE_W, PAGE_H]);
    y = 0;
  };
  const ensure = (needed: number) => {
    if (y + needed > PAGE_H - MARGIN - 40) newPage();
  };

  const wrapText = (text: string, maxChars: number): string[] => {
    if (text.length <= maxChars) return [text];
    const words = text.split(/\s+/);
    const out: string[] = [];
    let line = "";
    for (const w of words) {
      if (!line) line = w;
      else if (line.length + 1 + w.length <= maxChars) line = `${line} ${w}`;
      else {
        out.push(line);
        line = w;
      }
    }
    if (line) out.push(line);
    return out;
  };

  // Letterhead on the first page: three-bar Staka mark, wordmark, rule.
  const drawLetterhead = () => {
    const barH = 7;
    const barW = 26;
    const barY = PAGE_H - MARGIN - 4;
    const bars: Array<[number, number, number]> = [
      [0x1e, 0x5e, 0xff],
      [0x3b, 0x7b, 0xff],
      [0x0b, 0x2f, 0x8a],
    ];
    bars.forEach(([r, g, b], i) => {
      page.drawRectangle({
        x: MARGIN + (i === 1 ? 5 : 0),
        y: barY - i * (barH + 2.5),
        width: barW,
        height: barH,
        color: rgb(r / 255, g / 255, b / 255),
      });
    });
    const markBottom = barY - 2 * (barH + 2.5);
    drawLeft(input.orgName, 15, bold, MARGIN - 6, INK, MARGIN + barW + 12);
    drawLeft("Admin console report", 9.5, regular, MARGIN - 6, MUTED, MARGIN + barW + 12 + fontFor(bold, 15, input.orgName) + 8);
    page.drawLine({
      start: { x: MARGIN, y: markBottom - 10 },
      end: { x: PAGE_W - MARGIN, y: markBottom - 10 },
      thickness: 1.2,
      color: LINE,
    });
    // Content starts below the letterhead rule with breathing room.
    y = 96;
  };
  drawLetterhead();

  drawLeft(input.title, 21, bold, y);
  y += 30;
  if (input.subtitle) {
    const wrapW = contentW / regular.widthOfTextAtSize("n", 10.5);
    for (const l of wrapText(winAnsi(input.subtitle), Math.floor(wrapW))) {
      drawLeft(l, 10.5, regular, y, MUTED);
      y += 15;
    }
    y += 4;
  }
  drawLeft(`Organisation: ${input.orgName}`, 9.5, regular, y, MUTED);
  drawRight(`Generated ${input.generatedAt} (UTC)`, 9.5, regular, y, MUTED);
  y += 14;
  drawLeft(`Generated by ${input.generatedBy}`, 9.5, regular, y, MUTED);
  y += 22;

  const tableColW = (cols: number) => contentW / cols;

  const drawTable = (header: string[], rows: string[][]) => {
    const cols = header.length;
    const colW = tableColW(cols);
    const cellMax = (i: number) =>
      Math.floor((colW - 10) / regular.widthOfTextAtSize("n", 9));

    // Header row with a filled band.
    ensure(30);
    page.drawRectangle({
      x: MARGIN,
      y: PAGE_H - y - 18,
      width: contentW,
      height: 19,
      color: rgb(0.955, 0.963, 0.973),
    });
    header.forEach((h, i) => {
      drawLeft(winAnsi(h).toUpperCase(), 8.5, bold, y + 4, MUTED, MARGIN + i * colW + 2);
    });
    y += 26;

    for (const row of rows) {
      const cells = row.map((c, i) => wrapText(winAnsi(c ?? ""), cellMax(i)));
      const lineCount = Math.max(...cells.map((c) => c.length));
      const rowH = lineCount * 13 + 4;
      ensure(rowH + 4);
      cells.forEach((lines, i) => {
        lines.forEach((l, li) => {
          drawLeft(l, 9, regular, y + li * 13, INK, MARGIN + i * colW + 2);
        });
      });
      y += rowH;
      page.drawLine({
        start: { x: MARGIN, y: PAGE_H - y - 8 },
        end: { x: PAGE_W - MARGIN, y: PAGE_H - y - 8 },
        thickness: 0.6,
        color: LINE,
      });
      y += 4;
    }
  };

  for (const section of input.sections) {
    if (section.heading) {
      ensure(40);
      drawLeft(section.heading, 13, bold, y);
      y += 22;
    }
    for (const l of section.lines ?? []) {
      const size = l.bold ? 10.5 : 9.5;
      const f = l.bold ? bold : regular;
      const maxChars = Math.floor(contentW / f.widthOfTextAtSize("n", size));
      for (const wrapped of wrapText(winAnsi(l.text), maxChars)) {
        ensure(16);
        drawLeft(wrapped, size, f, y, l.bold ? INK : MUTED);
        y += 14.5;
      }
    }
    if (section.table) {
      y += 4;
      drawTable(section.table.header, section.table.rows);
    }
    y += 10;
  }

  // Footers last, once the page count is final.
  const pages = doc.getPages();
  pages.forEach((p, i) => {
    footerOn(p, regular, winAnsi(`${input.orgName} - AI-native enterprise desktop`), i + 1, pages.length);
  });

  return doc.save();
}

// Separate helper: pdf-lib pages are objects; drawing the footer needs the
// target page, not the closure's current one.
function footerOn(
  page: import("pdf-lib").PDFPage,
  font: PDFFont,
  brandLabel: string,
  index: number,
  total: number,
) {
  page.drawText(brandLabel, {
    x: MARGIN,
    y: 34,
    size: 8,
    font,
    color: MUTED,
  });
  const label = `Page ${index} of ${total}`;
  const w = font.widthOfTextAtSize(label, 8);
  page.drawText(label, {
    x: PAGE_W - MARGIN - w,
    y: 34,
    size: 8,
    font,
    color: MUTED,
  });
}
