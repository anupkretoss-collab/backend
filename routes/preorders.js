import express from 'express';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import { authenticateToken } from '../middleware/auth.js';
import {
  fetchPreorders,
  bulkTagOrders,
  bulkRemoveTag,
  markOrdersFulfilled,
  fetchOrdersByTag,
  fetchOrder,
} from '../services/shopify.js';
import { readLog, isDelayed } from '../services/delayedLog.js';
import { upsertOrder } from './orders.js';

const router = express.Router();

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Filtering logic — no AI, no Copilot.
 * Supports:
 *   - exactNames: array of exact product title strings (case-insensitive)
 *   - keywords:   array of free-text keywords (substring match, case-insensitive)
 *   - mode: 'exclude' (default) or 'include'
 */
function filterOrdersByVariety(orders, { exactNames = [], keywords = [], mode = 'exclude' } = {}) {
  const lowerExact = exactNames.map(n => n.toLowerCase().trim());
  const lowerKw = keywords.map(k => k.toLowerCase().trim()).filter(Boolean);

  return orders.filter(order => {
    const lineItemTitles = (order.line_items || []).map(li =>
      (li.title || '').toLowerCase().trim()
    );

    const matched = lineItemTitles.some(title => {
      const exactHit = lowerExact.some(name => title === name);
      const kwHit = lowerKw.some(kw => title.includes(kw));
      return exactHit || kwHit;
    });

    return mode === 'exclude' ? !matched : matched;
  });
}

/**
 * Limit orders per variety.
 * limits: [{ exactName?, keyword?, maxQty }]
 * Returns orders trimmed so that the net quantity per variety does not exceed maxQty.
 */
function limitVarietyQuantities(orders, limits = []) {
  if (!limits.length) return orders;

  // Track running totals per limit rule
  const counters = limits.map(() => 0);
  const result = [];

  for (const order of orders) {
    let include = true;
    const lineItems = order.line_items || [];

    for (let i = 0; i < limits.length; i++) {
      const { exactName, keyword, maxQty } = limits[i];
      const lowerExact = exactName?.toLowerCase().trim();
      const lowerKw = keyword?.toLowerCase().trim();

      const matchingQty = lineItems.reduce((sum, li) => {
        const title = (li.title || '').toLowerCase().trim();
        const hit = (lowerExact && title === lowerExact) || (lowerKw && title.includes(lowerKw));
        return hit ? sum + (li.quantity || 1) : sum;
      }, 0);

      if (matchingQty > 0 && counters[i] + matchingQty > maxQty) {
        include = false;
        break;
      }
      if (matchingQty > 0) counters[i] += matchingQty;
    }

    if (include) result.push(order);
  }

  return result;
}

/**
 * Remove orders that appear in the delayed shipping log.
 */
async function removeDelayedOrders(orders) {
  const log = await readLog();
  const delayedIds = new Set(log.map(e => String(e.orderId)));
  return orders.filter(o => !delayedIds.has(String(o.id)));
}

/**
 * Build a variety summary: { varietyTitle -> totalQty }
 */
function buildVarietySummary(orders) {
  const summary = {};
  for (const order of orders) {
    for (const li of (order.line_items || [])) {
      const title = li.title || 'Unknown';
      summary[title] = (summary[title] || 0) + (li.quantity || 1);
    }
  }
  return Object.entries(summary)
    .map(([variety, quantity]) => ({ variety, quantity }))
    .sort((a, b) => b.quantity - a.quantity);
}

/**
 * Determine shipping carrier from order tags / shipping lines.
 */
function getCarrier(order) {
  const tags = (order.tags || '').toLowerCase();
  const shippingLines = (order.shipping_lines || []).map(sl => (sl.title || '').toLowerCase());
  const allText = tags + ' ' + shippingLines.join(' ');

  if (allText.includes('dpd')) return 'DPD';
  if (allText.includes('royal mail') || allText.includes('rm ') || allText.includes('rm48') || allText.includes('rm24')) return 'Royal Mail';
  return 'Royal Mail'; // default
}

// ─── STEP 2 — Fetch & filter preorders ───────────────────────────────────────
// POST /api/preorders/filter
// Body: { type, dateFrom, dateTo, excludeExact, excludeKeywords }
router.post('/filter', authenticateToken, async (req, res) => {
  try {
    const {
      type = 'all',
      dateFrom,
      dateTo,
      excludeExact = [],
      excludeKeywords = [],
    } = req.body;

    let orders = await fetchPreorders({ type, dateFrom, dateTo });

    // Remove delayed orders (Step 4)
    orders = await removeDelayedOrders(orders);

    // Apply variety exclusion filters (Step 2)
    if (excludeExact.length || excludeKeywords.length) {
      orders = filterOrdersByVariety(orders, {
        exactNames: excludeExact,
        keywords: excludeKeywords,
        mode: 'exclude',
      });
    }

    // Sort by created_at ascending (oldest first)
    orders.sort((a, b) => new Date(a.created_at) - new Date(b.created_at));

    res.json({ orders, total: orders.length });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: err.message });
  }
});

// ─── STEP 3 — Slice a batch ───────────────────────────────────────────────────
// POST /api/preorders/batch
// Body: { orders (array), batchSize }
// Returns the first batchSize orders and the remainder
router.post('/batch', authenticateToken, (req, res) => {
  try {
    const { orders = [], batchSize = 50 } = req.body;
    const batch = orders.slice(0, batchSize);
    const remaining = orders.slice(batchSize);
    res.json({ batch, remaining, batchTotal: batch.length });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// ─── STEP 5 — Generate pick list & variety summary ────────────────────────────
// POST /api/preorders/picklist
// Body: { orders (array), limitRules (optional) }
router.post('/picklist', authenticateToken, (req, res) => {
  try {
    let { orders = [], limitRules = [] } = req.body;

    if (limitRules.length) {
      orders = limitVarietyQuantities(orders, limitRules);
    }

    const summary = buildVarietySummary(orders);
    const totalQty = summary.reduce((s, v) => s + v.quantity, 0);
    const orderNumbers = orders.map(o => o.order_number);

    res.json({ orders, summary, totalQty, orderNumbers });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// ─── STEP 6 — Re-filter after hort team feedback ──────────────────────────────
// POST /api/preorders/refilter
// Body: { orders, removeExact, removeKeywords, limitRules }
router.post('/refilter', authenticateToken, (req, res) => {
  try {
    let { orders = [], removeExact = [], removeKeywords = [], limitRules = [] } = req.body;

    if (removeExact.length || removeKeywords.length) {
      orders = filterOrdersByVariety(orders, {
        exactNames: removeExact,
        keywords: removeKeywords,
        mode: 'exclude',
      });
    }

    if (limitRules.length) {
      orders = limitVarietyQuantities(orders, limitRules);
    }

    const summary = buildVarietySummary(orders);
    const totalQty = summary.reduce((s, v) => s + v.quantity, 0);

    res.json({ orders, summary, totalQty });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// ─── STEP 7 — Generate packing slip HTML ─────────────────────────────────────
// POST /api/preorders/packingslip
// Body: { orders, shippingDate }
router.post('/packingslip', authenticateToken, (req, res) => {
  try {
    const { orders = [], shippingDate = '' } = req.body;

    const rows = orders.map(o => {
      const cust = o.customer
        ? `${o.customer.first_name || ''} ${o.customer.last_name || ''}`.trim()
        : 'Guest';
      const addr = o.shipping_address
        ? [o.shipping_address.address1, o.shipping_address.city, o.shipping_address.zip].filter(Boolean).join(', ')
        : '—';
      const items = (o.line_items || []).map(li => `${li.title} × ${li.quantity}`).join('<br>');
      const carrier = getCarrier(o);
      const note = o.note ? `<em style="color:#b45309">${o.note}</em>` : '—';

      return `<tr>
        <td>#${o.order_number}</td>
        <td>${cust}</td>
        <td>${addr}</td>
        <td>${items}</td>
        <td>${carrier}</td>
        <td>${note}</td>
      </tr>`;
    }).join('');

    const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<title>Packing Slip — ${shippingDate}</title>
<style>
  body { font-family: Arial, sans-serif; font-size: 12px; margin: 20px; }
  h1 { font-size: 16px; margin-bottom: 4px; }
  p  { margin: 0 0 12px; color: #555; }
  table { width: 100%; border-collapse: collapse; }
  th { background: #1e293b; color: #fff; padding: 8px 10px; text-align: left; font-size: 11px; }
  td { padding: 7px 10px; border-bottom: 1px solid #e2e8f0; vertical-align: top; }
  tr:nth-child(even) td { background: #f8fafc; }
  @media print { body { margin: 10px; } }
</style>
</head>
<body>
<h1>Preorder Packing Slip</h1>
<p>Shipping Date: <strong>${shippingDate}</strong> &nbsp;|&nbsp; Total Orders: <strong>${orders.length}</strong></p>
<table>
  <thead>
    <tr>
      <th>Order #</th><th>Customer</th><th>Address</th><th>Items</th><th>Carrier</th><th>Note</th>
    </tr>
  </thead>
  <tbody>${rows}</tbody>
</table>
</body>
</html>`;

    res.setHeader('Content-Type', 'text/html');
    res.send(html);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// ─── Shared CSV builder (exported for use in orders.js) ──────────────────────

function splitName(fullName) {
  const parts = (fullName || '').trim().split(' ');
  const last = parts.length > 1 ? parts.pop() : '';
  return { first: parts.join(' '), last };
}

function calcWeightG(lineItems) {
  const total = (lineItems || []).reduce((sum, li) => {
    const grams = li.grams > 0 ? li.grams : 999;
    return sum + grams * (li.quantity || 1);
  }, 0);
  return total || 999;
}

function csvEscape(val) {
  return `"${String(val || '').replace(/"/g, '""')}"`;
}

export function buildShippingCsv(orders, carrier) {
  if (carrier === 'Royal Mail') {
    const header = [
      'Order ID', 'E-mail', 'Shipping: first name', 'Shipping: last name',
      'Shipping Address', 'Shipping: address2', 'Shipping: city',
      'Shipping: state', 'Shipping: country', 'Shipping: zipcode',
      'Notes', 'Phone', 'Weight in g (to convert)', 'Weight', 'Package Size', 'Service Code',
    ].join(',');

    const rows = orders.map(o => {
      const a = o.shipping_address || {};
      const c = o.customer || {};
      const rawFirst = c.first_name || '';
      const rawLast = c.last_name || '';
      const { first, last } = (rawFirst || rawLast)
        ? { first: rawFirst, last: rawLast }
        : splitName(a.name);
      const weightG = calcWeightG(o.line_items);
      return [
        csvEscape(`#${o.order_number}`),
        csvEscape(c.email || o.email || ''),
        csvEscape(first),
        csvEscape(last),
        csvEscape(a.address1 || ''),
        csvEscape(a.address2 || ''),
        csvEscape(a.city || ''),
        csvEscape(a.province || ''),
        csvEscape(a.country || 'United Kingdom'),
        csvEscape(a.zip || ''),
        csvEscape(o.note || ''),
        csvEscape(a.phone || c.phone || ''),
        weightG,
        (weightG / 1000).toFixed(2),
        'Parcel',
        'TPS48',
      ].join(',');
    });

    return [header, ...rows].join('\n');
  }

  // DPD format — matches DPD Local import template
  // Service column added at end: "DPD Express Pack" or "DPD Parcel" based on Shopify order tags
  const header = [
    '#Order', 'e-mail', 'First name', 'Last name',
    'Address1', 'Address2', 'City', 'Country', 'Zip',
    'Order Notes', 'Phone', 'Weight (kg)', 'Service',
  ].join(',');

  const rows = orders.map(o => {
    const a = o.shipping_address || {};
    const c = o.customer || {};
    const rawFirst = c.first_name || '';
    const rawLast = c.last_name || '';
    const { first, last } = (rawFirst || rawLast)
      ? { first: rawFirst, last: rawLast }
      : splitName(a.name);
    const weightG = calcWeightG(o.line_items);
    const tags = (o.tags || '').toLowerCase();
    const service = tags.includes('dpd-parcel') ? 'DPD Parcel' : 'DPD Express Pack';
    return [
      csvEscape(`#${o.order_number}`),
      csvEscape(c.email || o.email || ''),
      csvEscape(first),
      csvEscape(last),
      csvEscape(a.address1 || ''),
      csvEscape(a.address2 || ''),
      csvEscape(a.city || ''),
      csvEscape(a.country || 'United Kingdom'),
      csvEscape(a.zip || ''),
      csvEscape(o.note || ''),
      csvEscape(a.phone || c.phone || ''),
      (weightG / 1000).toFixed(2),
      csvEscape(service),
    ].join(',');
  });

  return [header, ...rows].join('\n');
}

// ─── Shared Order Packing Slip builder (Shopify-style, no label area) ─────────

export function buildOrderPackingSlipHtml(orders) {
  const storeName = process.env.STORE_NAME || 'South Devon Chilli Farm';
  const storeAddr = process.env.STORE_ADDRESS || 'South Devon Chilli Farm, Wigford Cross, Loddiswell, Kingsbridge TQ7 4DX, United Kingdom';
  const storeEmail = process.env.STORE_EMAIL || 'orders@southdevonchillifarm.co.uk';
  const storeWebsite = process.env.STORE_WEBSITE || 'southdevonchillifarm.co.uk';
  const storeEori = process.env.STORE_EORI || 'GB885490630200';

  const pages = orders.map(o => {
    const c = o.customer || {};
    const sa = o.shipping_address || {};
    const ba = o.billing_address || sa;

    const fmtAddr = (addr) => [
      addr.name,
      addr.company,
      addr.address1,
      addr.address2,
      `${addr.city || ''}${addr.province ? ' ' + addr.province : ''} ${addr.zip || ''}`.trim(),
      addr.country,
    ].filter(Boolean).join('<br>');

    const phone = sa.phone || c.phone || '';
    const totalQty = (o.line_items || []).reduce((s, li) => s + (li.quantity || 1), 0);

    const itemRows = (o.line_items || []).map(li =>
      `<tr>
        <td class="item-name">${li.title}${li.variant_title && li.variant_title !== 'Default Title' ? ' — ' + li.variant_title : ''}</td>
        <td class="item-qty">${li.quantity} of ${totalQty}</td>
      </tr>`
    ).join('');

    const orderDate = o.created_at
      ? new Date(o.created_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })
      : '';

    return `
<div class="order-page">
  <div class="header-row">
    <span class="store-name">${storeName.toUpperCase()}</span>
    <div class="order-meta">
      <div>Order #${o.order_number}</div>
      <div>${orderDate}</div>
    </div>
  </div>
  <div class="address-row">
    <div class="address-block">
      <div class="address-label">SHIP TO</div>
      <div class="address-text">${fmtAddr(sa)}</div>
      ${phone ? `<div class="address-text">${phone}</div>` : ''}
    </div>
    <div class="address-block">
      <div class="address-label">BILL TO</div>
      <div class="address-text">${fmtAddr(ba)}</div>
    </div>
  </div>
  <hr>
  <table class="items-table">
    <thead>
      <tr><th class="item-name">ITEMS</th><th class="item-qty">QUANTITY</th></tr>
    </thead>
    <tbody>${itemRows}</tbody>
  </table>
  <hr>
  <div class="passport-section">
    <strong>UK Plant Passport</strong>
    <div>A Variety: see packet/label</div>
    <div>B 100561</div> 
    <div>C</div> 
    <div>D GB</div>
    <div>E</div>
  </div>
  <div class="footer">
    <div>Thank you for shopping with us!</div>
    <br>
    <div>${storeName}</div>
    <div>${storeAddr}</div>
    <div>${storeEmail}</div>
    <div>${storeWebsite}</div>
    <br>
    <div>EORI No: ${storeEori}</div>
  </div>
</div>`;
  }).join('\n');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Order Packing Slips</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: Arial, sans-serif; background: #f0f0f0; font-size: 10pt; }

  /* Screen: centre each slip as a card */
  .order-page {
    background: #fff;
    width: 100%;
    max-width: 680px;
    margin: 20px auto;
    padding: 15mm;
    border-radius: 4px;
    box-shadow: 0 2px 8px rgba(0,0,0,0.12);
  }

  /* Print: full A4, no card styling */
  @media print {
    body { background: #fff; }
    .order-page {
      box-shadow: none;
      border-radius: 0;
      margin: 0;
      padding: 0;
      max-width: 100%;
      width: 100%;
      page-break-after: always;
      min-height: 250mm;
    }
    @page { size: A4 portrait; margin: 15mm; }
  }

  .header-row { display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 5mm; flex-wrap: wrap; gap: 4px; }
  .store-name { font-size: 14pt; font-weight: bold; color: #000; }
  .order-meta { text-align: right; font-size: 9pt; color: #000; line-height: 1.6; }
  hr { border: none; border-top: 2px solid #000; margin: 4mm 0; }
  .address-row { display: flex; gap: 10mm; margin-bottom: 2mm; flex-wrap: wrap; }
  .address-block { flex: 1; min-width: 140px; }
  .address-label { font-weight: bold; font-size: 8pt; text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 2mm; color: #000; }
  .address-text { font-size: 9.5pt; line-height: 1.7; }
  .items-table { width: 100%; border-collapse: collapse; margin-bottom: 3mm; }
  .items-table th { font-weight: bold; font-size: 8pt; text-transform: uppercase; letter-spacing: 0.5px; padding: 2mm 0; color: #000; text-align: left; padding-bottom: 10px; }
  .items-table td { padding: 1.8mm 0; vertical-align: top; font-size: 9.5pt; }
  .item-name { width: 80%; }
  .item-qty { width: 20%; text-align: right; white-space: nowrap; }
  th.item-qty { text-align: right; }
  .passport-section { font-size: 9pt; line-height: 1.8; margin-bottom: 4mm; color: #333; }
  .footer { font-size: 9pt; text-align: center; color: #555; line-height: 1.8; }

  /* Print button — hidden when printing */
  .print-bar {
    position: fixed; top: 0; left: 0; right: 0;
    background: #1e293b; color: #fff;
    padding: 10px 20px;
    display: flex; align-items: center; justify-content: space-between;
    font-family: Arial, sans-serif; font-size: 13px;
    z-index: 100;
  }
  .print-bar button {
    background: #3b82f6; color: #fff; border: none; border-radius: 4px;
    padding: 7px 18px; font-size: 13px; cursor: pointer;
  }
  .print-bar button:hover { background: #2563eb; }
  body { padding-top: 48px; }
  @media print { .print-bar { display: none; } body { padding-top: 0; } }
</style>
</head>
<body>
<div class="print-bar">
  <span>Order Packing Slips — ${orders.length} order${orders.length !== 1 ? 's' : ''}</span>
  <button onclick="window.print()">🖨️ Print</button>
</div>
${pages}
</body>
</html>`;
}

// ─── Shared S/17 HTML builder (exported for use in orders.js) ────────────────

export function buildS17Html(orders, shippingDate) {
  const storeName = process.env.STORE_NAME || 'South Devon Chilli Farm';
  const storeAddr = process.env.STORE_ADDRESS || 'Wigford Cross, Loddiswell, Kingsbridge TQ7 4DX';
  const storeEmail = process.env.STORE_EMAIL || 'orders@sdcf.co.uk';
  const storeWebsite = process.env.STORE_WEBSITE || 'southdevonchillifarm.co.uk';
  const storeEori = process.env.STORE_EORI || 'GB885490630200';

  const pages = orders.map(o => {
    const c = o.customer || {};
    const sa = o.shipping_address || {};
    const ba = o.billing_address || sa;

    const fmtAddr = (addr) => [
      addr.name,
      addr.address1,
      addr.address2,
      addr.city,
      addr.province,
      addr.zip,
      addr.country,
    ].filter(Boolean).join('<br>');

    const phone = sa.phone || c.phone || ba.phone || '';
    const email = c.email || o.email || '';

    const itemRows = (o.line_items || []).map((li, idx, arr) =>
      `<tr>
        <td class="item-name">${li.title}${li.variant_title && li.variant_title !== 'Default Title' ? ' — ' + li.variant_title : ''}</td>
        <td class="item-qty">${li.quantity} of ${arr.reduce((s, x) => s + x.quantity, 0)}</td>
      </tr>`
    ).join('');

    const orderDate = o.created_at
      ? new Date(o.created_at).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' })
      : (shippingDate || '');

    return `
<div class="order-page">
  <div class="content-area">
    <div class="header-row">
      <span class="store-name">${storeName.toUpperCase()}</span>
      <span class="order-meta">Order #${o.order_number}&nbsp;&nbsp;${orderDate}</span>
    </div>
    <hr>
    <div class="address-row">
      <div class="address-block">
        <div class="address-label">SHIP TO</div>
        <div>${fmtAddr(sa)}</div>
        ${phone ? `<div>${phone}</div>` : ''}
      </div>
      <div class="address-block">
        <div class="address-label">BILL TO</div>
        <div>${fmtAddr(ba)}</div>
        ${email ? `<div>${email}</div>` : ''}
      </div>
    </div>
    <hr>
    <table class="items-table">
      <thead>
        <tr><th class="item-name">ITEMS</th><th class="item-qty">QUANTITY</th></tr>
      </thead>
      <tbody>${itemRows}</tbody>
    </table>
    ${o.note ? `<div class="note"><strong>Note:</strong> ${o.note}</div>` : ''}
    <hr>
    <div class="footer">
      <div>Thank you for shopping with us!</div>
      <div>${storeName}, ${storeAddr}, ${storeEmail}, ${storeWebsite}</div>
      <div>EORI No: ${storeEori}</div>
      <div class="passport">UK Plant Passport &nbsp; A Variety: see packet/label &nbsp; B 100561 &nbsp; C &nbsp; D GB &nbsp; E</div>
    </div>
  </div>
  <div class="label-area">Shipping label — attach here</div>
</div>`;
  }).join('\n');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>S/17 Packing Slips${shippingDate ? ' — ' + shippingDate : ''}</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: Arial, sans-serif; background: #fff; }

  @page { size: A4 portrait; margin: 0; }

  .order-page {
    width: 210mm;
    height: 297mm;
    page-break-after: always;
    display: flex;
    flex-direction: column;
  }

  .content-area {
    padding: 8mm 10mm 4mm;
    flex: 0 0 auto;
    max-height: 130mm;
    overflow: hidden;
    font-size: 9pt;
    line-height: 1.4;
  }

  .header-row {
    display: flex;
    justify-content: space-between;
    align-items: baseline;
    margin-bottom: 3mm;
  }
  .store-name { font-size: 11pt; font-weight: bold; }
  .order-meta { font-size: 9pt; color: #555; }

  hr { border: none; border-top: 1px solid #ccc; margin: 3mm 0; }

  .address-row { display: flex; gap: 6mm; margin-bottom: 3mm; }
  .address-block { flex: 1; }
  .address-label { font-weight: bold; font-size: 8pt; margin-bottom: 1mm; letter-spacing: 0.5px; }

  .items-table { width: 100%; border-collapse: collapse; margin-bottom: 2mm; }
  .items-table th { font-size: 8pt; font-weight: bold; text-align: left; padding-bottom: 1mm; letter-spacing: 0.5px; }
  .items-table td { font-size: 9pt; padding: 1mm 0; }
  .item-qty { text-align: right; white-space: nowrap; }
  .item-name { width: 85%; }

  .note { font-size: 8pt; color: #b45309; margin-top: 2mm; }

  .footer { font-size: 7pt; color: #666; line-height: 1.5; }
  .passport { margin-top: 1mm; }

  .label-area {
    flex: 1;
    border-top: 1.5px dashed #aaa;
    display: flex;
    align-items: center;
    justify-content: center;
    color: #bbb;
    font-size: 8pt;
    font-family: Arial, sans-serif;
    letter-spacing: 1px;
  }
</style>
</head>
<body>
${pages}
</body>
</html>`;
}

// ─── S/17 Integrated Label PDF builder ───────────────────────────────────────
// labelMap: Map<String(shopifyOrderId), Buffer> of per-order label PDFs
export async function buildS17Pdf(orders, labelMap = new Map()) {
  const MM = 2.8346; // 1mm → points

  function truncateText(text, maxW, font, size) {
    if (!text) return '';
    if (font.widthOfTextAtSize(text, size) <= maxW) return text;
    while (text.length > 1 && font.widthOfTextAtSize(text + '…', size) > maxW) {
      text = text.slice(0, -1);
    }
    return text + '…';
  }

  const pdfDoc = await PDFDocument.create();
  const regular = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const bold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);

  const storeName = process.env.STORE_NAME || 'South Devon Chilli Farm';
  const rawAddr = process.env.STORE_ADDRESS || 'South Devon Chilli Farm, Wigford Cross, Loddiswell, Kingsbridge TQ7 4DX, United Kingdom';
  const storeAddr = rawAddr.startsWith(storeName) ? rawAddr.slice(storeName.length).replace(/^,\s*/, '') : rawAddr;
  const storeEmail = process.env.STORE_EMAIL || 'orders@southdevonchillifarm.co.uk';
  const storeWebsite = process.env.STORE_WEBSITE || 'southdevonchillifarm.co.uk';
  const storeEori = process.env.STORE_EORI || 'GB885490630200';

  for (const order of orders) {
    const page = pdfDoc.addPage([210 * MM, 297 * MM]); // A4
    const W = page.getWidth();   // 595.28pt
    const H = page.getHeight();  // 841.89pt

    const ML = 10 * MM;       // left margin
    const MR = W - 10 * MM;  // right boundary
    const CW = MR - ML;       // content width

    // ── Packing slip content ──────────────────────────────────────
    const c = order.customer || {};
    const sa = order.shipping_address || {};
    const ba = order.billing_address || sa;

    const orderDate = order.created_at
      ? new Date(order.created_at).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' })
      : '';

    let y = H - 12 * MM;

    // Store name + order meta (order number and date on separate lines, right-aligned)
    page.drawText(storeName.toUpperCase(), { x: ML, y, size: 11, font: bold, color: rgb(0, 0, 0) });
    const orderRef = `Order #${order.order_number}`;
    page.drawText(orderRef, {
      x: MR - regular.widthOfTextAtSize(orderRef, 9), y: y + 0.5,
      size: 9, font: regular, color: rgb(0.35, 0.35, 0.35),
    });
    if (orderDate) {
      page.drawText(orderDate, {
        x: MR - regular.widthOfTextAtSize(orderDate, 9), y: y + 0.5 - 4 * MM,
        size: 9, font: regular, color: rgb(0.35, 0.35, 0.35),
      });
    }
    y -= 10 * MM;

    // page.drawLine({ start: { x: ML, y }, end: { x: MR, y }, thickness: 0.5, color: rgb(0, 0, 0) });
    y -= 5 * MM;

    // Addresses (two columns)
    const COL2X = ML + CW / 2;
    const COLW = CW / 2 - 3 * MM;
    const addrY = y;

    const drawAddrCol = (label, addr, phone, email, startX) => {
      let cy = addrY;
      page.drawText(label, { x: startX, y: cy, size: 8, font: bold, color: rgb(0, 0, 0) });
      cy -= 7 * MM;
      for (const line of [
        addr.name || '', addr.company || '',
        addr.address1 || '', addr.address2 || '',
        [addr.city, addr.province, addr.zip].filter(Boolean).join(', '),
        addr.country || '',
      ].filter(Boolean)) {
        page.drawText(truncateText(line, COLW, regular, 9), { x: startX, y: cy, size: 9, font: regular, color: rgb(0, 0, 0) });
        cy -= 4 * MM;
      }
      if (phone) { page.drawText(phone, { x: startX, y: cy, size: 8.5, font: regular, color: rgb(0, 0, 0) }); cy -= 4 * MM; }
      if (email) { page.drawText(truncateText(email, COLW, regular, 8), { x: startX, y: cy, size: 8, font: regular, color: rgb(0, 0, 0) }); cy -= 4 * MM; }
      return cy; // returns y after last line
    };

    const shipPhone = sa.phone || c.phone || '';
    const billEmail = c.email || order.email || '';
    const endShipY = drawAddrCol('SHIP TO', sa, shipPhone, '', ML);
    const endBillY = drawAddrCol('BILL TO', ba, '', billEmail, COL2X);
    y = Math.min(endShipY, endBillY) - 2 * MM;

    page.drawLine({ start: { x: ML, y }, end: { x: MR, y }, thickness: 2, color: rgb(0, 0, 0) });
    y -= 5 * MM;

    // Items table
    page.drawText('ITEMS', { x: ML, y, size: 8, font: bold, color: rgb(0, 0, 0) });
    page.drawText('QUANTITY', { x: MR - bold.widthOfTextAtSize('QUANTITY', 8), y, size: 8, font: bold, color: rgb(0, 0, 0) });
    y -= 3 * MM;
    y -= 4.5 * MM;

    const lineItems = order.line_items || [];
    const totalQty = lineItems.reduce((s, li) => s + (li.quantity || 1), 0);
    for (const li of lineItems) {
      const title = li.title + (li.variant_title && li.variant_title !== 'Default Title' ? ` — ${li.variant_title}` : '');
      const qtyStr = `${li.quantity} of ${totalQty}`;
      const qtyW = regular.widthOfTextAtSize(qtyStr, 9);
      page.drawText(truncateText(title, CW - qtyW - 5 * MM, regular, 9), { x: ML, y, size: 9, font: regular, color: rgb(0, 0, 0) });
      page.drawText(qtyStr, { x: MR - qtyW, y, size: 9, font: regular, color: rgb(0, 0, 0) });
      y -= 5 * MM;
    }

    // if (order.note) {
    //   page.drawText(truncateText(`Note: ${order.note}`, CW, regular, 8), { x: ML, y, size: 8, font: regular, color: rgb(0.6, 0.3, 0) });
    //   y -= 5 * MM;
    // }

    y -= 2 * MM;
    page.drawLine({ start: { x: ML, y }, end: { x: MR, y }, thickness: 2, color: rgb(0, 0, 0) });
    y -= 5 * MM;

    // UK Plant Passport
    page.drawText('UK Plant Passport', { x: ML, y, size: 8.5, font: bold, color: rgb(0, 0, 0) }); y -= 4 * MM;
    for (const line of ['A Variety: see packet/label', 'B 100561', 'C', 'D GB', 'E']) {
      page.drawText(line, { x: ML, y, size: 8, font: regular, color: rgb(0, 0, 0) }); y -= 4 * MM;
    }
    y -= 3 * MM;

    // Footer — compact when a shipping label will be embedded below, full otherwise
    const hasEmbeddedLabel = labelMap.has(String(order.id));

    if (!hasEmbeddedLabel) {
      // Full footer for standalone packing slips
      for (const line of ['Thank you for shopping with us!']) {
        const lw = regular.widthOfTextAtSize(line, 7.5);
        page.drawText(line, { x: ML + (CW - lw) / 2, y, size: 7.5, font: regular, color: rgb(0.4, 0.4, 0.4) });
        y -= 3.8 * MM;
      }
      y -= 3.8 * MM;
      for (const line of [storeName, storeAddr, storeEmail, storeWebsite]) {
        const lw = regular.widthOfTextAtSize(line, 7.5);
        page.drawText(line, { x: ML + (CW - lw) / 2, y, size: 7.5, font: regular, color: rgb(0.4, 0.4, 0.4) });
        y -= 3.8 * MM;
      }
      y -= 3.8 * MM;
      const eoriLine = `EORI No: ${storeEori}`;
      page.drawText(eoriLine, { x: ML + (CW - regular.widthOfTextAtSize(eoriLine, 7.5)) / 2, y, size: 7.5, font: regular, color: rgb(0.4, 0.4, 0.4) });
    } else {
      // Compact single-line footer — label takes the lower portion of this page
      const compactFooter = `${storeName}  |  EORI No: ${storeEori}`;
      const cfw = regular.widthOfTextAtSize(compactFooter, 7);
      page.drawText(compactFooter, { x: ML + (CW - cfw) / 2, y, size: 7, font: regular, color: rgb(0.4, 0.4, 0.4) });

      // ── Integrated Shipping Label area (S/17: 100mm × 150mm, 10mm margins) ───
      const LABEL_LEFT   = 10 * MM;
      const LABEL_BOTTOM = 10 * MM;
      const LABEL_W      = 100 * MM;
      const LABEL_H      = 150 * MM;
      const SEP_Y        = LABEL_BOTTOM + LABEL_H + 5 * MM; // separator 5mm above label

      // "Integrated Shipping Label" indicator text just above separator
      const sepText = '▼  INTEGRATED SHIPPING LABEL  ▼';
      const stw = regular.widthOfTextAtSize(sepText, 7);
      page.drawText(sepText, {
        x: ML + (CW - stw) / 2, y: SEP_Y + 2 * MM,
        size: 7, font: regular, color: rgb(0.45, 0.45, 0.45),
      });

      // Dashed separator line spanning full page width
      const dashLen = 4 * MM;
      const gapLen  = 2 * MM;
      let dX = 0;
      while (dX < W) {
        page.drawLine({
          start: { x: dX,                          y: SEP_Y },
          end:   { x: Math.min(dX + dashLen, W),   y: SEP_Y },
          thickness: 0.5,
          color: rgb(0.45, 0.45, 0.45),
        });
        dX += dashLen + gapLen;
      }

      // Embed RM label PDF in the label slot, scaled to fit
      const labelBuf = labelMap.get(String(order.id));
      if (labelBuf) {
        try {
          const [embeddedLabel] = await pdfDoc.embedPdf(labelBuf, [0]);
          const dims = embeddedLabel.size();
          const scaleX = LABEL_W / dims.width;
          const scaleY = LABEL_H / dims.height;
          const scale  = Math.min(scaleX, scaleY);
          const drawW  = dims.width  * scale;
          const drawH  = dims.height * scale;
          // Centre within the slot horizontally; align to bottom margin vertically
          const drawX = LABEL_LEFT + (LABEL_W - drawW) / 2;
          const drawY = LABEL_BOTTOM + (LABEL_H - drawH) / 2;
          page.drawPage(embeddedLabel, { x: drawX, y: drawY, width: drawW, height: drawH });
        } catch (_e) {
          // Fallback placeholder if embed fails
          page.drawRectangle({ x: LABEL_LEFT, y: LABEL_BOTTOM, width: LABEL_W, height: LABEL_H, borderColor: rgb(0.7, 0.7, 0.7), borderWidth: 0.5 });
          const ph = 'SHIPPING LABEL';
          page.drawText(ph, { x: LABEL_LEFT + (LABEL_W - regular.widthOfTextAtSize(ph, 9)) / 2, y: LABEL_BOTTOM + LABEL_H / 2 - 4, size: 9, font: regular, color: rgb(0.7, 0.7, 0.7) });
        }
      } else {
        // No label buffer — draw placeholder for manual label application
        page.drawRectangle({ x: LABEL_LEFT, y: LABEL_BOTTOM, width: LABEL_W, height: LABEL_H, borderColor: rgb(0.7, 0.7, 0.7), borderWidth: 0.5 });
        const ph = 'AFFIX SHIPPING LABEL HERE';
        page.drawText(ph, { x: LABEL_LEFT + (LABEL_W - regular.widthOfTextAtSize(ph, 8)) / 2, y: LABEL_BOTTOM + LABEL_H / 2 - 4, size: 8, font: regular, color: rgb(0.7, 0.7, 0.7) });
      }
    }
  }

  return pdfDoc.save();
}

// ─── 100mm × 150mm per-order record PDF ──────────────────────────────────────
// Two identical pages per order, each page is label-sized (100 × 150mm).
// Compact packing record — store name, order, address, items, passport, footer.
export async function buildRecordPdf(orders) {
  const MM = 2.8346;

  function tr(text, maxW, font, size) {
    if (!text) return '';
    if (font.widthOfTextAtSize(text, size) <= maxW) return text;
    while (text.length > 1 && font.widthOfTextAtSize(text + '…', size) > maxW) text = text.slice(0, -1);
    return text + '…';
  }

  const pdfDoc = await PDFDocument.create();
  const regular = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const bold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);

  const storeName = process.env.STORE_NAME || 'South Devon Chilli Farm';
  const storeAddr = process.env.STORE_ADDRESS || 'Wigford Cross, Loddiswell, Kingsbridge TQ7 4DX';
  const storeEmail = process.env.STORE_EMAIL || 'orders@sdcf.co.uk';
  const storeWebsite = process.env.STORE_WEBSITE || 'southdevonchillifarm.co.uk';
  const storeEori = process.env.STORE_EORI || 'GB885490630200';

  for (const order of orders) {
    {
      // 100mm × 150mm page
      const W = 100 * MM;  // 283.46pt
      const H = 150 * MM;  // 425.2pt
      const page = pdfDoc.addPage([W, H]);

      const ML = 5 * MM;
      const MR = W - 5 * MM;
      const CW = MR - ML;

      const c = order.customer || {};
      const sa = order.shipping_address || {};

      const orderDate = order.created_at
        ? new Date(order.created_at).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' })
        : '';

      let y = H - 7 * MM;

      // ── Store name + order number ──────────────────────────────
      page.drawText(tr(storeName.toUpperCase(), CW * 0.6, bold, 9), {
        x: ML, y, size: 9, font: bold, color: rgb(0, 0, 0),
      });
      const orderRef = `#${order.order_number}`;
      page.drawText(orderRef, {
        x: MR - bold.widthOfTextAtSize(orderRef, 9), y,
        size: 9, font: bold, color: rgb(0, 0, 0),
      });
      y -= 4 * MM;

      if (orderDate) {
        const dw = regular.widthOfTextAtSize(orderDate, 7.5);
        page.drawText(orderDate, { x: MR - dw, y, size: 7.5, font: regular, color: rgb(0.4, 0.4, 0.4) });
      }
      y -= 3 * MM;

      page.drawLine({ start: { x: ML, y }, end: { x: MR, y }, thickness: 0.5, color: rgb(0, 0, 0) });
      y -= 4 * MM;

      // ── Ship To ───────────────────────────────────────────────
      page.drawText('SHIP TO', { x: ML, y, size: 7, font: bold, color: rgb(0, 0, 0) });
      y -= 3.5 * MM;

      const phone = sa.phone || c.phone || '';
      const addrLines = [
        sa.name, sa.company, sa.address1, sa.address2,
        [sa.city, sa.province, sa.zip].filter(Boolean).join(', '),
        sa.country, phone,
      ].filter(Boolean);

      for (const line of addrLines) {
        page.drawText(tr(line, CW, regular, 8.5), { x: ML, y, size: 8.5, font: regular, color: rgb(0, 0, 0) });
        y -= 4 * MM;
      }
      y -= 1 * MM;

      page.drawLine({ start: { x: ML, y }, end: { x: MR, y }, thickness: 0.5, color: rgb(0, 0, 0) });
      y -= 4 * MM;

      // ── Items ─────────────────────────────────────────────────
      page.drawText('ITEMS', { x: ML, y, size: 7, font: bold, color: rgb(0, 0, 0) });
      page.drawText('QTY', { x: MR - bold.widthOfTextAtSize('QTY', 7), y, size: 7, font: bold, color: rgb(0, 0, 0) });
      y -= 3.5 * MM;

      const lineItems = order.line_items || [];
      const totalQty = lineItems.reduce((s, li) => s + (li.quantity || 1), 0);
      for (const li of lineItems) {
        const title = li.title + (li.variant_title && li.variant_title !== 'Default Title' ? ` — ${li.variant_title}` : '');
        const qtyStr = `${li.quantity}/${totalQty}`;
        const qw = regular.widthOfTextAtSize(qtyStr, 8);
        page.drawText(tr(title, CW - qw - 3 * MM, regular, 8), { x: ML, y, size: 8, font: regular, color: rgb(0, 0, 0) });
        page.drawText(qtyStr, { x: MR - qw, y, size: 8, font: regular, color: rgb(0, 0, 0) });
        y -= 4 * MM;
      }

      if (order.note) {
        page.drawText(tr(`Note: ${order.note}`, CW, regular, 7), { x: ML, y, size: 7, font: regular, color: rgb(0.6, 0.3, 0) });
        y -= 3.5 * MM;
      }
      y -= 1 * MM;

      page.drawLine({ start: { x: ML, y }, end: { x: MR, y }, thickness: 0.5, color: rgb(0, 0, 0) });
      y -= 3.5 * MM;

      // ── UK Plant Passport ─────────────────────────────────────
      page.drawText('UK Plant Passport  A Variety: see packet/label  B 100561  D GB', {
        x: ML, y, size: 6.5, font: regular, color: rgb(0, 0, 0),
      });
      y -= 4 * MM;

      page.drawLine({ start: { x: ML, y }, end: { x: MR, y }, thickness: 0.25, color: rgb(0.7, 0.7, 0.7) });
      y -= 3.5 * MM;

      // ── Footer ────────────────────────────────────────────────
      for (const line of [storeName, storeAddr, `${storeEmail}  |  ${storeWebsite}`, `EORI No: ${storeEori}`]) {
        const lw = regular.widthOfTextAtSize(line, 6);
        page.drawText(tr(line, CW, regular, 6), {
          x: ML + (CW - Math.min(lw, CW)) / 2, y,
          size: 6, font: regular, color: rgb(0.45, 0.45, 0.45),
        });
        y -= 3.2 * MM;
      }
    } // end copy loop
  } // end order loop

  return pdfDoc.save();
}

// ─── STEP 8 — Generate shipping CSV ──────────────────────────────────────────
// POST /api/preorders/shipping-csv
// Body: { orders, carrier: 'Royal Mail' | 'DPD', shippingDate }
router.post('/shipping-csv', authenticateToken, (req, res) => {
  try {
    const { orders = [], carrier = 'Royal Mail', shippingDate = '' } = req.body;

    const filtered = orders.filter(o => getCarrier(o) === carrier);
    const csv = buildShippingCsv(filtered, carrier);

    const filename = `${carrier.replace(' ', '_')}_${shippingDate.replace(/\//g, '-')}.csv`;
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(csv);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// ─── STEP 8b — Individual per-order S/17 packing slips ───────────────────────
// POST /api/preorders/s17-packingslips
// Body: { orders, shippingDate }
router.post('/s17-packingslips', authenticateToken, (req, res) => {
  try {
    const { orders = [], shippingDate = '' } = req.body;
    const html = buildS17Html(orders, shippingDate);
    res.setHeader('Content-Type', 'text/html');
    res.send(html);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// ─── STEP 9 — Bulk tag orders ─────────────────────────────────────────────────
// POST /api/preorders/tag
// Body: { orderIds, shippingDate }
router.post('/tag', authenticateToken, async (req, res) => {
  try {
    const { orderIds = [], shippingDate } = req.body;
    if (!shippingDate) return res.status(400).json({ message: 'shippingDate is required' });

    const tag = `SEND ${shippingDate}`;
    const results = await bulkTagOrders(orderIds, tag);
    const failed = results.filter(r => !r.success);

    res.json({
      tag,
      total: orderIds.length,
      succeeded: results.length - failed.length,
      failed: failed.length,
      errors: failed,
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// ─── STEP 10 — Mark orders as fulfilled ──────────────────────────────────────
// POST /api/preorders/fulfill
// Body: { orderIds, notifyCustomer }
router.post('/fulfill', authenticateToken, async (req, res) => {
  try {
    const { orderIds = [], notifyCustomer = true } = req.body;
    const results = await markOrdersFulfilled(orderIds, notifyCustomer);

    // Sync updated fulfilled orders into DB
    for (const result of results) {
      if (result.success) {
        try {
          const updatedOrder = await fetchOrder(result.id);
          await upsertOrder(updatedOrder);
        } catch (err) {
          console.error(
            `Failed to sync fulfilled order ${result.id}:`,
            err.message
          );
        }
      }
    }

    const failed = results.filter(r => !r.success);

    res.json({
      total: orderIds.length,
      succeeded: results.length - failed.length,
      failed: failed.length,
      errors: failed,
    });
  } catch (err) {
    console.error('Fulfillment error:', err);
    res.status(500).json({ message: err.message });
  }
});

// ─── Fetch orders by SEND tag ─────────────────────────────────────────────────
// GET /api/preorders/by-tag?tag=SEND+01/01/26
router.get('/by-tag', authenticateToken, async (req, res) => {
  try {
    const { tag } = req.query;
    if (!tag) return res.status(400).json({ message: 'tag is required' });
    const orders = await fetchOrdersByTag(tag);
    res.json({ orders, total: orders.length });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

export default router;
