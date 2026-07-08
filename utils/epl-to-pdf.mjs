/**
 * EPL2 → PDF converter for DPD Local labels
 * Usage:  node utils/epl-to-pdf.mjs input.epl output.pdf
 * Or pipe: cat label.epl | node utils/epl-to-pdf.mjs > output.pdf
 *
 * Handles ZB (bottom-to-top) coordinate system, rotation 0 & 1, barcodes, lines.
 */

import { readFileSync, writeFileSync } from 'fs';
import { PDFDocument, rgb, StandardFonts, degrees } from 'pdf-lib';
import bwipjs from 'bwip-js';

// ── EPL font heights in dots (at 203 DPI, multiplier=1) ──────────────────────
const EPL_FONT_H = { 1: 8, 2: 11, 3: 16, 4: 20, 5: 48, 6: 19, 7: 28 };
const DPI   = 203;
const PT    = 72 / DPI;          // points per EPL dot (~0.3547)

// ── Parse EPL text ────────────────────────────────────────────────────────────
function parseEpl(src) {
  const lines  = src.split(/\r?\n/);
  let labelH   = 822;   // dots (Q command)
  let labelW   = 812;   // dots (~4 inches, standard DPD width)
  let refX     = 0;
  let bottomUp = false; // ZB flag

  const texts    = [];
  const barcodes = [];
  const boxes    = [];

  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line === 'N' || line === 'P1') continue;

    if (/^Q(\d+)/.test(line))  { labelH   = parseInt(line.slice(1)); continue; }
    if (/^R(\d+)/.test(line))  { refX     = parseInt(line.slice(1)); continue; }
    if (line === 'ZB')          { bottomUp = true; continue; }

    // A command: A<x>,<y>,<rot>,<font>,<hmul>,<vmul>,<rev>,"data"
    const am = line.match(/^A(-?\d+),(-?\d+),(\d),(\d+),(\d+),(\d+),([NR]),"(.*)"/);
    if (am) {
      const [, x, y, rot, font, hm, vm, rev, data] = am;
      if (data.trim()) {
        texts.push({
          x: parseInt(x) + refX,
          y: parseInt(y),
          rot: parseInt(rot),
          font: parseInt(font),
          hm: parseInt(hm),
          vm: parseInt(vm),
          rev: rev === 'R',
          data,
        });
      }
      continue;
    }

    // B command: B<x>,<y>,<rot>,<type>,<ns>,<ws>,<h>,<hr>,"data"
    const bm = line.match(/^B(-?\d+),(-?\d+),(\d+),(\d+),(\d+),(\d+),(\d+),([NB]),"(.*)"/);
    if (bm) {
      barcodes.push({
        x: parseInt(bm[1]) + refX,
        y: parseInt(bm[2]),
        rot: parseInt(bm[3]),
        ns: parseInt(bm[5]),
        ws: parseInt(bm[6]),
        h: parseInt(bm[7]),
        data: bm[9],
      });
      continue;
    }

    // LO command: LO<x>,<y>,<w>,<h>
    const lo = line.match(/^LO(-?\d+),(-?\d+),(\d+),(\d+)/);
    if (lo) {
      boxes.push({
        x: parseInt(lo[1]) + refX,
        y: parseInt(lo[2]),
        w: parseInt(lo[3]),
        h: parseInt(lo[4]),
      });
    }
  }

  return { labelH, labelW, bottomUp, texts, barcodes, boxes };
}

// ── Coordinate helpers ────────────────────────────────────────────────────────
// ZB mode: EPL y=0 is BOTTOM of label; higher y = higher on label.
// PDF: y=0 is BOTTOM of page. So EPL_y maps directly to PDF_y.
// EPL positions text at the TOP-LEFT corner of the glyph.
// PDF draws text at the BASELINE (bottom-left).
// So PDF baseline = (epl_y - font_height_dots) * PT

function eplToPdfCoords(ex, ey, fontH_dots, { labelH, bottomUp }) {
  const px = ex * PT;
  let   py;
  if (bottomUp) {
    // y=0 is bottom; text top is at ey dots from bottom; baseline is lower
    py = (ey - fontH_dots) * PT;
  } else {
    // y=0 is top; flip to PDF coords (y=0 = bottom)
    py = (labelH - ey - fontH_dots) * PT;
  }
  return { px, py };
}

// ── Main render ───────────────────────────────────────────────────────────────
export async function eplToPdf(eplSrc) {
  const parsed = parseEpl(eplSrc);
  const { labelH, labelW, bottomUp, texts, barcodes, boxes } = parsed;

  const W = labelW * PT;
  const H = labelH * PT;

  const pdfDoc = await PDFDocument.create();
  const page   = pdfDoc.addPage([W, H]);
  const fontR  = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const fontB  = await pdfDoc.embedFont(StandardFonts.HelveticaBold);

  // ── Draw border boxes / lines ─────────────────────────────────────────────
  for (const b of boxes) {
    const px = b.x * PT;
    const pw = b.w * PT;
    const ph = b.h * PT;
    let   py;
    if (bottomUp) {
      py = b.y * PT;
    } else {
      py = (labelH - b.y - b.h) * PT;
    }
    if (b.w <= 3 || b.h <= 3) {
      // Thin line
      if (b.w > b.h) {
        page.drawLine({ start: { x: px, y: py + ph / 2 }, end: { x: px + pw, y: py + ph / 2 }, thickness: Math.max(ph, 0.5), color: rgb(0, 0, 0) });
      } else {
        page.drawLine({ start: { x: px + pw / 2, y: py }, end: { x: px + pw / 2, y: py + ph }, thickness: Math.max(pw, 0.5), color: rgb(0, 0, 0) });
      }
    } else {
      page.drawRectangle({ x: px, y: py, width: pw, height: ph, color: rgb(0, 0, 0) });
    }
  }

  // ── Draw text ─────────────────────────────────────────────────────────────
  for (const t of texts) {
    const baseH   = EPL_FONT_H[t.font] || 12;
    const fontH_d = baseH * t.vm;
    const fontSize = Math.max(fontH_d * PT * 0.75, 4); // 75% of cell height for visual fit
    const f = fontSize > 7 ? fontB : fontR;

    if (t.rot === 0) {
      // Horizontal text
      const { px, py } = eplToPdfCoords(t.x, t.y, fontH_d, parsed);
      if (px < 0 || px > W || py < 0 || py > H) continue;
      try {
        page.drawText(t.data, { x: px, y: py, size: fontSize, font: f, color: rgb(0, 0, 0) });
      } catch (_) {}

    } else if (t.rot === 1) {
      // 90° CW — text reads top-to-bottom; EPL origin is at bottom-right of the text block
      // In PDF: rotate -90° around the draw point
      const fontW_d = baseH * t.hm; // approximate character width = height for square fonts
      let px, py;
      if (bottomUp) {
        px = (t.x + fontW_d) * PT;
        py = t.y * PT;
      } else {
        px = (t.x + fontW_d) * PT;
        py = (labelH - t.y) * PT;
      }
      if (px < 0 || px > W + 50) continue;
      try {
        page.drawText(t.data, { x: px, y: py, size: fontSize, font: f, color: rgb(0, 0, 0), rotate: degrees(-90) });
      } catch (_) {}

    } else if (t.rot === 2) {
      // 180° — rotated upside down
      const fontH_p = fontH_d * PT;
      let px, py;
      if (bottomUp) {
        px = t.x * PT;
        py = (t.y - fontH_d) * PT;
      } else {
        px = t.x * PT;
        py = (labelH - t.y - fontH_d) * PT;
      }
      try {
        page.drawText(t.data, { x: px + (fontR.widthOfTextAtSize(t.data, fontSize)), y: py + fontH_p, size: fontSize, font: f, color: rgb(0, 0, 0), rotate: degrees(180) });
      } catch (_) {}

    } else if (t.rot === 3) {
      // 270° CW (= 90° CCW)
      let px, py;
      if (bottomUp) {
        px = t.x * PT;
        py = t.y * PT;
      } else {
        px = t.x * PT;
        py = (labelH - t.y) * PT;
      }
      try {
        page.drawText(t.data, { x: px, y: py, size: fontSize, font: f, color: rgb(0, 0, 0), rotate: degrees(90) });
      } catch (_) {}
    }
  }

  // ── Draw barcodes ─────────────────────────────────────────────────────────
  for (const bc of barcodes) {
    try {
      const barH_pt = bc.h * PT;
      const barW_pt = Math.min(W - bc.x * PT - 10, (labelW - bc.x) * PT);

      const png = await bwipjs.toBuffer({
        bcid: 'code128',
        text: bc.data,
        scale: 4,
        height: Math.round(bc.h / DPI * 25.4), // mm
        includetext: false,
        padding: 0,
      });

      const img = await pdfDoc.embedPng(png);
      const { width: nw, height: nh } = img.scale(1);
      const displayW = Math.min(barW_pt, nw * (barH_pt / nh));
      const displayH = barH_pt;

      let px = bc.x * PT;
      let py;
      if (bottomUp) {
        py = (bc.y - bc.h) * PT;
      } else {
        py = (labelH - bc.y - bc.h) * PT;
      }

      page.drawImage(img, { x: px, y: py, width: displayW, height: displayH });
    } catch (e) {
      console.error('Barcode render error:', e.message);
    }
  }

  return Buffer.from(await pdfDoc.save());
}

// ── CLI entry point ───────────────────────────────────────────────────────────
const [,, inFile, outFile] = process.argv;

let eplSrc;
if (inFile && inFile !== '-') {
  eplSrc = readFileSync(inFile, 'utf8');
} else {
  // Read from stdin
  const chunks = [];
  process.stdin.on('data', d => chunks.push(d));
  await new Promise(r => process.stdin.on('end', r));
  eplSrc = Buffer.concat(chunks).toString('utf8');
}

const pdfBuf = await eplToPdf(eplSrc);

if (outFile) {
  writeFileSync(outFile, pdfBuf);
  console.log(`✅ Written to ${outFile}`);
} else {
  process.stdout.write(pdfBuf);
}
