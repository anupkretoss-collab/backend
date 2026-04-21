import express from 'express';
import { authenticateToken } from '../middleware/auth.js';
import {
  fetchPreorders,
  bulkTagOrders,
  bulkRemoveTag,
  markOrdersFulfilled,
  fetchOrdersByTag,
} from '../services/shopify.js';
import { readLog, isDelayed } from '../services/delayedLog.js';

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
  const lowerKw    = keywords.map(k => k.toLowerCase().trim()).filter(Boolean);

  return orders.filter(order => {
    const lineItemTitles = (order.line_items || []).map(li =>
      (li.title || '').toLowerCase().trim()
    );

    const matched = lineItemTitles.some(title => {
      const exactHit = lowerExact.some(name => title === name);
      const kwHit    = lowerKw.some(kw => title.includes(kw));
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
      const lowerKw    = keyword?.toLowerCase().trim();

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

// ─── STEP 8 — Generate shipping CSV ──────────────────────────────────────────
// POST /api/preorders/shipping-csv
// Body: { orders, carrier: 'Royal Mail' | 'DPD', shippingDate }
router.post('/shipping-csv', authenticateToken, (req, res) => {
  try {
    const { orders = [], carrier = 'Royal Mail', shippingDate = '' } = req.body;

    const filtered = orders.filter(o => getCarrier(o) === carrier);

    let csv = '';

    if (carrier === 'Royal Mail') {
      // RM 48hr format
      csv = 'Order Number,Name,Address Line 1,Address Line 2,City,County,Postcode,Country,Phone,Email,Weight,Service\n';
      csv += filtered.map(o => {
        const a = o.shipping_address || {};
        const c = o.customer || {};
        const name = a.name || `${c.first_name || ''} ${c.last_name || ''}`.trim();
        return [
          `#${o.order_number}`,
          `"${name}"`,
          `"${a.address1 || ''}"`,
          `"${a.address2 || ''}"`,
          `"${a.city || ''}"`,
          `"${a.province || ''}"`,
          `"${a.zip || ''}"`,
          `"${a.country || 'GB'}"`,
          `"${a.phone || c.phone || ''}"`,
          `"${c.email || ''}"`,
          '0.5',
          'CRL48',
        ].join(',');
      }).join('\n');
    } else {
      // DPD format
      csv = 'Order Number,Name,Address Line 1,Address Line 2,City,County,Postcode,Country,Phone,Email,Weight,Service\n';
      csv += filtered.map(o => {
        const a = o.shipping_address || {};
        const c = o.customer || {};
        const name = a.name || `${c.first_name || ''} ${c.last_name || ''}`.trim();
        return [
          `#${o.order_number}`,
          `"${name}"`,
          `"${a.address1 || ''}"`,
          `"${a.address2 || ''}"`,
          `"${a.city || ''}"`,
          `"${a.province || ''}"`,
          `"${a.zip || ''}"`,
          `"${a.country || 'GB'}"`,
          `"${a.phone || c.phone || ''}"`,
          `"${c.email || ''}"`,
          '0.5',
          'DPD',
        ].join(',');
      }).join('\n');
    }

    const filename = `${carrier.replace(' ', '_')}_${shippingDate.replace(/\//g, '-')}.csv`;
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(csv);
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
    const failed = results.filter(r => !r.success);

    res.json({
      total: orderIds.length,
      succeeded: results.length - failed.length,
      failed: failed.length,
      errors: failed,
    });
  } catch (err) {
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
