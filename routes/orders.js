import express from 'express';
import { authenticateToken } from '../middleware/auth.js';
import { fetchShopifyOrders } from '../services/shopify.js';
import pool from '../services/db.js';

const router = express.Router();

// ─── Upsert a single Shopify order into MySQL ─────────────────────────────────
async function upsertOrder(order) {
  const c = order.customer || {};
  const a = order.shipping_address || {};

  await pool.query(
    `INSERT INTO orders (
      id, order_number, email, financial_status, fulfillment_status,
      total_price, currency, tags, note,
      customer_id, customer_first_name, customer_last_name, customer_email, customer_phone,
      shipping_name, shipping_address1, shipping_address2, shipping_city,
      shipping_province, shipping_zip, shipping_country, shipping_phone,
      line_items, shipping_lines, raw_data, created_at, updated_at
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON DUPLICATE KEY UPDATE
      order_number        = VALUES(order_number),
      email               = VALUES(email),
      financial_status    = VALUES(financial_status),
      fulfillment_status  = VALUES(fulfillment_status),
      total_price         = VALUES(total_price),
      currency            = VALUES(currency),
      tags                = VALUES(tags),
      note                = VALUES(note),
      customer_id         = VALUES(customer_id),
      customer_first_name = VALUES(customer_first_name),
      customer_last_name  = VALUES(customer_last_name),
      customer_email      = VALUES(customer_email),
      customer_phone      = VALUES(customer_phone),
      shipping_name       = VALUES(shipping_name),
      shipping_address1   = VALUES(shipping_address1),
      shipping_address2   = VALUES(shipping_address2),
      shipping_city       = VALUES(shipping_city),
      shipping_province   = VALUES(shipping_province),
      shipping_zip        = VALUES(shipping_zip),
      shipping_country    = VALUES(shipping_country),
      shipping_phone      = VALUES(shipping_phone),
      line_items          = VALUES(line_items),
      shipping_lines      = VALUES(shipping_lines),
      raw_data            = VALUES(raw_data),
      updated_at          = VALUES(updated_at),
      synced_at           = CURRENT_TIMESTAMP`,
    [
      order.id,
      order.order_number,
      order.email || null,
      order.financial_status || null,
      order.fulfillment_status || null,
      parseFloat(order.total_price || 0),
      order.currency || null,
      order.tags || null,
      order.note || null,
      c.id || null,
      c.first_name || null,
      c.last_name || null,
      c.email || null,
      c.phone || null,
      a.name || null,
      a.address1 || null,
      a.address2 || null,
      a.city || null,
      a.province || null,
      a.zip || null,
      a.country || null,
      a.phone || null,
      JSON.stringify(order.line_items || []),
      JSON.stringify(order.shipping_lines || []),
      JSON.stringify(order),
      order.created_at ? new Date(order.created_at) : null,
      order.updated_at ? new Date(order.updated_at) : null,
    ]
  );
}

// ─── Convert a DB row back to Shopify-shaped object ───────────────────────────
function rowToOrder(row) {
  // Return the full raw_data if available, otherwise reconstruct
  if (row.raw_data) {
    const raw = typeof row.raw_data === 'string' ? JSON.parse(row.raw_data) : row.raw_data;
    return raw;
  }
  return {
    id: row.id,
    order_number: row.order_number,
    email: row.email,
    financial_status: row.financial_status,
    fulfillment_status: row.fulfillment_status,
    total_price: row.total_price,
    currency: row.currency,
    tags: row.tags,
    note: row.note,
    created_at: row.created_at,
    updated_at: row.updated_at,
    customer: row.customer_id ? {
      id: row.customer_id,
      first_name: row.customer_first_name,
      last_name: row.customer_last_name,
      email: row.customer_email,
      phone: row.customer_phone,
    } : null,
    shipping_address: row.shipping_name ? {
      name: row.shipping_name,
      address1: row.shipping_address1,
      address2: row.shipping_address2,
      city: row.shipping_city,
      province: row.shipping_province,
      zip: row.shipping_zip,
      country: row.shipping_country,
      phone: row.shipping_phone,
    } : null,
    line_items: typeof row.line_items === 'string' ? JSON.parse(row.line_items) : (row.line_items || []),
    shipping_lines: typeof row.shipping_lines === 'string' ? JSON.parse(row.shipping_lines) : (row.shipping_lines || []),
  };
}

// ─── GET /api/orders — serve from MySQL ──────────────────────────────────────
router.get('/', authenticateToken, async (req, res) => {
  try {
    const [rows] = await pool.query(
      'SELECT * FROM orders ORDER BY created_at DESC'
    );
    const orders = rows.map(rowToOrder);
    res.json({ orders, source: 'database' });
  } catch (err) {
    console.error('Error fetching orders from DB:', err);
    res.status(500).json({ message: 'Failed to fetch orders from database', error: err.message });
  }
});

// ─── POST /api/orders/sync — pull from Shopify, store in MySQL ───────────────
router.post('/sync', authenticateToken, async (req, res) => {
  try {
    const shopifyOrders = await fetchShopifyOrders();

    let synced = 0;
    for (const order of shopifyOrders) {
      await upsertOrder(order);
      synced++;
    }

    res.json({ message: `Synced ${synced} orders from Shopify into database.`, synced });
  } catch (err) {
    console.error('Sync error:', err);
    res.status(500).json({ message: 'Sync failed', error: err.message });
  }
});

export default router;
