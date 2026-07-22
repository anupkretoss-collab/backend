import axios from 'axios';
import { PDFDocument, rgb, StandardFonts } from 'pdf-lib';
import bwipjs from 'bwip-js';
import { eplToPdf } from '../utils/epl-to-pdf.mjs';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { writeFile, readFile, unlink, chmod } from 'fs/promises';
import { fileURLToPath } from 'url';
import path from 'path';
import os from 'os';

const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// labelize binary — renders EPL exactly like a thermal printer (bitmap fonts)
const LABELIZE_BIN = path.join(
  __dirname, '..', 'bin',
  process.platform === 'win32' ? 'labelize.exe' : 'labelize'
);

/**
 * Render EPL/ZPL commands through labelize into a PNG buffer.
 */
async function labelizeRender(srcText, widthMm, heightMm, format = 'epl') {
  const stamp = `dpd-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const inFile  = path.join(os.tmpdir(), `${stamp}.${format}`);
  const outFile = path.join(os.tmpdir(), `${stamp}.png`);
  try {
    await writeFile(inFile, Buffer.from(srcText, 'latin1'));
    if (process.platform !== 'win32') {
      await chmod(LABELIZE_BIN, 0o755).catch(() => {});
    }
    await execFileAsync(LABELIZE_BIN, [
      'convert', inFile, '-f', format, '-t', 'png', '-o', outFile,
      '--width', String(widthMm), '--height', String(heightMm), '--dpmm', '8',
    ], { timeout: 15000 });
    return await readFile(outFile);
  } finally {
    unlink(inFile).catch(() => {});
    unlink(outFile).catch(() => {});
  }
}

/**
 * Convert EPL buffer to PDF using the labelize binary (pixel-perfect render).
 * DPD's real shipping label is a standard 102×152mm (4"×6") thermal label —
 * matches labelize's own default canvas size. The EPL's Q command gives the
 * true label length in dots (8 dots/mm here), so it's read directly rather
 * than assumed: a previous hardcoded 106×103mm canvas cropped/squashed labels
 * whose Q length didn't match, which is what caused DPD's test-pack scan
 * failures (undersized barcode, wrong stationery size).
 * Renders to PNG, then embeds scaled-up on a larger PDF page (A4 width) for easy printing.
 */
async function eplToPdfLabelize(eplBuf) {
  // labelize's own font doesn't match a real EPL thermal printer's dot-matrix face:
  //  - rotated (rot=1) text renders bold
  //  - large fonts (2-5) use smooth condensed letterforms instead of a blocky bitmap
  // We strip both out of the EPL and composite them ourselves: font 1 (small text)
  // renders fine through labelize as-is and is left alone.
  const eplRaw = eplBuf.toString('latin1');
  const refX = parseInt((eplRaw.match(/^R(\d+)/m) || [, '0'])[1]);
  const DPMM = 8;
  const LABEL_W_MM = 102; // fixed — DPD Local thermal roll width
  const qDots = parseInt((eplRaw.match(/^Q(\d+)/m) || [, ''])[1]);
  const LABEL_H_MM = qDots > 0 ? Math.ceil(qDots / DPMM) : 152; // 152mm = standard 6" length fallback
  const verticalTexts = []; // rot=1 {x, y, vm, text}
  const bigTexts = [];      // rot=0 all fonts {x, y, font, hm, vm, text} — rendered as bitmap for a uniform typeface

  const rawLines = eplRaw.split(/\r?\n/);
  const outLines = rawLines.map(line => {
    let m = line.match(/^A(-?\d+),(-?\d+),1,(\d+),(\d+),(\d+),[NR],"(.*)"/);
    if (m) {
      if (m[6].trim()) verticalTexts.push({ x: parseInt(m[1]) + refX, y: parseInt(m[2]), vm: parseInt(m[5]), text: m[6] });
      return '';
    }
    m = line.match(/^A(-?\d+),(-?\d+),0,(\d+),(\d+),(\d+),[NR],"(.*)"/);
    if (m) {
      let x = parseInt(m[1]);
      if (x <= 10) x += 8; // pad away from the left border
      const font = parseInt(m[3]);
      if (m[6].trim()) {
        bigTexts.push({ x: x + refX, y: parseInt(m[2]), font, hm: parseInt(m[4]), vm: parseInt(m[5]), text: m[6].replace(/\s+$/, '') });
      }
      return '';
    }
    return line;
  });

  const eplFixed = outLines.filter(Boolean).join('\n');
  let png = await labelizeRender(eplFixed, LABEL_W_MM, LABEL_H_MM);

  // Composite the stripped texts back in with an authentic dot-matrix bitmap font.
  if (verticalTexts.length || bigTexts.length) {
    try {
      const { PNG } = await import('pngjs');
      const { FONT8X8 } = await import('../utils/font8x8.mjs');
      const main = PNG.sync.read(png);

      // Real EPL2 built-in font cell size in dots (width × height) at multiplier 1
      const FONT_CELL = {
        1: { w: 7,  h: 11 },
        2: { w: 11, h: 16 },
        3: { w: 12, h: 20 },
        4: { w: 14, h: 24 },
        5: { w: 32, h: 48 },
      };

      const setBlackPx = (img, x, y) => {
        if (x < 0 || y < 0 || x >= img.width || y >= img.height) return;
        const i = ((y * img.width + x) << 2);
        img.data[i] = 0; img.data[i + 1] = 0; img.data[i + 2] = 0; img.data[i + 3] = 255;
      };

      // Draw one glyph from the 8x8 source bitmap scaled up to gw×gh dots, nearest-neighbour
      // (keeps the blocky/pixelated look of a real low-res thermal font).
      const drawGlyph = (img, code, dx, dy, gw, gh) => {
        const glyph = FONT8X8[code] || FONT8X8[63];
        for (let gy = 0; gy < gh; gy++) {
          const row = glyph[(gy * 8 / gh) | 0];
          if (!row) continue;
          for (let gx = 0; gx < gw; gx++) {
            if (row & (1 << ((gx * 8 / gw) | 0))) setBlackPx(img, dx + gx, dy + gy);
          }
        }
      };

      for (const t of bigTexts) {
        const cell = FONT_CELL[t.font] || FONT_CELL[4];
        const pitch = cell.w * t.hm;
        const gw = Math.round(pitch * 0.9), gh = cell.h * t.vm;
        for (let i = 0; i < t.text.length; i++) {
          const code = t.text.charCodeAt(i);
          if (code !== 32) drawGlyph(main, code < 128 ? code : 63, t.x + i * pitch, t.y, gw, gh);
        }
      }

      if (verticalTexts.length) {
      const rowH = 24;
      const glyphH = 9; // font 1 glyph height + 1px pad
      const textLeft = 8;
      const canvasH = verticalTexts.length * rowH + rowH;
      const eplRows = ['N', `Q${canvasH},24`];
      verticalTexts.forEach((t, i) => {
        eplRows.push(`A${textLeft},${8 + i * rowH},0,1,1,${t.vm || 1},N,"${t.text.replace(/"/g, "'")}"`);
      });
      eplRows.push('P1');
      const rowPngBuf = await labelizeRender(eplRows.join('\n'), 106, Math.ceil(canvasH / 8) + 2);
      const rows = PNG.sync.read(rowPngBuf);

      const isBlack = (img, x, y) =>
        x >= 0 && y >= 0 && x < img.width && y < img.height && img.data[((y * img.width + x) << 2)] < 128;
      const setBlack = (img, x, y) => {
        if (x < 0 || y < 0 || x >= img.width || y >= img.height) return;
        const i = ((y * img.width + x) << 2);
        img.data[i] = 0; img.data[i + 1] = 0; img.data[i + 2] = 0; img.data[i + 3] = 255;
      };

      verticalTexts.forEach((t, i) => {
        const rowTop = 8 + i * rowH;
        const textW = t.text.length * 7 + 6; // generous glyph-width estimate
        // Rotate 90° CW: glyph column extends LEFT of the EPL anchor x (printer behaviour)
        for (let sy = rowTop - 1; sy < rowTop + glyphH + 1; sy++) {
          for (let sx = textLeft - 1; sx < textLeft + textW; sx++) {
            if (!isBlack(rows, sx, sy)) continue;
            const dx = (t.x - glyphH) + (rowTop + glyphH - sy);
            const dy = t.y + (sx - textLeft);
            setBlack(main, dx, dy);
          }
        }
      });
      }

      png = PNG.sync.write(main);
    } catch (e) {
      console.warn('[DPD] Vertical text composite failed:', e.message);
    }
  }

  if (process.env.DPD_DEBUG_PNG) {
    await writeFile(process.env.DPD_DEBUG_PNG, png).catch(() => {});
  }

  // Upscale 3× with nearest-neighbour so text stays sharp when printed at A4 width.
  // (labelize renders at native 203dpi ≈ 816px — too soft when stretched to A4.)
  try {
    const { PNG } = await import('pngjs');
    const src = PNG.sync.read(png);
    const S = 3;
    const dst = new PNG({ width: src.width * S, height: src.height * S });
    const rowBytes = dst.width << 2;
    const row = Buffer.allocUnsafe(rowBytes);
    for (let sy = 0; sy < src.height; sy++) {
      // Expand one source row horizontally
      for (let sx = 0; sx < src.width; sx++) {
        const si = (sy * src.width + sx) << 2;
        for (let r = 0; r < S; r++) {
          src.data.copy(row, ((sx * S + r) << 2), si, si + 4);
        }
      }
      // Stamp it S times vertically
      for (let r = 0; r < S; r++) {
        row.copy(dst.data, (sy * S + r) * rowBytes);
      }
    }
    png = PNG.sync.write(dst);
  } catch (e) {
    console.warn('[DPD] PNG upscale skipped:', e.message);
  }

  // PDF page = label size (LABEL_W_MM × LABEL_H_MM) + small top margin so the
  // top border line doesn't sit on the page edge
  const MM = 72 / 25.4;
  const topMargin = 4 * MM;
  const labelW = LABEL_W_MM * MM, labelH = LABEL_H_MM * MM;
  const pageW = labelW, pageH = labelH + topMargin;

  const pdfDoc = await PDFDocument.create();
  const page = pdfDoc.addPage([pageW, pageH]);
  const img = await pdfDoc.embedPng(png);

  page.drawImage(img, { x: 0, y: 0, width: labelW, height: labelH });

  return Buffer.from(await pdfDoc.save());
}

const BASE = process.env.DPD_API_URL || 'https://api.dpdlocal.co.uk';

// Cached auth session
let _token = null;
let _accountNumber = null;
let _tokenExpiry = 0;

function _parseAccountFromJwt(jwt) {
  try {
    const payload = jwt.split('.')[1];
    const decoded = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    return decoded.dpd_account || String(decoded.user_id || '').split('_')[1] || null;
  } catch {
    return null;
  }
}

async function authenticate() {
  if (_token && Date.now() < _tokenExpiry) {
    return { token: _token, accountNumber: _accountNumber };
  }

  const basic = Buffer.from(
    `${process.env.DPD_USERNAME}:${process.env.DPD_PASSWORD}`
  ).toString('base64');

  const { data } = await axios.post(
    `${BASE}/user/?action=login`,
    {},
    { headers: { 'Content-Type': 'application/json', Accept: 'application/json', Authorization: `Basic ${basic}` } }
  );

  _token = data.data?.geoSession;
  _accountNumber = _parseAccountFromJwt(_token);
  _tokenExpiry = Date.now() + 3 * 60 * 60 * 1000; // 3h
  console.log(`[DPD] Authenticated — accountNumber: ${_accountNumber}`);
  return { token: _token, accountNumber: _accountNumber };
}

function authHeaders(token, accountNumber) {
  return {
    'Content-Type': 'application/json',
    Accept: 'application/json',
    GeoClient: `account/${accountNumber}`,
    GeoSession: token,
  };
}

// Determine DPD service from Shopify order tags
// dpd-parcel tag → heavy parcel service; default → Express Pack
function getNetworkCode(order) {
  const tags = (order.tags || '').toLowerCase();
  if (tags.includes('dpd-parcel')) {
    return process.env.DPD_PARCEL_NETWORK || '2^12';
  }
  return process.env.DPD_EXPRESSPACK_NETWORK || '2^17';
}

function getDpdServiceLabel(order) {
  const tags = (order.tags || '').toLowerCase();
  return tags.includes('dpd-parcel') ? 'DPD Parcel' : 'DPD Express Pack';
}

function calcWeightKg(lineItems = []) {
  const totalG = lineItems.reduce((sum, li) => {
    return sum + (li.grams > 0 ? li.grams : 999) * (li.quantity || 1);
  }, 0);
  return Math.max((totalG || 999) / 1000, 0.1);
}

/**
 * Create a single DPD shipment via DPD Local API.
 * Returns { consignmentNumber, trackingNumber, status, service, orderNumber }
 */
export async function createShipment(order, despatchDate) {
  const { token, accountNumber } = await authenticate();
  const a = order.shipping_address || {};
  const c = order.customer || {};
  const weightKg = calcWeightKg(order.line_items || []);
  const networkCode = getNetworkCode(order);

  const collectionPostcode = (process.env.STORE_POSTCODE || 'TQ7 4DX').replace(/\s/g, '');
  const collectionAddr = (process.env.STORE_ADDRESS || 'South Devon Chilli Farm, Wigford Cross, Loddiswell, Kingsbridge TQ7 4DX, United Kingdom').split(',');

  const payload = {
    jobId: null,
    collectionOnDelivery: false,
    invoice: null,
    collectionDate: `${despatchDate || new Date().toISOString().slice(0, 10)}T00:00:00`,
    consolidate: false,
    consignment: [
      {
        consignmentNumber: null,
        consignmentRef: `#${order.order_number}`,
        parcels: [{ packageNumber: 1, weight: weightKg }],
        collectionDetails: {
          contactDetails: {
            contactName: process.env.STORE_NAME || 'South Devon Chilli Farm',
            telephone: (process.env.STORE_PHONE || '').replace(/\s/g, ''),
          },
          address: {
            organisation: process.env.STORE_NAME || 'South Devon Chilli Farm',
            street: collectionAddr[0]?.trim() || '',
            locality: collectionAddr[1]?.trim() || '',
            town: collectionAddr[2]?.trim() || 'Kingsbridge',
            county: 'Devon',
            postcode: collectionPostcode,
            countryCode: 'GB',
          },
        },
        deliveryDetails: {
          contactDetails: {
            contactName: a.name || `${c.first_name || ''} ${c.last_name || ''}`.trim() || 'Unknown',
            telephone: (a.phone || c.phone || '').replace(/\s/g, ''),
          },
          address: {
            organisation: a.company || '',
            street: a.address1 || '',
            locality: a.address2 || '',
            town: a.city || '',
            county: a.province || '',
            postcode: (a.zip || '').replace(/\s/g, ''),
            countryCode: (a.country_code || 'GB').toUpperCase().slice(0, 2),
          },
          notificationDetails: {
            mobile: (a.phone || c.phone || '').replace(/\s/g, ''),
            email: c.email || order.email || '',
          },
        },
        networkCode,
        numberOfParcels: 1,
        totalWeight: weightKg,
        shippingRef1: `#${order.order_number}`,
        shippingRef2: null,
        shippingRef3: null,
        customsValue: null,
        deliveryInstructions: order.note || null,
      },
    ],
  };

  console.log(`[DPD] Creating shipment #${order.order_number} | network: ${networkCode} | ${weightKg}kg`);

  const { data } = await axios.post(`${BASE}/shipping/shipment`, payload, {
    headers: authHeaders(token, accountNumber),
    timeout: 20000,
  });

  const shipmentId = String(data.data?.shipmentId || '');
  const detail = data.data?.consignmentDetail?.[0];
  const consignmentNumber = detail?.consignmentNumber || shipmentId;
  const parcelNumber = detail?.parcelNumbers?.[0] || consignmentNumber;

  console.log(`[DPD] Parsed — shipmentId: ${shipmentId} | consignmentNumber: ${consignmentNumber} | parcelNumber: ${parcelNumber}`);

  // A 200 response with no usable identifier usually means DPD accepted the
  // request but couldn't actually book it (e.g. the network/service code
  // isn't enabled on this account) — dump the raw response so the real
  // reason is visible in the logs instead of just an empty-looking result.
  if (!consignmentNumber) {
    console.error(`[DPD] No consignmentNumber/shipmentId returned for #${order.order_number} (network: ${networkCode}). Raw response:`, JSON.stringify(data));
  }
  if (detail?.errors?.length) {
    console.error(`[DPD] consignmentDetail returned errors for #${order.order_number}:`, JSON.stringify(detail.errors));
  }

  return {
    shipmentId,
    consignmentNumber,
    trackingNumber: parcelNumber,
    status: 'created',
    service: getDpdServiceLabel(order),
    shopifyOrderId: order.id,
    orderNumber: order.order_number,
  };
}

/**
 * Generate a DPD-style label PDF using shipment data.
 * Used when the DPD API returns EPL (thermal) format instead of PDF.
 */
async function generateLabelPdf(consignmentNumber, parcelNumber, orderData = {}) {
  const a = orderData.shipping_address || {};
  const c = orderData.customer || {};
  const toName    = a.name || `${c.first_name || ''} ${c.last_name || ''}`.trim() || 'Customer';
  const toAddr1   = a.address1 || '';
  const toAddr2   = a.address2 || '';
  const toCity    = a.city || '';
  const toZip     = (a.zip || '').toUpperCase();
  const toCountry = a.country_code || 'GB';
  const service   = getDpdServiceLabel(orderData);
  const orderRef  = `#${orderData.order_number || ''}`;
  const storeName = process.env.STORE_NAME || 'South Devon Chilli Farm';
  const storeZip  = process.env.STORE_POSTCODE || 'TQ7 4DX';

  // High-quality barcode: render at 600dpi equivalent, no stretching
  const barcodeText = parcelNumber || consignmentNumber;
  const barcodePng = await bwipjs.toBuffer({
    bcid: 'code128',
    text: barcodeText,
    scale: 4,        // 4px per module — sharp at label scale
    height: 15,      // mm height of barcode bars
    includetext: false, // draw text separately for control
    padding: 0,
  });

  // A6 label: 105mm × 148mm in points (1pt = 1/72 inch; 1mm = 2.835pt)
  const MM = 2.835;
  const W = 105 * MM;  // 297.7pt
  const H = 148 * MM;  // 419.6pt
  const PAD = 8 * MM;

  const pdfDoc = await PDFDocument.create();
  const page   = pdfDoc.addPage([W, H]);
  const bold   = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
  const reg    = await pdfDoc.embedFont(StandardFonts.Helvetica);

  // Embed barcode — maintain natural aspect ratio, don't stretch
  const barcodeImg  = await pdfDoc.embedPng(barcodePng);
  const { width: bW, height: bH } = barcodeImg.scale(1);
  const barcodeDisplayW = W - PAD * 2;
  const barcodeDisplayH = (bH / bW) * barcodeDisplayW;

  const lineH = 3.8 * MM;

  // ── Header ──────────────────────────────────────────────────────────────────
  const headerH = 10 * MM;
  page.drawRectangle({ x: 0, y: H - headerH, width: W, height: headerH, color: rgb(0.18, 0.40, 0.75) });
  page.drawText('DPD', { x: PAD, y: H - headerH + 3 * MM, size: 14, font: bold, color: rgb(1,1,1) });
  page.drawText(service, { x: PAD + 18 * MM, y: H - headerH + 3 * MM, size: 9, font: reg, color: rgb(1,1,1) });
  const refW = reg.widthOfTextAtSize(orderRef, 8);
  page.drawText(orderRef, { x: W - PAD - refW, y: H - headerH + 3 * MM, size: 8, font: reg, color: rgb(0.85,0.85,0.85) });

  // ── FROM ────────────────────────────────────────────────────────────────────
  let y = H - headerH - 4 * MM;
  page.drawText('FROM', { x: PAD, y, size: 6, font: bold, color: rgb(0.5,0.5,0.5) });
  y -= lineH;
  page.drawText(storeName, { x: PAD, y, size: 8, font: bold, color: rgb(0,0,0) });
  y -= lineH * 0.85;
  page.drawText(storeZip,  { x: PAD, y, size: 8, font: reg,  color: rgb(0,0,0) });

  // ── Divider ─────────────────────────────────────────────────────────────────
  y -= 3 * MM;
  page.drawLine({ start: { x: 0, y }, end: { x: W, y }, thickness: 1, color: rgb(0,0,0) });
  y -= 4 * MM;

  // ── TO ──────────────────────────────────────────────────────────────────────
  page.drawText('DELIVER TO', { x: PAD, y, size: 6, font: bold, color: rgb(0.5,0.5,0.5) });
  y -= lineH;
  page.drawText(toName,  { x: PAD, y, size: 12, font: bold, color: rgb(0,0,0) }); y -= lineH * 1.1;
  if (toAddr1) { page.drawText(toAddr1, { x: PAD, y, size: 9, font: reg, color: rgb(0,0,0) }); y -= lineH; }
  if (toAddr2) { page.drawText(toAddr2, { x: PAD, y, size: 9, font: reg, color: rgb(0,0,0) }); y -= lineH; }
  if (toCity)  { page.drawText(toCity,  { x: PAD, y, size: 9, font: reg, color: rgb(0,0,0) }); y -= lineH; }
  if (toZip) {
    page.drawText(toZip, { x: PAD, y, size: 14, font: bold, color: rgb(0,0,0) }); y -= lineH * 1.2;
  }
  if (toCountry !== 'GB') {
    page.drawText(toCountry, { x: PAD, y, size: 8, font: reg, color: rgb(0.3,0.3,0.3) }); y -= lineH;
  }

  // ── Barcode ─────────────────────────────────────────────────────────────────
  y -= 3 * MM;
  page.drawLine({ start: { x: 0, y }, end: { x: W, y }, thickness: 1, color: rgb(0,0,0) });
  y -= 3 * MM;

  // Centre barcode horizontally
  const barcodeX = (W - barcodeDisplayW) / 2;
  page.drawImage(barcodeImg, { x: barcodeX, y: y - barcodeDisplayH, width: barcodeDisplayW, height: barcodeDisplayH });
  y -= barcodeDisplayH + 2 * MM;

  // Barcode number in large bold text below bars
  const barcodeTextW = bold.widthOfTextAtSize(barcodeText, 9);
  page.drawText(barcodeText, { x: (W - barcodeTextW) / 2, y, size: 9, font: bold, color: rgb(0,0,0) });
  y -= lineH;

  // Consignment ref small
  const cnText = `Consignment: ${consignmentNumber}`;
  const cnW = reg.widthOfTextAtSize(cnText, 7);
  page.drawText(cnText, { x: (W - cnW) / 2, y, size: 7, font: reg, color: rgb(0.4,0.4,0.4) });

  return Buffer.from(await pdfDoc.save());
}

/**
 * Fetch raw EPL label from DPD API (for thermal printers).
 * Returns a Buffer of EPL bytes.
 */
export async function getLabelEpl(consignmentNumber, shipmentId) {
  const { token, accountNumber } = await authenticate();
  const headers = authHeaders(token, accountNumber);
  if (!shipmentId) throw new Error('shipmentId required for EPL download');
  const { data } = await axios.get(
    `${BASE}/shipping/shipment/${shipmentId}/label`,
    { headers: { ...headers, Accept: '*/*' }, responseType: 'arraybuffer' }
  );
  return Buffer.from(data);
}

/**
 * Fetch label PDF for a DPD consignment.
 * Returns a Buffer containing PDF bytes.
 */
export async function getLabel(consignmentNumber, shipmentId, orderData) {
  const { token, accountNumber } = await authenticate();
  const headers = authHeaders(token, accountNumber);

  if (!shipmentId) throw new Error('shipmentId required to fetch DPD label');

  // DPD Local account returns EPL thermal format — fetch directly, no wasted PDF attempts
  const url = `${BASE}/shipping/shipment/${shipmentId}/label`;
  console.log(`[DPD] Fetching label: GET ${url}`);

  const { data, headers: rh } = await axios.get(url, {
    headers: { ...headers, Accept: '*/*' },
    responseType: 'arraybuffer',
    timeout: 15000,
  });

  const buf = Buffer.from(data);
  const ct = rh['content-type'] || '';
  console.log(`[DPD] Label response: ${ct} | ${buf.length} bytes`);

  if (buf.slice(0, 4).toString() === '%PDF') return buf;

  // EPL thermal format → convert to PDF (labelize = pixel-perfect thermal render)
  try {
    console.log('[DPD] Converting EPL → PDF via labelize');
    return await eplToPdfLabelize(buf);
  } catch (err) {
    console.warn(`[DPD] labelize failed (${err.message}) — falling back to JS renderer`);
    return await eplToPdf(buf.toString('latin1'));
  }
}

/**
 * Merge an array of PDF Buffers into a single PDF.
 */
export async function mergeLabels(pdfBuffers) {
  const merged = await PDFDocument.create();
  for (const buf of pdfBuffers) {
    try {
      const src = await PDFDocument.load(buf);
      const pages = await merged.copyPages(src, src.getPageIndices());
      pages.forEach(p => merged.addPage(p));
    } catch {
      // skip malformed
    }
  }
  return Buffer.from(await merged.save());
}

export function isConfigured() {
  return Boolean(process.env.DPD_USERNAME && process.env.DPD_PASSWORD);
}

/**
 * Resolve the full tracking parcelCode (e.g. "15976709918193*21379") for a
 * parcel number + delivery postcode, via DPD Local's public tracking-site API
 * (the same call the "Enter reference number and postcode" form on
 * track.dpdlocal.co.uk makes). No auth required. Returns null on failure.
 *
 * The parcel isn't always indexed on the public tracking site the instant a
 * shipment is created — confirmed in production logs to sometimes take
 * several minutes, not seconds — so this retries several times before giving
 * up. Called right after label creation during auto-fulfil, which already
 * runs in the background after the PDF response is sent, so a longer retry
 * budget here costs nothing user-facing; an empty result just leaves
 * Shopify's tracking_url pointing at the DPD homepage instead of the direct
 * parcel link.
 */
export async function getDpdParcelCode(parcelNumber, postcode, { retries = 5, delayMs = 5000 } = {}) {
  if (!parcelNumber || !postcode) return null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const { data } = await axios.get('https://apis.track.dpdlocal.co.uk/v1/reference', {
        params: { origin: 'PRTK', postcode, referenceNumber: parcelNumber },
        headers: { Accept: 'application/json' },
        timeout: 8000,
      });
      const parcelCode = data?.data?.[0]?.parcelCode || null;
      if (parcelCode) return parcelCode;
    } catch (err) {
      console.warn(`[DPD] Tracking parcelCode lookup failed for ${parcelNumber} (attempt ${attempt + 1}/${retries + 1}):`, err.message);
    }
    if (attempt < retries) await new Promise(r => setTimeout(r, delayMs));
  }
  console.warn(`[DPD] Giving up on parcelCode for ${parcelNumber} after ${retries + 1} attempts — tracking_url will fall back to the DPD homepage.`);
  return null;
}
