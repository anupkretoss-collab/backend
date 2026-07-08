import express from 'express';
import { authenticateToken } from '../middleware/auth.js';
import {
  fetchShopifyOrders,
  fetchShopifyProducts,
  fetchShopifyCustomers,
  fetchShopifyOrdersChunk,
} from '../services/shopify.js';
import pool from '../services/db.js';
import XLSX from 'xlsx-js-style';
import { mergeLabels } from '../services/royalMail.js';
import { buildRecordPdf } from './preorders.js';

const router = express.Router();

const backgroundJobs = new Map();

// In-memory cache for /meta — invalidated on sync
let metaCache = null;
let metaCacheAt = 0;
const META_TTL_MS = 5 * 60 * 1000; // 5 minutes
export function invalidateMetaCache() { metaCache = null; }

// ─── Upsert a single Shopify order into MySQL ─────────────────────────────────
export async function upsertOrder(order) {
  const c = order.customer || {};
  const a = order.shipping_address || {};
  const totalQuantity = (order.line_items || []).reduce((s, li) => s + (li.quantity || 0), 0);

  await pool.query(
    `INSERT INTO orders (
      id, order_number, email, financial_status, fulfillment_status,
      total_price, currency, tags, note,
      customer_id, customer_first_name, customer_last_name, customer_email, customer_phone,
      shipping_name, shipping_address1, shipping_address2, shipping_city,
      shipping_province, shipping_zip, shipping_country, shipping_phone,
      line_items, shipping_lines, raw_data, total_quantity, created_at, updated_at
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
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
      total_quantity      = VALUES(total_quantity),
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
      c?.id || null,
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
      totalQuantity,
      order.created_at ? new Date(order.created_at) : null,
      order.updated_at ? new Date(order.updated_at) : null,
    ]
  );
}

// Batch upsert orders — single multi-row query instead of N round trips
export async function batchUpsertOrders(orders, chunkSize = 50) {
  if (!orders.length) return;
  for (let i = 0; i < orders.length; i += chunkSize) {
    const chunk = orders.slice(i, i + chunkSize);
    const placeholders = chunk.map(() => '(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').join(',');
    const values = chunk.flatMap(order => {
      const c = order.customer || {};
      const a = order.shipping_address || {};
      const qty = (order.line_items || []).reduce((s, li) => s + (li.quantity || 0), 0);
      return [
        order.id, order.order_number, order.email || null,
        order.financial_status || null, order.fulfillment_status || null,
        parseFloat(order.total_price || 0), order.currency || null,
        order.tags || null, order.note || null,
        c?.id || null, c.first_name || null, c.last_name || null, c.email || null, c.phone || null,
        a.name || null, a.address1 || null, a.address2 || null, a.city || null,
        a.province || null, a.zip || null, a.country || null, a.phone || null,
        JSON.stringify(order.line_items || []), JSON.stringify(order.shipping_lines || []),
        JSON.stringify(order), qty,
        order.created_at ? new Date(order.created_at) : null,
        order.updated_at ? new Date(order.updated_at) : null,
      ];
    });
    await pool.query(
      `INSERT INTO orders (
        id, order_number, email, financial_status, fulfillment_status,
        total_price, currency, tags, note,
        customer_id, customer_first_name, customer_last_name, customer_email, customer_phone,
        shipping_name, shipping_address1, shipping_address2, shipping_city,
        shipping_province, shipping_zip, shipping_country, shipping_phone,
        line_items, shipping_lines, raw_data, total_quantity, created_at, updated_at
      ) VALUES ${placeholders}
      ON DUPLICATE KEY UPDATE
        order_number=VALUES(order_number), email=VALUES(email),
        financial_status=VALUES(financial_status), fulfillment_status=VALUES(fulfillment_status),
        total_price=VALUES(total_price), currency=VALUES(currency), tags=VALUES(tags), note=VALUES(note),
        customer_id=VALUES(customer_id), customer_first_name=VALUES(customer_first_name),
        customer_last_name=VALUES(customer_last_name), customer_email=VALUES(customer_email),
        customer_phone=VALUES(customer_phone), shipping_name=VALUES(shipping_name),
        shipping_address1=VALUES(shipping_address1), shipping_address2=VALUES(shipping_address2),
        shipping_city=VALUES(shipping_city), shipping_province=VALUES(shipping_province),
        shipping_zip=VALUES(shipping_zip), shipping_country=VALUES(shipping_country),
        shipping_phone=VALUES(shipping_phone), line_items=VALUES(line_items),
        shipping_lines=VALUES(shipping_lines), raw_data=VALUES(raw_data),
        total_quantity=VALUES(total_quantity), updated_at=VALUES(updated_at),
        synced_at=CURRENT_TIMESTAMP`,
      values
    );
  }
}

export async function upsertProduct(product) {
  const image = product.image || {};
  const firstVariant = product.variants?.[0] || {};

  await pool.query(
    `INSERT INTO products (
      id,
      title,
      handle,
      vendor,
      product_type,
      seo_title,
      seo_description,
      status,
      tags,
      price,
      compare_at_price,
      inventory_quantity,
      image,
      variants,
      options_data,
      raw_data,
      created_at,
      updated_at
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON DUPLICATE KEY UPDATE
      title              = VALUES(title),
      handle             = VALUES(handle),
      vendor             = VALUES(vendor),
      product_type       = VALUES(product_type),
      seo_title          = VALUES(seo_title),
      seo_description    = VALUES(seo_description),
      status             = VALUES(status),
      tags               = VALUES(tags),
      price              = VALUES(price),
      compare_at_price   = VALUES(compare_at_price),
      inventory_quantity = VALUES(inventory_quantity),
      image              = VALUES(image),
      variants           = VALUES(variants),
      options_data       = VALUES(options_data),
      raw_data           = VALUES(raw_data),
      updated_at         = VALUES(updated_at),
      synced_at          = CURRENT_TIMESTAMP`,
    [
      product.id,
      product.title || null,
      product.handle || null,
      product.vendor || null,
      product.product_type || null,
      product.seo?.title || null,
      product.seo?.description || null,
      product.status || null,
      product.tags || null,
      parseFloat(firstVariant.price || 0),
      parseFloat(firstVariant.compare_at_price || 0),
      parseInt(firstVariant.inventory_quantity || 0),
      image.src || null,
      JSON.stringify(product.variants || []),
      JSON.stringify(product.options || []),
      JSON.stringify(product),
      product.created_at ? new Date(product.created_at) : null,
      product.updated_at ? new Date(product.updated_at) : null,
    ]
  );
}

export async function deleteProduct(productId) {
  await pool.query(
    `DELETE FROM products WHERE id = ?`,
    [productId]
  );
}

export async function upsertCustomer(customer) {
  const address = customer.default_address || {};

  await pool.query(
    `INSERT INTO customers (
      id,
      first_name,
      last_name,
      email,
      phone,
      accepts_marketing,
      verified_email,
      orders_count,
      total_spent,
      state,
      tags,
      currency,
      address1,
      city,
      province,
      country,
      zip,
      raw_data,
      created_at,
      updated_at
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON DUPLICATE KEY UPDATE
      first_name         = VALUES(first_name),
      last_name          = VALUES(last_name),
      email              = VALUES(email),
      phone              = VALUES(phone),
      accepts_marketing  = VALUES(accepts_marketing),
      verified_email     = VALUES(verified_email),
      orders_count       = VALUES(orders_count),
      total_spent        = VALUES(total_spent),
      state              = VALUES(state),
      tags               = VALUES(tags),
      currency           = VALUES(currency),
      address1           = VALUES(address1),
      city               = VALUES(city),
      province           = VALUES(province),
      country            = VALUES(country),
      zip                = VALUES(zip),
      raw_data           = VALUES(raw_data),
      updated_at         = VALUES(updated_at),
      synced_at          = CURRENT_TIMESTAMP`,
    [
      customer.id,
      customer.first_name || null,
      customer.last_name || null,
      customer.email || null,
      customer.phone || null,
      customer.accepts_marketing || false,
      customer.verified_email || false,
      customer.orders_count || 0,
      parseFloat(customer.total_spent || 0),
      customer.state || null,
      customer.tags || null,
      customer.currency || null,
      address.address1 || null,
      address.city || null,
      address.province || null,
      address.country || null,
      address.zip || null,
      JSON.stringify(customer),
      customer.created_at ? new Date(customer.created_at) : null,
      customer.updated_at ? new Date(customer.updated_at) : null,
    ]
  );
}

// Batch upsert products — single multi-row query per chunk
export async function batchUpsertProducts(products, chunkSize = 50) {
  if (!products.length) return;
  for (let i = 0; i < products.length; i += chunkSize) {
    const chunk = products.slice(i, i + chunkSize);
    const placeholders = chunk.map(() => '(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').join(',');
    const values = chunk.flatMap(p => {
      const img = p.image || {};
      const v0 = p.variants?.[0] || {};
      return [
        p.id, p.title || null, p.handle || null, p.vendor || null, p.product_type || null,
        p.seo?.title || null, p.seo?.description || null, p.status || null, p.tags || null,
        parseFloat(v0.price || 0), parseFloat(v0.compare_at_price || 0),
        parseInt(v0.inventory_quantity || 0), img.src || null,
        JSON.stringify(p.variants || []), JSON.stringify(p.options || []),
        JSON.stringify(p),
        p.created_at ? new Date(p.created_at) : null,
        p.updated_at ? new Date(p.updated_at) : null,
      ];
    });
    await pool.query(
      `INSERT INTO products (id,title,handle,vendor,product_type,seo_title,seo_description,
        status,tags,price,compare_at_price,inventory_quantity,image,variants,options_data,raw_data,
        created_at,updated_at) VALUES ${placeholders}
      ON DUPLICATE KEY UPDATE
        title=VALUES(title),handle=VALUES(handle),vendor=VALUES(vendor),
        product_type=VALUES(product_type),seo_title=VALUES(seo_title),
        seo_description=VALUES(seo_description),status=VALUES(status),tags=VALUES(tags),
        price=VALUES(price),compare_at_price=VALUES(compare_at_price),
        inventory_quantity=VALUES(inventory_quantity),image=VALUES(image),
        variants=VALUES(variants),options_data=VALUES(options_data),raw_data=VALUES(raw_data),
        updated_at=VALUES(updated_at),synced_at=CURRENT_TIMESTAMP`,
      values
    );
  }
}

// Batch upsert customers
export async function batchUpsertCustomers(customers, chunkSize = 50) {
  if (!customers.length) return;
  for (let i = 0; i < customers.length; i += chunkSize) {
    const chunk = customers.slice(i, i + chunkSize);
    const placeholders = chunk.map(() => '(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').join(',');
    const values = chunk.flatMap(c => {
      const addr = c.default_address || {};
      return [
        c.id, c.first_name || null, c.last_name || null, c.email || null, c.phone || null,
        c.accepts_marketing || false, c.verified_email || false,
        c.orders_count || 0, parseFloat(c.total_spent || 0),
        c.state || null, c.tags || null, c.currency || null,
        addr.address1 || null, addr.city || null, addr.province || null,
        addr.country || null, addr.zip || null,
        JSON.stringify(c),
        c.created_at ? new Date(c.created_at) : null,
        c.updated_at ? new Date(c.updated_at) : null,
      ];
    });
    await pool.query(
      `INSERT INTO customers (id,first_name,last_name,email,phone,accepts_marketing,verified_email,
        orders_count,total_spent,state,tags,currency,address1,city,province,country,zip,
        raw_data,created_at,updated_at) VALUES ${placeholders}
      ON DUPLICATE KEY UPDATE
        first_name=VALUES(first_name),last_name=VALUES(last_name),email=VALUES(email),
        phone=VALUES(phone),accepts_marketing=VALUES(accepts_marketing),
        verified_email=VALUES(verified_email),orders_count=VALUES(orders_count),
        total_spent=VALUES(total_spent),state=VALUES(state),tags=VALUES(tags),
        currency=VALUES(currency),address1=VALUES(address1),city=VALUES(city),
        province=VALUES(province),country=VALUES(country),zip=VALUES(zip),
        raw_data=VALUES(raw_data),updated_at=VALUES(updated_at),synced_at=CURRENT_TIMESTAMP`,
      values
    );
  }
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

// ─── GET /api/orders — serve from MySQL with pagination & filters ─────────────
// ─── Get metadata for filters (tags, varieties, shipping) ──────────────────
router.get('/meta', authenticateToken, async (req, res) => {
  // Serve from cache if fresh (avoids 5 heavy JSON_TABLE queries on every page load)
  if (metaCache && Date.now() - metaCacheAt < META_TTL_MS) {
    res.setHeader('X-Cache', 'HIT');
    return res.json(metaCache);
  }
  try {
    // Run all 5 queries in parallel
    const [
      [tagRows],
      [productTagRows],
      [varietyRows],
      [shippingRows],
      [paymentRows],
      [fulfillRows],
    ] = await Promise.all([
      pool.query('SELECT DISTINCT tags FROM orders WHERE tags IS NOT NULL AND tags != ""'),
      pool.query('SELECT DISTINCT tags FROM products WHERE tags IS NOT NULL AND tags != ""'),
      pool.query(`SELECT DISTINCT jt.title FROM orders,
        JSON_TABLE(COALESCE(orders.line_items,'[]'),'$[*]' COLUMNS(title VARCHAR(255) PATH '$.title')) jt
        WHERE jt.title IS NOT NULL`),
      pool.query(`SELECT DISTINCT jt.title FROM orders,
        JSON_TABLE(COALESCE(orders.shipping_lines,'[]'),'$[*]' COLUMNS(title VARCHAR(255) PATH '$.title')) jt
        WHERE jt.title IS NOT NULL`),
      pool.query('SELECT DISTINCT financial_status FROM orders WHERE financial_status IS NOT NULL AND financial_status != ""'),
      pool.query('SELECT DISTINCT COALESCE(fulfillment_status,"unfulfilled") as status FROM orders'),
    ]);

    const orderTagsSet = new Set();
    tagRows.forEach(r => r.tags.split(',').forEach(t => orderTagsSet.add(t.trim())));

    const productTagsSet = new Set();
    productTagRows.forEach(r => r.tags && r.tags.split(',').forEach(t => productTagsSet.add(t.trim())));

    const result = {
      tags: [...new Set([...orderTagsSet, ...productTagsSet])].sort(),
      orderTags: [...orderTagsSet].sort(),
      productTags: [...productTagsSet].sort(),
      varieties: varietyRows.map(r => r.title).sort(),
      shipping: shippingRows.map(r => r.title).sort(),
      payments: paymentRows.map(r => r.financial_status).sort(),
      fulfillments: [...new Set(fulfillRows.map(r => r.status))].sort(),
    };

    metaCache = result;
    metaCacheAt = Date.now();

    res.setHeader('X-Cache', 'MISS');
    res.json(result);
  } catch (err) {
    console.error('Error fetching filter metadata:', err);
    res.status(500).json({ message: 'Failed to fetch filter metadata' });
  }
});

export function buildOrderFilters(query) {

  const {
    search,
    tags,
    varieties,
    varieties_exclude,
    shipping,
    fulfillment_status,
    financial_status,
    order_number,
    customer,
    amount_min,
    amount_max,
    created_at_min,
    created_at_max,
    order_ids,
  } = query;

  let whereClauses = [];
  let queryParams = [];

  // ── order_ids shortcut: bypass all other filters ──────────────────────────
  if (order_ids) {
    const ids = String(order_ids).split(',').map(id => id.trim()).filter(Boolean);
    if (ids.length > 0) {
      whereClauses.push(`id IN (${ids.map(() => '?').join(',')})`);
      ids.forEach(id => queryParams.push(id));
      const whereSql = `WHERE ${whereClauses.join(' AND ')}`;
      return { whereSql, queryParams };
    }
  }

  // ============================================
  // SEARCH
  // ============================================

  // ============================================
  // SEARCH
  // ============================================

  //   if (search) {

  //     const searchValues =
  //       search
  //         .split(',')
  //         .map(v =>
  //           decodeURIComponent(v)
  //             .replace(/#/g, '')
  //             .trim()
  //         )
  //         .filter(Boolean);

  //     if (searchValues.length > 0) {

  //       const conditions = [];

  //       searchValues.forEach(() => {

  //         conditions.push(`
  //       (
  //         CAST(order_number AS CHAR) LIKE ?

  //         OR LOWER(COALESCE(email, '')) LIKE LOWER(?)

  //         OR LOWER(COALESCE(customer_first_name, '')) LIKE LOWER(?)

  //         OR LOWER(COALESCE(customer_last_name, '')) LIKE LOWER(?)

  //         OR LOWER(
  //             CONCAT(
  //               COALESCE(customer_first_name, ''),
  //               ' ',
  //               COALESCE(customer_last_name, '')
  //             )
  //           ) LIKE LOWER(?)

  //         OR LOWER(
  //             CONCAT(
  //               COALESCE(customer_last_name, ''),
  //               ' ',
  //               COALESCE(customer_first_name, '')
  //             )
  //           ) LIKE LOWER(?)

  //         OR LOWER(COALESCE(shipping_name, '')) LIKE LOWER(?)

  //         OR LOWER(
  //   COALESCE(orders.tags, '') COLLATE utf8mb4_unicode_ci
  // ) LIKE LOWER(?)

  //         OR EXISTS (
  //           SELECT 1
  //           FROM JSON_TABLE(
  //             COALESCE(orders.line_items, '[]'),
  //             '$[*]'
  //             COLUMNS (
  //               product_id VARCHAR(50) PATH '$.product_id',
  //               title VARCHAR(255) PATH '$.title'
  //             )
  //           ) jt

  //           LEFT JOIN products p
  //             ON CAST(p.id AS CHAR) COLLATE utf8mb4_unicode_ci =
  //    jt.product_id COLLATE utf8mb4_unicode_ci

  //           WHERE
  //             (
  //               LOWER(
  //   COALESCE(p.tags, '') COLLATE utf8mb4_unicode_ci
  // ) LIKE LOWER(?)
  //               OR LOWER(COALESCE(jt.title, '')) LIKE LOWER(?)
  //             )
  //         )
  //       )
  //     `);

  //       });

  //       whereClauses.push(`
  //       (${conditions.join(' OR ')})
  //     `);

  //       searchValues.forEach(value => {

  //         const pattern =
  //           `%${value}%`;

  //         queryParams.push(
  //           pattern, // order number
  //           pattern, // email
  //           pattern, // first name
  //           pattern, // last name
  //           pattern, // first last
  //           pattern, // last first
  //           pattern, // shipping
  //           pattern, // order tags
  //           pattern, // product tags
  //           pattern  // product title
  //         );

  //       });
  //     }
  //   }

  if (search) {

    const searchValues =
      search
        .split(',')
        .map(v =>
          decodeURIComponent(v)
            .replace(/#/g, '')
            .trim()
        )
        .filter(Boolean);

    if (searchValues.length > 0) {

      const conditions = [];

      searchValues.forEach(() => {

        conditions.push(`
      (
        CAST(order_number AS CHAR) LIKE ?

        OR LOWER(
          COALESCE(email, '') COLLATE utf8mb4_unicode_ci
        ) LIKE LOWER(?)

        OR LOWER(
          COALESCE(customer_first_name, '') COLLATE utf8mb4_unicode_ci
        ) LIKE LOWER(?)

        OR LOWER(
          COALESCE(customer_last_name, '') COLLATE utf8mb4_unicode_ci
        ) LIKE LOWER(?)

        OR LOWER(
          CONCAT(
            COALESCE(customer_first_name, ''),
            ' ',
            COALESCE(customer_last_name, '')
          ) COLLATE utf8mb4_unicode_ci
        ) LIKE LOWER(?)

        OR LOWER(
          CONCAT(
            COALESCE(customer_last_name, ''),
            ' ',
            COALESCE(customer_first_name, '')
          ) COLLATE utf8mb4_unicode_ci
        ) LIKE LOWER(?)
      )
    `);

      });

      whereClauses.push(`
      (${conditions.join(' OR ')})
    `);

      searchValues.forEach(value => {

        const pattern = `%${value}%`;

        queryParams.push(
          pattern, // order number
          pattern, // email
          pattern, // first name
          pattern, // last name
          pattern, // first last
          pattern  // last first
        );

      });
    }
  }

  // ============================================
  // ORDER NUMBER
  // ============================================

  if (order_number) {

    const orderNumbers =
      order_number
        .split(',')
        .map(v =>
          v.replace(/#/g, '').trim()
        )
        .filter(Boolean);

    if (orderNumbers.length > 0) {

      const conditions =
        orderNumbers.map(() =>
          'CAST(order_number AS CHAR) LIKE ?'
        );

      whereClauses.push(`
        (${conditions.join(' OR ')})
      `);

      orderNumbers.forEach(num => {
        queryParams.push(`%${num}%`);
      });
    }
  }

  // ============================================
  // CUSTOMER
  // ============================================

  if (customer) {

    const customerValues =
      customer
        .split(',')
        .map(v => v.trim())
        .filter(Boolean);

    if (customerValues.length > 0) {

      const conditions = [];

      customerValues.forEach(() => {

        conditions.push(`
        (
          LOWER(customer_first_name) LIKE LOWER(?)

          OR LOWER(customer_last_name) LIKE LOWER(?)

          OR LOWER(
              CONCAT(
                COALESCE(customer_first_name, ''),
                ' ',
                COALESCE(customer_last_name, '')
              )
            ) LIKE LOWER(?)

          OR LOWER(
              CONCAT(
                COALESCE(customer_last_name, ''),
                ' ',
                COALESCE(customer_first_name, '')
              )
            ) LIKE LOWER(?)

          OR LOWER(customer_email) LIKE LOWER(?)

          OR LOWER(shipping_name) LIKE LOWER(?)
        )
      `);
      });

      whereClauses.push(`
      (${conditions.join(' OR ')})
    `);

      customerValues.forEach(value => {

        const pattern =
          `%${value}%`;

        queryParams.push(
          pattern, // first name
          pattern, // last name
          pattern, // first last
          pattern, // last first
          pattern, // email
          pattern  // shipping
        );
      });
    }
  }

  // ============================================
  // TAGS
  // ============================================

  if (tags) {
    const tagValues = tags
      .split(',')
      .map(v => decodeURIComponent(v).trim())
      .filter(Boolean);

    if (tagValues.length > 0) {
      const conditions = [];

      tagValues.forEach(() => {
        conditions.push(`
          (
            LOWER(COALESCE(orders.tags, '') COLLATE utf8mb4_unicode_ci) LIKE LOWER(?)
            OR EXISTS (
              SELECT 1
              FROM JSON_TABLE(
                COALESCE(orders.line_items, '[]'),
                '$[*]'
                COLUMNS (
                  product_id VARCHAR(50) PATH '$.product_id'
                )
              ) jt
              INNER JOIN products p
                ON CAST(p.id AS CHAR) COLLATE utf8mb4_unicode_ci = jt.product_id COLLATE utf8mb4_unicode_ci
              WHERE
                jt.product_id IS NOT NULL
                AND LOWER(COALESCE(p.tags, '') COLLATE utf8mb4_unicode_ci) LIKE LOWER(?)
            )
          )
        `);
      });

      // Require all specified tags (AND logic)
      whereClauses.push(`
        (${conditions.join(' AND ')})
      `);

      tagValues.forEach(tag => {
        queryParams.push(
          `%${tag}%`,
          `%${tag}%`
        );
      });
    }
  }

  // ============================================
  // VARIETIES
  // ============================================

  if (varieties) {

    const varietyValues =
      decodeURIComponent(varieties)
        .split(',')
        .map(v =>
          v
            .trim()
            .toLowerCase()
            .replace(/\s+/g, ' ')
        )
        .filter(Boolean);

    if (varietyValues.length > 0) {

      const conditions = [];

      varietyValues.forEach(() => {

        conditions.push(`
        LOWER(line_items) LIKE ?
      `);
      });

      whereClauses.push(`
      (${conditions.join(' OR ')})
    `);

      varietyValues.forEach(value => {

        queryParams.push(
          `%${value}%`
        );
      });
    }
  }

  // ── varieties_exclude: show orders that DO NOT contain these varieties ────
  if (varieties_exclude) {
    const excludeValues = decodeURIComponent(varieties_exclude)
      .split(',')
      .map(v => v.trim().toLowerCase().replace(/\s+/g, ' '))
      .filter(Boolean);

    if (excludeValues.length > 0) {
      const conditions = excludeValues.map(() => `LOWER(line_items) NOT LIKE ?`);
      whereClauses.push(`(${conditions.join(' AND ')})`);
      excludeValues.forEach(value => queryParams.push(`%${value}%`));
    }
  }

  // ============================================
  // SHIPPING METHODS
  // ============================================

  if (shipping) {

    const shippingValues =
      decodeURIComponent(shipping)
        .split(',')
        .map(v =>
          v
            .trim()
            .toLowerCase()
            .replace(/\s+/g, ' ')
        )
        .filter(Boolean);

    if (shippingValues.length > 0) {

      const conditions = [];

      shippingValues.forEach(() => {

        conditions.push(`
        LOWER(
          COALESCE(shipping_lines, '')
        ) LIKE ?
      `);

      });

      whereClauses.push(`
      (${conditions.join(' OR ')})
    `);

      shippingValues.forEach(value => {

        queryParams.push(
          `%${value}%`
        );

      });
    }
  }

  // ============================================
  // FULFILLMENT STATUS
  // ============================================

  if (fulfillment_status) {

    const statuses =
      fulfillment_status.split(',');

    const parts = statuses.map(s => {

      if (s === 'unfulfilled') {

        return `
          fulfillment_status IS NULL
          OR fulfillment_status = "unfulfilled"
        `;
      }

      return 'fulfillment_status = ?';
    });

    whereClauses.push(
      `(${parts.join(' OR ')})`
    );

    statuses.forEach(s => {

      if (s !== 'unfulfilled') {
        queryParams.push(s);
      }
    });
  }

  // ============================================
  // FINANCIAL STATUS
  // ============================================

  if (financial_status) {

    const statuses =
      financial_status.split(',');

    whereClauses.push(`
      financial_status IN (
        ${statuses.map(() => '?').join(',')}
      )
    `);

    queryParams.push(...statuses);
  }

  // ============================================
  // AMOUNT RANGE
  // ============================================

  if (amount_min) {

    whereClauses.push(
      'total_price >= ?'
    );

    queryParams.push(
      parseFloat(amount_min)
    );
  }

  if (amount_max) {

    whereClauses.push(
      'total_price <= ?'
    );

    queryParams.push(
      parseFloat(amount_max)
    );
  }

  // ============================================
  // DATE RANGE
  // ============================================

  if (created_at_min) {

    whereClauses.push(
      'created_at >= ?'
    );

    queryParams.push(created_at_min);
  }

  if (created_at_max) {

    whereClauses.push(
      'created_at <= ?'
    );

    queryParams.push(created_at_max);
  }

  // ============================================
  // RETURN
  // ============================================

  return {

    whereSql:
      whereClauses.length > 0
        ? `WHERE ${whereClauses.join(' AND ')}`
        : '',

    queryParams
  };
}

// router.get(
//   '/preorder-summary-report',
//   authenticateToken,
//   async (req, res) => {
//     try {
//       // ============================================
//       // FETCH ALL ORDERS
//       // ============================================

//       const [rows] = await pool.query(`
//         SELECT line_items
//         FROM orders
//       `);

//       // ============================================
//       // PRODUCT SUMMARY
//       // ============================================

//       const productSummary = {};

//       for (const row of rows) {
//         const lineItems =
//           typeof row.line_items === 'string'
//             ? JSON.parse(row.line_items)
//             : row.line_items || [];

//         for (const item of lineItems) {

//           const title = (item.title || '')
//             .replace(/\s+/g, ' ')
//             .trim();

//           if (!title) continue;

//           if (!productSummary[title]) {
//             productSummary[title] = 0;
//           }

//           productSummary[title] += Number(item.quantity || 1);
//         }
//       }

//       // ============================================
//       // SORT PRODUCTS
//       // ============================================

//       const sortedProducts = Object.keys(productSummary).sort();

//       // ============================================
//       // EXCEL DATA
//       // ============================================

//       const data = [];

//       // Title
//       data.push([
//         `PREORDER TOTALS PER VARIETY for ${new Date().toLocaleString()}`
//       ]);

//       // Header
//       data.push(['Product Title', 'Net Quantity']);

//       // Rows
//       sortedProducts.forEach((title) => {
//         data.push([
//           title,
//           productSummary[title]
//         ]);
//       });

//       // ============================================
//       // CREATE SHEET
//       // ============================================

//       const ws = XLSX.utils.aoa_to_sheet(data);

//       // Merge title row
//       ws['!merges'] = [
//         {
//           s: { r: 0, c: 0 },
//           e: { r: 0, c: 1 }
//         }
//       ];

//       // Column width
//       ws['!cols'] = [
//         { wch: 70 },
//         { wch: 18 }
//       ];

//       // ============================================
//       // STYLING
//       // ============================================

//       const range = XLSX.utils.decode_range(ws['!ref']);

//       for (let R = range.s.r; R <= range.e.r; ++R) {
//         for (let C = range.s.c; C <= range.e.c; ++C) {

//           const cellRef = XLSX.utils.encode_cell({
//             r: R,
//             c: C
//           });

//           if (!ws[cellRef]) continue;

//           ws[cellRef].s = {
//             border: {
//               top: {
//                 style: 'thin',
//                 color: { rgb: '000000' }
//               },
//               bottom: {
//                 style: 'thin',
//                 color: { rgb: '000000' }
//               },
//               left: {
//                 style: 'thin',
//                 color: { rgb: '000000' }
//               },
//               right: {
//                 style: 'thin',
//                 color: { rgb: '000000' }
//               }
//             },
//             alignment: {
//               vertical: 'center',
//               horizontal:
//                 C === 1 ? 'center' : 'left',
//               wrapText: true
//             },
//             font: {
//               name: 'Arial',
//               sz: 11
//             }
//           };

//           // Title row
//           if (R === 0) {
//             ws[cellRef].s.font = {
//               bold: true,
//               sz: 14
//             };

//             ws[cellRef].s.alignment = {
//               horizontal: 'center',
//               vertical: 'center'
//             };
//           }

//           // Header row
//           if (R === 1) {
//             ws[cellRef].s.font = {
//               bold: true,
//               sz: 11
//             };

//             ws[cellRef].s.fill = {
//               fgColor: {
//                 rgb: 'D9D9D9'
//               }
//             };
//           }
//         }
//       }

//       // ============================================
//       // WORKBOOK
//       // ============================================

//       const wb = XLSX.utils.book_new();

//       XLSX.utils.book_append_sheet(
//         wb,
//         ws,
//         'Preorder Summary'
//       );

//       // ============================================
//       // BUFFER
//       // ============================================

//       const buffer = XLSX.write(wb, {
//         type: 'buffer',
//         bookType: 'xlsx'
//       });

//       // ============================================
//       // RESPONSE
//       // ============================================

//       const fileName = `PREORDER_TOTALS_${new Date().toISOString().split('T')[0]
//         }.xlsx`;

//       res.setHeader(
//         'Content-Disposition',
//         `attachment; filename="${fileName}"`
//       );

//       res.setHeader(
//         'Content-Type',
//         'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
//       );

//       return res.send(buffer);

//     } catch (err) {
//       console.error(
//         'Preorder report error:',
//         err
//       );

//       res.status(500).json({
//         success: false,
//         message: 'Failed to generate preorder report',
//         error: err.message
//       });
//     }
//   }
// );

// router.get(
//   '/packing-slip-report',
//   authenticateToken,
//   async (req, res) => {
//     try {

//       // ============================================
//       // FETCH ORDERS
//       // ============================================

//       const [rows] = await pool.query(`
//         SELECT
//           order_number,
//           line_items,
//           shipping_lines
//         FROM orders
//         ORDER BY order_number ASC
//       `);

//       // ============================================
//       // EXCEL ROWS
//       // ============================================

//       const data = [];

//       // Header
//       data.push([
//         'Order Name',
//         'Product Title',
//         'Shipping Title',
//         'Net Quantity'
//       ]);

//       // Body
//       for (const row of rows) {

//         const lineItems =
//           typeof row.line_items === 'string'
//             ? JSON.parse(row.line_items)
//             : row.line_items || [];

//         const shippingLines =
//           typeof row.shipping_lines === 'string'
//             ? JSON.parse(row.shipping_lines)
//             : row.shipping_lines || [];

//         const shippingTitle =
//           shippingLines?.[0]?.title || '';

//         lineItems.forEach((item, index) => {

//           data.push([
//             index === 0
//               ? `#${row.order_number}`
//               : '',

//             item.title || '',

//             index === 0
//               ? shippingTitle
//               : '',

//             Number(item.quantity || 1)
//           ]);

//         });
//       }

//       // ============================================
//       // SHEET
//       // ============================================

//       const ws = XLSX.utils.aoa_to_sheet(data);

//       // ============================================
//       // COLUMN WIDTHS
//       // ============================================

//       ws['!cols'] = [
//         { wch: 20 },
//         { wch: 85 },
//         { wch: 35 },
//         { wch: 15 }
//       ];

//       // ============================================
//       // MERGE ORDER CELLS
//       // ============================================

//       const merges = [];

//       let startRow = 1;

//       for (let i = 2; i < data.length; i++) {

//         const currentOrder = data[i][0];

//         if (currentOrder !== '') {

//           const endRow = i - 1;

//           if (endRow > startRow) {

//             merges.push({
//               s: { r: startRow, c: 0 },
//               e: { r: endRow, c: 0 }
//             });

//             merges.push({
//               s: { r: startRow, c: 2 },
//               e: { r: endRow, c: 2 }
//             });
//           }

//           startRow = i;
//         }
//       }

//       // last merge
//       if (data.length - 1 > startRow) {

//         merges.push({
//           s: { r: startRow, c: 0 },
//           e: { r: data.length - 1, c: 0 }
//         });

//         merges.push({
//           s: { r: startRow, c: 2 },
//           e: { r: data.length - 1, c: 2 }
//         });
//       }

//       ws['!merges'] = merges;

//       // ============================================
//       // STYLING
//       // ============================================

//       const range = XLSX.utils.decode_range(ws['!ref']);

//       for (let R = range.s.r; R <= range.e.r; ++R) {

//         for (let C = range.s.c; C <= range.e.c; ++C) {

//           const cellRef = XLSX.utils.encode_cell({
//             r: R,
//             c: C
//           });

//           if (!ws[cellRef]) continue;

//           ws[cellRef].s = {

//             border: {
//               top: {
//                 style: 'thin',
//                 color: { rgb: '000000' }
//               },
//               bottom: {
//                 style: 'thin',
//                 color: { rgb: '000000' }
//               },
//               left: {
//                 style: 'thin',
//                 color: { rgb: '000000' }
//               },
//               right: {
//                 style: 'thin',
//                 color: { rgb: '000000' }
//               }
//             },

//             alignment: {
//               vertical: 'center',
//               horizontal:
//                 C === 1 ? 'left' : 'center',
//               wrapText: true
//             },

//             font: {
//               name: 'Arial',
//               sz: 11
//             }
//           };

//           // Header row
//           if (R === 0) {

//             ws[cellRef].s.font = {
//               bold: true,
//               sz: 12
//             };

//             ws[cellRef].s.fill = {
//               fgColor: {
//                 rgb: 'D9E2F3'
//               }
//             };

//             ws[cellRef].s.alignment = {
//               horizontal: 'center',
//               vertical: 'center'
//             };
//           }
//         }
//       }

//       // ============================================
//       // WORKBOOK
//       // ============================================

//       const wb = XLSX.utils.book_new();

//       XLSX.utils.book_append_sheet(
//         wb,
//         ws,
//         'Packing Slip'
//       );

//       // ============================================
//       // BUFFER
//       // ============================================

//       const buffer = XLSX.write(wb, {
//         type: 'buffer',
//         bookType: 'xlsx'
//       });

//       // ============================================
//       // RESPONSE
//       // ============================================

//       const fileName =
//         `PACKING_SLIP_${new Date()
//           .toISOString()
//           .split('T')[0]}.xlsx`;

//       res.setHeader(
//         'Content-Disposition',
//         `attachment; filename="${fileName}"`
//       );

//       res.setHeader(
//         'Content-Type',
//         'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
//       );

//       return res.send(buffer);

//     } catch (err) {

//       console.error(
//         'Packing slip report error:',
//         err
//       );

//       res.status(500).json({
//         success: false,
//         message: 'Failed to generate packing slip',
//         error: err.message
//       });
//     }
//   }
// );

router.get(
  '/preorder-summary-report',
  authenticateToken,
  async (req, res) => {
    try {

      // ============================================
      // FILTERS
      // ============================================

      const {
        whereSql,
        queryParams
      } = buildOrderFilters(req.query);

      // ============================================
      // FETCH FILTERED ORDERS
      // ============================================

      const [rows] = await pool.query(
        `
          SELECT line_items
          FROM orders
          ${whereSql}
        `,
        queryParams
      );

      // ============================================
      // HORTICULTURAL PRODUCTS FILTER
      // ============================================

      const [plantProducts] = await pool.query(
        "SELECT id FROM products WHERE tags LIKE ?",
        ['%plants-seedlings%']
      );
      const plantIdSet = new Set(plantProducts.map(p => String(p.id)));

      // ============================================
      // PRODUCT SUMMARY
      // ============================================

      const productSummary = {};

      for (const row of rows) {

        const lineItems =
          typeof row.line_items === 'string'
            ? JSON.parse(row.line_items)
            : row.line_items || [];

        for (const item of lineItems) {

          // Only include horticultural products (tagged with 'plants-seedlings')
          if (!plantIdSet.has(String(item.product_id))) {
            continue;
          }

          const title = (item.title || '')
            .replace(/\s+/g, ' ')
            .trim();

          if (!title) continue;

          if (!productSummary[title]) {
            productSummary[title] = 0;
          }

          productSummary[title] += Number(
            item.quantity || 1
          );
        }
      }

      // ============================================
      // SORT PRODUCTS
      // ============================================

      const sortedProducts =
        Object.keys(productSummary).sort();

      // ============================================
      // EXCEL DATA
      // ============================================

      const data = [];

      data.push([
        `PREORDER TOTALS PER VARIETY for ${new Date().toLocaleString()}`
      ]);

      data.push([
        'Product Title',
        'Net Quantity'
      ]);

      sortedProducts.forEach((title) => {

        data.push([
          title,
          productSummary[title]
        ]);
      });

      // ============================================
      // SHEET
      // ============================================

      const ws =
        XLSX.utils.aoa_to_sheet(data);

      ws['!merges'] = [
        {
          s: { r: 0, c: 0 },
          e: { r: 0, c: 1 }
        }
      ];

      ws['!cols'] = [
        { wch: 70 },
        { wch: 18 }
      ];

      // ============================================
      // STYLING
      // ============================================

      const range =
        XLSX.utils.decode_range(ws['!ref']);

      for (
        let R = range.s.r;
        R <= range.e.r;
        ++R
      ) {

        for (
          let C = range.s.c;
          C <= range.e.c;
          ++C
        ) {

          const cellRef =
            XLSX.utils.encode_cell({
              r: R,
              c: C
            });

          if (!ws[cellRef]) continue;

          ws[cellRef].s = {

            border: {
              top: {
                style: 'thin',
                color: { rgb: '000000' }
              },
              bottom: {
                style: 'thin',
                color: { rgb: '000000' }
              },
              left: {
                style: 'thin',
                color: { rgb: '000000' }
              },
              right: {
                style: 'thin',
                color: { rgb: '000000' }
              }
            },

            alignment: {
              vertical: 'center',
              horizontal:
                C === 1
                  ? 'center'
                  : 'left',
              wrapText: true
            },

            font: {
              name: 'Arial',
              sz: 11
            }
          };

          // TITLE
          if (R === 0) {

            ws[cellRef].s.font = {
              bold: true,
              sz: 14
            };

            ws[cellRef].s.alignment = {
              horizontal: 'center',
              vertical: 'center'
            };
          }

          // HEADER
          if (R === 1) {

            ws[cellRef].s.font = {
              bold: true,
              sz: 11
            };

            ws[cellRef].s.fill = {
              fgColor: {
                rgb: 'D9D9D9'
              }
            };
          }
        }
      }

      // ============================================
      // WORKBOOK
      // ============================================

      const wb =
        XLSX.utils.book_new();

      XLSX.utils.book_append_sheet(
        wb,
        ws,
        'Preorder Summary'
      );

      // ============================================
      // BUFFER
      // ============================================

      const buffer = XLSX.write(wb, {
        type: 'buffer',
        bookType: 'xlsx'
      });

      // ============================================
      // RESPONSE
      // ============================================

      const fileName =
        `PREORDER_TOTALS_${new Date()
          .toISOString()
          .split('T')[0]}.xlsx`;

      res.setHeader(
        'Content-Disposition',
        `attachment; filename="${fileName}"`
      );

      res.setHeader(
        'Content-Type',
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
      );

      return res.send(buffer);

    } catch (err) {

      console.error(
        'Preorder report error:',
        err
      );

      res.status(500).json({
        success: false,
        message:
          'Failed to generate preorder report',
        error: err.message
      });
    }
  }
);

router.get(
  '/packing-slip-report',
  authenticateToken,
  async (req, res) => {
    try {

      // ============================================
      // FILTERS
      // ============================================

      const {
        whereSql,
        queryParams
      } = buildOrderFilters(req.query);

      // ============================================
      // FETCH FILTERED ORDERS
      // ============================================

      const [rows] = await pool.query(
        `
          SELECT
            order_number,
            line_items,
            shipping_lines
          FROM orders
          ${whereSql}
          ORDER BY order_number ASC
        `,
        queryParams
      );

      // ============================================
      // HORTICULTURAL PRODUCTS FILTER
      // ============================================

      const [plantProducts] = await pool.query(
        "SELECT id FROM products WHERE tags LIKE ?",
        ['%plants-seedlings%']
      );
      const plantIdSet = new Set(plantProducts.map(p => String(p.id)));

      // ============================================
      // EXCEL DATA
      // ============================================

      const data = [];

      data.push([
        'Order Name',
        'Product Title',
        'Shipping Title',
        'Net Quantity'
      ]);

      for (const row of rows) {

        const lineItems =
          typeof row.line_items === 'string'
            ? JSON.parse(row.line_items)
            : row.line_items || [];

        // Filter for horticultural products only
        const plantLineItems = lineItems.filter(item =>
          plantIdSet.has(String(item.product_id))
        );

        if (plantLineItems.length === 0) continue;

        const shippingLines =
          typeof row.shipping_lines === 'string'
            ? JSON.parse(row.shipping_lines)
            : row.shipping_lines || [];

        const shippingTitle =
          shippingLines?.[0]?.title || '';

        plantLineItems.forEach((item, index) => {

          data.push([

            index === 0
              ? `#${row.order_number}`
              : '',

            item.title || '',

            shippingTitle, // Not merged, repeat for every row

            Number(item.quantity || 1)
          ]);
        });
      }

      // ============================================
      // SHEET
      // ============================================

      const ws =
        XLSX.utils.aoa_to_sheet(data);

      ws['!cols'] = [
        { wch: 20 },
        { wch: 85 },
        { wch: 35 },
        { wch: 15 }
      ];

      // ============================================
      // MERGES
      // ============================================

      const merges = [];

      let startRow = 1;

      for (
        let i = 2;
        i < data.length;
        i++
      ) {

        const currentOrder =
          data[i][0];

        if (currentOrder !== '') {

          const endRow = i - 1;

          if (endRow > startRow) {

            merges.push({
              s: {
                r: startRow,
                c: 0
              },
              e: {
                r: endRow,
                c: 0
              }
            });

            // Removed shipping title merge (column 2) as requested
          }

          startRow = i;
        }
      }

      // LAST MERGE
      if (
        data.length - 1 > startRow
      ) {

        merges.push({
          s: {
            r: startRow,
            c: 0
          },
          e: {
            r: data.length - 1,
            c: 0
          }
        });

        // Removed shipping title merge (column 2) as requested
      }

      ws['!merges'] = merges;

      // ============================================
      // STYLING
      // ============================================

      const range =
        XLSX.utils.decode_range(
          ws['!ref']
        );

      for (
        let R = range.s.r;
        R <= range.e.r;
        ++R
      ) {

        for (
          let C = range.s.c;
          C <= range.e.c;
          ++C
        ) {

          const cellRef =
            XLSX.utils.encode_cell({
              r: R,
              c: C
            });

          if (!ws[cellRef]) continue;

          ws[cellRef].s = {

            border: {
              top: {
                style: 'thin',
                color: {
                  rgb: '000000'
                }
              },
              bottom: {
                style: 'thin',
                color: {
                  rgb: '000000'
                }
              },
              left: {
                style: 'thin',
                color: {
                  rgb: '000000'
                }
              },
              right: {
                style: 'thin',
                color: {
                  rgb: '000000'
                }
              }
            },

            alignment: {
              vertical: 'center',
              horizontal:
                C === 1
                  ? 'left'
                  : 'center',
              wrapText: true
            },

            font: {
              name: 'Arial',
              sz: 11
            }
          };

          // Conditional Formatting for Net Quantity (Column 3)
          if (R > 0 && C === 3) {
            const val = Number(ws[cellRef].v);
            if (val > 1) {
              // Green background
              ws[cellRef].s.fill = {
                fgColor: { rgb: 'C6EFCE' }
              };
            } else if (val <= 0) {
              // Red background
              ws[cellRef].s.fill = {
                fgColor: { rgb: 'FFC7CE' }
              };
            }
          }

          // HEADER
          if (R === 0) {

            ws[cellRef].s.font = {
              bold: true,
              sz: 12
            };

            ws[cellRef].s.fill = {
              fgColor: {
                rgb: 'D9E2F3'
              }
            };

            ws[cellRef].s.alignment = {
              horizontal: 'center',
              vertical: 'center'
            };
          }
        }
      }

      // ============================================
      // WORKBOOK
      // ============================================

      const wb =
        XLSX.utils.book_new();

      XLSX.utils.book_append_sheet(
        wb,
        ws,
        'Packing Slip'
      );

      // ============================================
      // BUFFER
      // ============================================

      const buffer = XLSX.write(wb, {
        type: 'buffer',
        bookType: 'xlsx'
      });

      // ============================================
      // RESPONSE
      // ============================================

      const fileName =
        `PACKING_SLIP_${new Date()
          .toISOString()
          .split('T')[0]}.xlsx`;

      res.setHeader(
        'Content-Disposition',
        `attachment; filename="${fileName}"`
      );

      res.setHeader(
        'Content-Type',
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
      );

      return res.send(buffer);

    } catch (err) {

      console.error(
        'Packing slip report error:',
        err
      );

      res.status(500).json({
        success: false,
        message:
          'Failed to generate packing slip',
        error: err.message
      });
    }
  }
);

router.post(
  '/sync-orders-chunk',
  authenticateToken,
  async (req, res) => {

    try {

      const skip =
        Number(req.body.skip || 0);

      const limit =
        Number(req.body.limit || 1000);

      // ============================================
      // FETCH ORDERS
      // ============================================

      const orders =
        await fetchShopifyOrdersChunk({
          skip,
          limit,
        });

      console.log(
        `Fetched ${orders.length} orders`
      );

      // ============================================
      // SAVE TO DB
      // ============================================

      await batchUpsertOrders(orders);
      invalidateMetaCache();

      return res.json({
        success: true,
        skip,
        limit,
        fetched: orders.length,
        synced: orders.length,
      });

    } catch (err) {

      console.error(
        'Chunk sync error:',
        err
      );

      return res.status(500).json({
        success: false,
        message: err.message,
      });
    }
  }
);

router.get('/', authenticateToken, async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 50;
    const offset = (page - 1) * limit;

    const { whereSql, queryParams } = buildOrderFilters(req.query);

    const sort = req.query.sort || 'created_at';
    const direction = req.query.direction || 'DESC';
    const validSortCols = ['created_at', 'order_number', 'total_price', 'financial_status', 'fulfillment_status'];
    const orderBy = validSortCols.includes(sort) ? sort : 'created_at';
    const orderDir = direction.toUpperCase() === 'ASC' ? 'ASC' : 'DESC';

    // Stats + paginated data run in parallel — each uses its own pool connection
    const [[statsRows], [rows]] = await Promise.all([
      pool.query(
        `SELECT
          COUNT(*) as total,
          COALESCE(SUM(total_price), 0) as total_revenue,
          COUNT(CASE WHEN fulfillment_status = 'fulfilled' THEN 1 END) as fulfilled_count,
          COUNT(CASE WHEN fulfillment_status IS NULL OR fulfillment_status = 'unfulfilled' THEN 1 END) as pending_count,
          COALESCE(SUM(total_quantity), 0) as total_products,
          COALESCE(SUM(CASE WHEN tags IS NOT NULL AND tags != '' THEN total_quantity ELSE 0 END), 0) as tagged_products,
          COALESCE(SUM(CASE WHEN tags IS NULL OR tags = '' THEN total_quantity ELSE 0 END), 0) as untagged_products
        FROM orders ${whereSql}`,
        queryParams
      ),
      pool.query(
        `SELECT orders.* FROM orders ${whereSql} ORDER BY ${orderBy} ${orderDir} LIMIT ? OFFSET ?`,
        [...queryParams, limit, offset]
      ),
    ]);
    const stats = statsRows[0];
    const total = stats.total;

    const orders = rows.map(rowToOrder);

    res.json({
      orders,
      pagination: {
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit),
      },
      stats: {
        total: stats.total,
        revenue: parseFloat(stats.total_revenue || 0),
        fulfilled: stats.fulfilled_count,
        pending: stats.pending_count,
        fulfillment_rate: stats.total ? Math.round((stats.fulfilled_count / stats.total) * 100) : 0,
        total_products: stats.total_products || 0,
        tagged_products: stats.tagged_products || 0,
        untagged_products: stats.untagged_products || 0
      },
      source: 'database'
    });
  } catch (err) {
    console.error('Error fetching orders from DB:', err);
    res.status(500).json({ message: 'Failed to fetch orders from database', error: err.message });
  }
});

router.post('/sync-products', authenticateToken, async (req, res) => {
  try {
    const products = await fetchShopifyProducts();
    await batchUpsertProducts(products);
    invalidateMetaCache();
    res.json({ message: `Synced ${products.length} products from Shopify.`, synced: products.length });
  } catch (err) {
    console.error('Product sync error:', err);
    res.status(500).json({ message: 'Product sync failed', error: err.message });
  }
});

router.post('/sync-customers', authenticateToken, async (req, res) => {
  try {
    const customers = await fetchShopifyCustomers();
    await batchUpsertCustomers(customers);
    res.json({ message: `Synced ${customers.length} customers from Shopify.`, synced: customers.length });
  } catch (err) {
    console.error('Customer sync error:', err);
    res.status(500).json({ message: 'Customer sync failed', error: err.message });
  }
});

// ─── POST /api/orders/sync — pull from Shopify, store in MySQL ───────────────
router.post('/sync', authenticateToken, async (req, res) => {
  try {
    // ============================================
    // FETCH DATA FROM SHOPIFY
    // ============================================

    const shopifyCustomers =
      await fetchShopifyCustomers();

    const shopifyProducts =
      await fetchShopifyProducts();

    const shopifyOrders =
      await fetchShopifyOrders();

    // ============================================
    // SYNC ORDERS
    // ============================================

    // ============================================
    // SYNC CUSTOMERS FIRST
    // ============================================

    // Run customers + products in parallel, then orders (which may ref customers)
    const [,] = await Promise.all([
      batchUpsertCustomers(shopifyCustomers),
      batchUpsertProducts(shopifyProducts),
    ]);
    await batchUpsertOrders(shopifyOrders);
    invalidateMetaCache();

    res.json({
      success: true,
      message: 'Shopify sync completed successfully.',
      synced: {
        orders: shopifyOrders.length,
        products: shopifyProducts.length,
        customers: shopifyCustomers.length,
      },
    });
  } catch (err) {
    console.error('Sync error:', err);

    res.status(500).json({
      success: false,
      message: 'Shopify sync failed',
      error: err.message,
    });
  }
});

router.get(
  '/job-status/:jobId',
  authenticateToken,
  async (req, res) => {

    const job =
      backgroundJobs.get(
        req.params.jobId
      );

    if (!job) {
      return res.status(404).json({
        message: 'Job not found'
      });
    }

    res.json(job);
  }
);

// ─── POST /api/orders/bulk-tag — Add a tag to multiple orders ────────────────
router.post(
  '/bulk-tag',
  authenticateToken,
  async (req, res) => {

    try {

      const {
        orderIds,
        tag
      } = req.body;

      // ============================================
      // VALIDATION
      // ============================================

      if (
        !orderIds ||
        !Array.isArray(orderIds) ||
        !tag
      ) {

        return res.status(400).json({
          message:
            'orderIds array and tag string are required'
        });
      }

      // ============================================
      // CREATE BACKGROUND JOB
      // ============================================

      const jobId =
        `tag_${Date.now()}`;

      backgroundJobs.set(jobId, {
        id: jobId,
        type: 'bulk-tag',
        status: 'processing',
        progress: 0,
        total: orderIds.length,
        completed: 0,
        failed: 0,
        results: [],
      });

      // ============================================
      // RETURN IMMEDIATELY
      // ============================================

      res.json({
        success: true,
        background: true,
        jobId,
        message:
          'Tagging started in background'
      });

      // ============================================
      // RUN BACKGROUND PROCESS
      // ============================================

      (async () => {

        try {

          // ============================================
          // IMPORT SERVICES
          // ============================================

          const {
            bulkTagOrders,
            fetchOrder
          } = await import(
            '../services/shopify.js'
          );

          // ============================================
          // UPDATE SHOPIFY TAGS
          // ============================================

          const {
            results,
            successfulIds
          } =
            await bulkTagOrders(
              orderIds,
              tag,

              // progress callback
              (progressData) => {

                backgroundJobs.set(
                  jobId,
                  {
                    ...backgroundJobs.get(jobId),
                    ...progressData,
                  }
                );
              }
            );

          // ============================================
          // SYNC SUCCESSFUL ORDERS TO DB
          // AFTER ALL TAGS UPDATED
          // ============================================

          for (const orderId of successfulIds) {

            try {

              console.log(
                `🔄 Syncing order ${orderId}`
              );

              const updatedOrder =
                await fetchOrder(orderId);

              await upsertOrder(
                updatedOrder
              );

              // prevent throttling
              if (successfulIds.length > 1) {
                await new Promise(resolve =>
                  setTimeout(resolve, 3000)
                );
              }

            } catch (syncErr) {

              console.error(
                `❌ Failed syncing order ${orderId}`,
                syncErr.message
              );
            }
          }

          // ============================================
          // FINAL COUNTS
          // ============================================

          const successCount =
            results.filter(
              r => r.success
            ).length;

          const failedCount =
            results.filter(
              r => !r.success
            ).length;

          // ============================================
          // COMPLETE JOB
          // ============================================

          backgroundJobs.set(jobId, {
            ...backgroundJobs.get(jobId),
            status: 'completed',
            progress: 100,
            completed: successCount,
            failed: failedCount,
            results,
          });

          console.log(
            `✅ Bulk tagging completed: ${successCount} success, ${failedCount} failed`
          );

        } catch (err) {

          console.error(
            '❌ Background bulk tag error:',
            err
          );

          backgroundJobs.set(jobId, {
            ...backgroundJobs.get(jobId),
            status: 'failed',
            error: err.message,
          });
        }

      })();

    } catch (err) {

      console.error(
        '❌ Bulk tag route error:',
        err
      );

      res.status(500).json({
        message:
          'Bulk tagging failed',
        error: err.message
      });
    }
  }
);

// ─── POST /api/orders/bulk-fulfill — Fulfill multiple orders ────────────────
router.post(
  '/bulk-fulfill',
  authenticateToken,
  async (req, res) => {

    try {

      const {
        orderIds
      } = req.body;

      // ============================================
      // VALIDATION
      // ============================================

      if (
        !orderIds ||
        !Array.isArray(orderIds)
      ) {

        return res.status(400).json({
          message:
            'orderIds array is required'
        });
      }

      // ============================================
      // CREATE BACKGROUND JOB
      // ============================================

      const jobId =
        `fulfill_${Date.now()}`;

      backgroundJobs.set(jobId, {
        id: jobId,
        type: 'bulk-fulfill',
        status: 'processing',
        progress: 0,
        total: orderIds.length,
        completed: 0,
        failed: 0,
        results: [],
      });

      // ============================================
      // IMMEDIATE RESPONSE
      // ============================================

      res.json({
        success: true,
        background: true,
        jobId,
        message:
          'Bulk fulfillment started in background'
      });

      // ============================================
      // RUN IN BACKGROUND
      // ============================================

      setTimeout(async () => {

        try {

          const {
            markOrdersFulfilled,
            fetchOrder,
          } = await import(
            '../services/shopify.js'
          );

          // ============================================
          // START FULFILLMENT
          // ============================================

          const {
            results,
            successfulIds
          } =
            await markOrdersFulfilled(
              orderIds,
              true,

              // progress callback
              (progressData) => {

                backgroundJobs.set(
                  jobId,
                  {
                    ...backgroundJobs.get(jobId),
                    ...progressData,
                  }
                );
              }
            );

          // ============================================
          // WAIT BEFORE SYNC
          // Shopify needs time
          // ============================================

          console.log(
            '⏳ Waiting before DB sync...'
          );

          if (successfulIds.length > 1) {

            await new Promise(resolve =>
              setTimeout(resolve, 15000)
            );
          }

          // ============================================
          // SYNC UPDATED ORDERS
          // ============================================

          for (const orderId of successfulIds) {

            try {

              console.log(
                `🔄 Syncing fulfilled order ${orderId}`
              );

              const updatedOrder =
                await fetchOrder(orderId);

              await upsertOrder(
                updatedOrder
              );

              if (successfulIds.length > 1) {
                // avoid Shopify throttle
                await new Promise(resolve =>
                  setTimeout(resolve, 4000)
                );
              }

            } catch (syncErr) {

              console.error(
                `❌ Failed syncing fulfilled order ${orderId}`,
                syncErr.message
              );
            }
          }

          // ============================================
          // FINAL COUNTS
          // ============================================

          const successCount =
            results.filter(
              r => r.success
            ).length;

          const failedCount =
            results.filter(
              r => !r.success
            ).length;

          // ============================================
          // COMPLETE JOB
          // ============================================

          backgroundJobs.set(jobId, {
            ...backgroundJobs.get(jobId),
            status: 'completed',
            progress: 100,
            completed: successCount,
            failed: failedCount,
            results,
          });

          console.log(
            `✅ Bulk fulfillment completed`
          );

        } catch (err) {

          console.error(
            '❌ Background fulfill error:',
            err
          );

          backgroundJobs.set(jobId, {
            ...backgroundJobs.get(jobId),
            status: 'failed',
            error: err.message,
          });
        }

      }, orderIds.length > 1 ? 5000 : 0);

    } catch (err) {

      console.error(
        '❌ Bulk fulfill route error:',
        err
      );

      res.status(500).json({
        message:
          'Bulk fulfillment failed',
        error: err.message
      });
    }
  }
);

// ─── Royal Mail Click & Drop integration ─────────────────────────────────────

// POST /api/orders/royal-mail-create
// Body: { orderIds: [], despatchDate: 'YYYY-MM-DD' }
// Creates shipments in Royal Mail Click & Drop; returns tracking numbers.
router.post('/royal-mail-create', authenticateToken, async (req, res) => {
  try {
    const { createShipment, isConfigured } = await import('../services/royalMail.js');

    if (!isConfigured()) {
      return res.status(503).json({ message: 'Royal Mail API token not configured. Set ROYAL_MAIL_OBA_TOKEN in .env' });
    }

    const { orderIds = [], despatchDate } = req.body;
    if (!orderIds.length) return res.status(400).json({ message: 'orderIds is required' });

    const placeholders = orderIds.map(() => '?').join(',');
    const [rows] = await pool.query(
      `SELECT raw_data FROM orders WHERE id IN (${placeholders})`,
      orderIds
    );
    const orders = rows
      .map(r => (typeof r.raw_data === 'string' ? JSON.parse(r.raw_data) : r.raw_data))
      .filter(Boolean);

    const results = [];
    for (const order of orders) {
      try {
        const result = await createShipment(order, despatchDate);
        results.push({ success: true, ...result });
      } catch (err) {
        const msg = err.response?.data?.message || JSON.stringify(err.response?.data) || err.message;
        results.push({
          success: false,
          shopifyOrderId: order.id,
          orderNumber: order.order_number,
          error: msg,
        });
      }
      await new Promise(r => setTimeout(r, 300));
    }

    const succeeded = results.filter(r => r.success);
    const failed = results.filter(r => !r.success);
    res.json({ total: results.length, succeeded: succeeded.length, failed: failed.length, results });
  } catch (err) {
    console.error('royal-mail-create error:', err);
    res.status(500).json({ message: err.message });
  }
});

// POST /api/orders/royal-mail-labels
// Body: { rmOrderIdentifiers: ['uuid1', ...] }
// Fetches label PDFs from Royal Mail, merges them into a single PDF.
router.post('/royal-mail-labels', authenticateToken, async (req, res) => {
  try {
    const { getLabel, mergeLabels, isConfigured } = await import('../services/royalMail.js');

    if (!isConfigured()) {
      return res.status(503).json({ message: 'Royal Mail API token not configured.' });
    }

    const { rmOrderIdentifiers = [] } = req.body;
    if (!rmOrderIdentifiers.length) return res.status(400).json({ message: 'rmOrderIdentifiers is required' });

    const pdfBuffers = [];
    const errors = [];

    let firstErrStatus = null;
    let firstErrMsg = null;
    for (const id of rmOrderIdentifiers) {
      let buf = null;
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          buf = await getLabel(id);
          break;
        } catch (e) {
          if (!firstErrStatus) {
            firstErrStatus = e?.response?.status;
            const raw = e?.response?.data;
            const parsed = raw ? (() => { try { return JSON.parse(Buffer.from(raw).toString()); } catch { return null; } })() : null;
            firstErrMsg = parsed?.message || e.message;
          }
          await new Promise(r => setTimeout(r, 2000));
        }
      }
      if (buf) pdfBuffers.push(buf);
      else errors.push(id);
      await new Promise(r => setTimeout(r, 200));
    }

    if (!pdfBuffers.length) {
      if (firstErrStatus === 403 || firstErrStatus === 401) {
        return res.status(403).json({
          needsTokenSetup: true,
          message: 'The OBA token does not have "Download labels" permission. In Click & Drop go to Settings → OBA API tokens and enable "Download labels" for this token, then try again.',
          httpStatus: firstErrStatus,
          detail: firstErrMsg,
          errors,
        });
      }
      let hint = '';
      if (firstErrStatus === 404) hint = ' — Labels not generated yet. Apply postage in Click & Drop first, then retry.';
      else hint = ' — Postage may not have been applied yet in Click & Drop.';
      return res.status(404).json({ message: `No labels could be retrieved${hint}`, httpStatus: firstErrStatus, detail: firstErrMsg, errors });
    }

    const mergedPdf = await mergeLabels(pdfBuffers);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="royal_mail_labels_${new Date().toISOString().slice(0, 10)}.pdf"`);
    if (errors.length) res.setHeader('X-Failed-Labels', errors.join(','));
    res.send(mergedPdf);
  } catch (err) {
    console.error('royal-mail-labels error:', err);
    res.status(500).json({ message: err.message });
  }
});

// ─── POST /api/orders/royal-mail-auto-process ────────────────────────────────
// Body: { orderIds: [], despatchDate: 'YYYY-MM-DD' }
// Flow:
//   1. Fetch all Click & Drop orders; match to our Shopify orders by orderReference.
//   2. For any order NOT yet in Click & Drop: create with postageDetails+label → get inline label.
//   3. Download labels for matched (existing) orders via GET /orders/{id}/label.
//   4. Return merged PDF; or JSON if no labels ready yet.
router.post('/royal-mail-auto-process', authenticateToken, async (req, res) => {
  try {
    const { createShipment, listOrders, getLabel, mergeLabels, isConfigured } = await import('../services/royalMail.js');

    if (!isConfigured()) {
      return res.status(503).json({ message: 'ROYAL_MAIL_OBA_TOKEN not set in .env' });
    }

    const { orderIds = [], despatchDate } = req.body;
    if (!orderIds.length) return res.status(400).json({ message: 'orderIds is required' });

    // Load our Shopify orders from DB
    const placeholders = orderIds.map(() => '?').join(',');
    const [rows] = await pool.query(
      `SELECT id, order_number, raw_data FROM orders WHERE id IN (${placeholders})`,
      orderIds
    );
    const shopifyOrders = rows
      .map(r => (typeof r.raw_data === 'string' ? JSON.parse(r.raw_data) : r.raw_data))
      .filter(Boolean);

    // Map from order_number → DB id so we can return processed Shopify IDs to the frontend
    const dbIdByNum = new Map();
    rows.forEach(r => dbIdByNum.set(String(r.order_number), String(r.id)));

    // Phase 1 — fetch all existing Click & Drop orders and match by order_number
    const rmOrders = await listOrders(250);
    const rmByRef = new Map();
    rmOrders.forEach(o => {
      const ref = String(o.orderReference || '').replace(/^#/, '');
      rmByRef.set(ref, o);
    });

    const toCreate = [];
    const matchedIdentifiers = []; // already in Click & Drop with tracking
    const processedShopifyIds = []; // DB ids of orders that made it into Click & Drop
    const trackingNumbers = {};     // shopifyId → trackingNumber

    for (const order of shopifyOrders) {
      const num = String(order.order_number).replace(/^#/, '');
      const existing = rmByRef.get(num);
      const shopifyId = dbIdByNum.get(num) || String(order.id);
      if (existing?.trackingNumber) {
        // Already imported + postage applied — use existing identifier
        matchedIdentifiers.push(existing.orderIdentifier);
        processedShopifyIds.push(shopifyId);
        trackingNumbers[shopifyId] = existing.trackingNumber;
      } else if (existing && !existing.trackingNumber) {
        // In Click & Drop but no postage yet — include identifier, label attempt will fail gracefully
        matchedIdentifiers.push(existing.orderIdentifier);
        processedShopifyIds.push(shopifyId);
      } else {
        // Not in Click & Drop at all — need to create
        toCreate.push(order);
      }
    }

    // Phase 2 — create only orders not already in Click & Drop
    // createShipment now applies postage + returns inline label in response (no separate download needed)
    const createdIdentifiers = [];
    const createdLabels = []; // inline labels from creation response
    const failedOrders = [];
    for (const order of toCreate) {
      try {
        const r = await createShipment(order, despatchDate);
        createdIdentifiers.push(r.orderIdentifier);
        if (r.labelBuffer) createdLabels.push(r.labelBuffer);
        const shopifyId = dbIdByNum.get(String(order.order_number).replace(/^#/, '')) || String(order.id);
        processedShopifyIds.push(shopifyId);
        if (r.trackingNumber) trackingNumbers[shopifyId] = r.trackingNumber;
      } catch (err) {
        const raw = err.response?.data;
        const msg = raw?.message || JSON.stringify(raw) || err.message;
        if (err.response?.status === 401 || err.response?.status === 403) {
          return res.status(403).json({ needsTokenSetup: true, message: 'Royal Mail token auth failed.' });
        }
        failedOrders.push({ orderNumber: order.order_number, error: msg });
      }
      await new Promise(r => setTimeout(r, 300));
    }

    const allIdentifiers = [...matchedIdentifiers, ...createdIdentifiers];
    if (!allIdentifiers.length) {
      return res.status(502).json({
        message: 'No orders could be matched or created in Click & Drop.',
        errors: failedOrders.map(r => `#${r.orderNumber}: ${r.error}`),
      });
    }

    // Expose successfully-processed Shopify IDs + tracking numbers for auto-fulfillment after manifest
    res.setHeader('X-Processed-Shopify-Ids', processedShopifyIds.join(','));
    res.setHeader('X-Tracking-Numbers', JSON.stringify(trackingNumbers));

    // Phase 3 — download labels for matched (existing) orders; new orders already have inline labels
    const pdfBuffers = [...createdLabels]; // inline labels from new orders first
    const labelErrors = [];
    for (const id of matchedIdentifiers) {
      let got = false;
      let lastErr = null;
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const buf = await getLabel(id);
          if (buf) { pdfBuffers.push(buf); got = true; break; }
        } catch (e) {
          lastErr = e;
          await new Promise(r => setTimeout(r, 1500));
        }
      }
      if (!got) {
        const status = lastErr?.response?.status;
        const detail = lastErr?.response?.data
          ? (() => { try { return JSON.parse(Buffer.from(lastErr.response.data).toString()); } catch { return null; } })()
          : null;
        labelErrors.push({ id, status, message: detail?.message || lastErr?.message });
        console.warn(`[RM labels] Failed for ${id}: HTTP ${status}`, detail || lastErr?.message);
      }
      await new Promise(r => setTimeout(r, 200));
    }

    const date = despatchDate || new Date().toISOString().slice(0, 10);

    if (!pdfBuffers.length) {
      // Determine likely cause from label errors
      const statuses = labelErrors.map(e => e.status).filter(Boolean);
      const has403 = statuses.includes(403) || statuses.includes(401);
      const has404 = statuses.includes(404);

      // 403 = token missing "Download labels" permission → show token setup screen
      if (has403) {
        return res.status(403).json({
          needsTokenSetup: true,
          message: 'The OBA token does not have "Download labels" permission. In Click & Drop go to Settings → OBA API tokens and enable "Download labels" for this token, then try again.',
          identifiers: allIdentifiers,
          processedShopifyIds,
          trackingNumbers,
        });
      }

      let reason = 'Postage may not have been applied yet in Click & Drop.';
      if (has404) reason = 'Labels are not yet generated. Go to Click & Drop, apply postage/shipping rules to these orders, then come back and click "Download Tracked 48 Labels".';
      return res.status(200).json({
        ordersCreated: true,
        identifiers: allIdentifiers,
        processedShopifyIds,
        trackingNumbers,
        labelsReady: false,
        matched: matchedIdentifiers.length,
        created: createdIdentifiers.length,
        labelErrors: labelErrors.slice(0, 5),
        message: `${allIdentifiers.length} order(s) found in Click & Drop but labels could not be downloaded. ${reason}`,
        failed: failedOrders.map(r => r.orderNumber),
      });
    }

    const mergedPdf = await mergeLabels(pdfBuffers, 1);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="royal_mail_labels_${date}.pdf"`);
    res.setHeader('X-Shipment-Count', String(pdfBuffers.length));
    res.setHeader('X-Order-Identifiers', allIdentifiers.join(','));
    if (failedOrders.length) {
      res.setHeader('X-Failed-Orders', failedOrders.map(r => r.orderNumber).join(','));
    }
    res.send(mergedPdf);
  } catch (err) {
    console.error('royal-mail-auto-process error:', err);
    res.status(500).json({ message: err.message });
  }
});

// POST /api/orders/royal-mail-manifest
// Body: { orderIdentifiers: [] } — required; manifests ONLY the specified orders.
// Returns manifest PDF if available. Rejects with 400 if identifiers are missing.
router.post('/royal-mail-manifest', authenticateToken, async (req, res) => {
  try {
    const { createManifest, getManifestLabel, isConfigured } = await import('../services/royalMail.js');
    const { markOrdersFulfilled } = await import('../services/shopify.js');

    if (!isConfigured()) {
      return res.status(503).json({ message: 'Royal Mail API token not configured.' });
    }

    const { orderIdentifiers, shopifyOrderIds = [], trackingNumbers = {} } = req.body || {};
    if (!orderIdentifiers?.length) {
      return res.status(400).json({ message: 'orderIdentifiers is required — run the Royal Mail labelling step first to get order identifiers, then manifest only those orders.' });
    }
    const manifest = await createManifest(orderIdentifiers);

    console.log(shopifyOrderIds, "shopifyOrderIds");

    // Auto-fulfill orders in Shopify with tracking numbers and notify customers
    const fulfillmentResults = [];
    if (shopifyOrderIds.length) {
      try {
        const ordersToFulfill = shopifyOrderIds.map(id => ({
          shopifyId: String(id),
          trackingNumber: trackingNumbers[String(id)] || null,
        }));
        const fulfillRes = await markOrdersFulfilled(ordersToFulfill, true);
        fulfillmentResults.push(...(fulfillRes.results || []));
        console.log(`[Manifest] Auto-fulfilled ${fulfillRes.successfulIds?.length || 0}/${shopifyOrderIds.length} orders`);
      } catch (fulfillErr) {
        console.error('[Manifest] Auto-fulfill error (non-fatal):', fulfillErr.message);
      }
    }

    // The API returns { manifestNumber, documentPdf: base64 } directly — no polling needed
    if (manifest.documentPdf) {
      const pdfBuf = Buffer.from(manifest.documentPdf, 'base64');
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="manifest_${manifest.manifestNumber || 'rm'}.pdf"`);
      res.setHeader('X-Manifest-Number', String(manifest.manifestNumber || ''));
      res.setHeader('X-Fulfilled-Count', String(fulfillmentResults.filter(r => r.success).length));
      return res.send(pdfBuf);
    }

    // Fallback: older GUID-based response (poll for PDF)
    const manifestGuid = manifest.manifests?.[0];
    if (manifestGuid) {
      const pdfBuf = await getManifestLabel(manifestGuid);
      if (pdfBuf) {
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `attachment; filename="manifest_${manifestGuid}.pdf"`);
        res.setHeader('X-Manifest-Id', manifestGuid);
        res.setHeader('X-Fulfilled-Count', String(fulfillmentResults.filter(r => r.success).length));
        return res.send(pdfBuf);
      }
    }

    res.json({ ...manifest, fulfillmentResults });
  } catch (err) {
    const apiData = err.response?.data;
    const errCodes = apiData?.errors?.map(e => e.code) || [];
    // NO_ELIGIBLE_ORDERS — all orders already manifested, or none in printed state
    if (errCodes.includes('NO_ELIGIBLE_ORDERS') || errCodes.includes('CARRIER_NOT_FOUND')) {
      return res.status(400).json({
        message: "Royal Mail: no orders are ready to manifest. Possible reasons: (1) these orders were already manifested in a previous run, (2) postage has not been applied yet in Click & Drop, or (3) the orders are test/cancelled orders that cannot be manifested.",
        code: 'NO_ELIGIBLE_ORDERS',
      });
    }
    const apiMsg = apiData?.message || apiData?.errors?.map(e => e.description).join('; ') || err.message;
    console.error('royal-mail-manifest error:', apiMsg);
    res.status(500).json({ message: apiMsg });
  }
});

// ─── POST /api/orders/royal-mail-full-process ────────────────────────────────
// Body: { orderIds: [], despatchDate: 'YYYY-MM-DD' }
// All-in-one Royal Mail flow. Returns ONE merged PDF:
//   [S/17 packing slips with Tracked 48 label embedded] + [Manifest] + [Order Records]
// The Tracked 48 label is embedded in the S/17 peelable section — no separate label pages.
router.post('/royal-mail-full-process', authenticateToken, async (req, res) => {
  try {
    const { createShipment, listOrders, getLabel, mergeLabels, isConfigured } = await import('../services/royalMail.js');
    const { markOrdersFulfilled, fetchOrder } = await import('../services/shopify.js');
    const { buildS17Pdf, buildRecordPdf } = await import('./preorders.js');

    if (!isConfigured()) return res.status(503).json({ message: 'ROYAL_MAIL_OBA_TOKEN not set in .env' });

    const { orderIds = [], despatchDate } = req.body;
    if (!orderIds.length) return res.status(400).json({ message: 'orderIds is required' });

    // ── 1. Load orders from DB ─────────────────────────────────────────────────
    const placeholders = orderIds.map(() => '?').join(',');
    const [rows] = await pool.query(
      `SELECT id, order_number, raw_data FROM orders WHERE id IN (${placeholders})`,
      orderIds
    );
    const shopifyOrders = rows.map(r => typeof r.raw_data === 'string' ? JSON.parse(r.raw_data) : r.raw_data).filter(Boolean);
    const dbIdByNum = new Map(rows.map(r => [String(r.order_number), String(r.id)]));

    // ── 2. Match existing Click & Drop orders by orderReference ───────────────
    const rmOrders = await listOrders(250);
    const rmByRef = new Map();
    rmOrders.forEach(o => rmByRef.set(String(o.orderReference || '').replace(/^#/, ''), o));

    // Track per-order: { order, rmId, shopifyId } so we can download labels keyed by order.id
    const ordersToLabel = []; // { order, rmId } — matched orders that already have an RM entry
    const processedShopifyIds = [];
    const trackingNumbers = {};
    const toCreate = [];

    for (const order of shopifyOrders) {
      const num = String(order.order_number).replace(/^#/, '');
      const existing = rmByRef.get(num);
      const shopifyId = dbIdByNum.get(num) || String(order.id);
      if (existing?.trackingNumber) {
        ordersToLabel.push({ order, rmId: existing.orderIdentifier });
        processedShopifyIds.push(shopifyId);
        trackingNumbers[shopifyId] = existing.trackingNumber;
      } else if (existing) {
        ordersToLabel.push({ order, rmId: existing.orderIdentifier });
        processedShopifyIds.push(shopifyId);
      } else {
        toCreate.push({ order, shopifyId });
      }
    }

    // ── 3. Create shipments for orders not yet in Click & Drop ────────────────
    const allIdentifiers = ordersToLabel.map(o => o.rmId);
    const failedOrders = [];
    const labelMap = new Map(); // shopify order.id → label buffer (for S/17 embedding)
    const labelBuffers = [];    // flat list of label buffers (for standalone Tracked 48 section)

    for (const { order, shopifyId } of toCreate) {
      try {
        const r = await createShipment(order, despatchDate);
        allIdentifiers.push(r.orderIdentifier);
        processedShopifyIds.push(shopifyId);
        if (r.trackingNumber) trackingNumbers[shopifyId] = r.trackingNumber;
        if (r.labelBuffer) {
          labelMap.set(String(order.id), r.labelBuffer);
          labelBuffers.push(r.labelBuffer);
        }
      } catch (err) {
        if (err.response?.status === 401 || err.response?.status === 403) {
          return res.status(403).json({ needsTokenSetup: true, message: 'Royal Mail token auth failed — check ROYAL_MAIL_OBA_TOKEN.' });
        }
        failedOrders.push({ orderNumber: order.order_number, error: err.message });
      }
      await new Promise(r => setTimeout(r, 300));
    }

    if (!allIdentifiers.length) {
      return res.status(502).json({ message: 'No orders could be matched or created in Click & Drop.', errors: failedOrders.map(r => `#${r.orderNumber}: ${r.error}`) });
    }

    // ── 4. Download labels for matched orders ─────────────────────────────────
    const labelErrors = [];
    for (const { order, rmId } of ordersToLabel) {
      let got = false;
      let lastErr = null;
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const buf = await getLabel(rmId);
          if (buf) {
            labelMap.set(String(order.id), buf);
            labelBuffers.push(buf);
            got = true;
            break;
          }
        } catch (e) {
          lastErr = e;
          await new Promise(r => setTimeout(r, 1500));
        }
      }
      if (!got) labelErrors.push({ id: rmId, status: lastErr?.response?.status, message: lastErr?.message });
      await new Promise(r => setTimeout(r, 200));
    }

    if (!labelMap.size) {
      const has403 = labelErrors.some(e => e.status === 403 || e.status === 401);
      if (has403) {
        return res.status(403).json({
          needsTokenSetup: true,
          identifiers: allIdentifiers, processedShopifyIds, trackingNumbers,
          message: 'OBA token missing "Download labels" permission. In Click & Drop → Settings → OBA API tokens → enable "Download labels".',
        });
      }
      return res.status(200).json({
        labelsReady: false,
        identifiers: allIdentifiers, processedShopifyIds, trackingNumbers,
        message: 'Labels not yet generated — go to Click & Drop, apply postage to these orders, then retry.',
        failed: failedOrders.map(r => r.orderNumber),
      });
    }

    // ── 5. Tracked 48 labels PDF (2 copies each) ──────────────────────────────
    let labelsPdf = null;
    try {
      labelsPdf = await mergeLabels(labelBuffers, 1);
    } catch (labErr) {
      console.warn('[FullProcess] Labels merge failed (non-fatal):', labErr.message);
    }

    // ── 6. S/17 packing slips (plain label area at bottom for physical label) ──
    let s17Pdf = null;
    let s17Error = '';
    try {
      const processedRows = rows.filter(r => processedShopifyIds.includes(String(r.id)));
      const processedOrders = processedRows
        .map(r => typeof r.raw_data === 'string' ? JSON.parse(r.raw_data) : r.raw_data)
        .filter(Boolean);
      s17Pdf = Buffer.from(await buildS17Pdf(processedOrders, labelMap));
    } catch (s17Err) {
      s17Error = s17Err.message;
      console.warn('[FullProcess] S/17 PDF failed:', s17Err.message);
    }

    // ── 8. Order records PDF ──────────────────────────────────────────────────
    let recordsPdf = null;
    let recordsError = '';
    try {
      const processedRows = rows.filter(r => processedShopifyIds.includes(String(r.id)));
      const processedOrders = processedRows.map(r => typeof r.raw_data === 'string' ? JSON.parse(r.raw_data) : r.raw_data).filter(Boolean);
      if (processedOrders.length) recordsPdf = Buffer.from(await buildRecordPdf(processedOrders));
    } catch (recErr) {
      recordsError = recErr.message;
      console.warn('[FullProcess] Order records PDF failed (non-fatal):', recErr.message);
    }

    // ── 9. Merge all four sections into ONE PDF ────────────────────────────────
    // Order: Tracked 48 Labels → S/17 Packing Slips → Manifest → Order Records
    // const sections = [labelsPdf, s17Pdf, recordsPdf].filter(Boolean);
    const sections = [s17Pdf].filter(Boolean);
    const finalPdf = await mergeLabels(sections, 1);

    // ── 10. Auto-fulfill in Shopify + send notification email ────────────────
    // processedShopifyIds holds DB row IDs (used for row filtering above).
    // Shopify fulfillment API needs the actual Shopify order ID from raw_data.id.
    let fulfilledCount = 0;
    const fulfillErrors = [];
    if (processedShopifyIds.length) {
      try {
        const dbToApiId = new Map();
        for (const row of rows) {
          if (!processedShopifyIds.includes(String(row.id))) continue;
          const raw = typeof row.raw_data === 'string' ? JSON.parse(row.raw_data) : row.raw_data;
          if (raw?.id) dbToApiId.set(String(row.id), { shopifyApiId: String(raw.id), raw, row });
        }

        const ordersToFulfill = [...dbToApiId.values()].map(({ shopifyApiId, row }) => ({
          shopifyId: shopifyApiId,
          trackingNumber: trackingNumbers[String(row.id)] || null,
        }));

        const fulfillRes = await markOrdersFulfilled(ordersToFulfill, true);
        const fulfilled = fulfillRes.results?.filter(r => r.success) || [];
        const failed = fulfillRes.results?.filter(r => !r.success) || [];
        fulfilledCount = fulfilled.length;
        failed.forEach(f => fulfillErrors.push(`${f.id}: ${f.error}`));

        // Sync fulfillment status back to local DB so the app reflects Shopify's state
        const fulfilledApiIds = new Set(fulfilled.map(f => String(f.id)));
        console.log(fulfilledApiIds, "fulfilledApiIds");
        for (const { shopifyApiId, row } of dbToApiId.values()) {
          if (!fulfilledApiIds.has(shopifyApiId)) continue;
          try {
            const updatedOrder = await fetchOrder(shopifyApiId);
            if (updatedOrder) await upsertOrder(updatedOrder);
          } catch (dbSyncErr) {
            console.warn(`[FullProcess] DB sync failed for ${row.order_number}:`, dbSyncErr.message);
          }
        }

        console.log(fulfilled, "fulfilled");

        // Send notification emails for fulfilled orders
        if (fulfilled.length) {
          const { sendOrderNotification, isConfigured: emailConfigured } = await import('../services/email.js');
          if (emailConfigured()) {
            for (const { shopifyApiId, raw, row } of dbToApiId.values()) {
              if (!fulfilledApiIds.has(shopifyApiId)) continue;
              try {
                const tracking = trackingNumbers[String(row.id)]
                  ? { trackingNumber: trackingNumbers[String(row.id)], carrier: 'Royal Mail' }
                  : null;
                await sendOrderNotification(raw, tracking);
              } catch (mailErr) {
                console.warn(`[FullProcess] Email failed for ${row.order_number}:`, mailErr.message);
              }
            }
          }
        }
      } catch (fulfillErr) {
        console.error('[FullProcess] Shopify fulfillment error (non-fatal):', fulfillErr.message);
        fulfillErrors.push(fulfillErr.message);
      }
    }

    // ── 7. Return S/17 integrated label PDF ──────────────────────────────────
    const date = despatchDate || new Date().toISOString().slice(0, 10);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="royal_mail_${date}.pdf"`);
    res.setHeader('X-Shipment-Count', String(labelMap.size));
    res.setHeader('X-Order-Identifiers', allIdentifiers.join(','));
    res.setHeader('X-Processed-Shopify-Ids', processedShopifyIds.join(','));
    res.setHeader('X-Tracking-Numbers', JSON.stringify(trackingNumbers));
    res.setHeader('X-Fulfilled-Count', String(fulfilledCount));
    res.setHeader('X-Has-Labels', labelsPdf ? '1' : '0');
    res.setHeader('X-Has-S17', s17Pdf ? '1' : '0');
    res.setHeader('X-Has-Records', recordsPdf ? '1' : '0');
    if (recordsError) res.setHeader('X-Records-Error', recordsError.slice(0, 300));
    if (failedOrders.length) res.setHeader('X-Failed-Orders', failedOrders.map(r => r.orderNumber).join(','));
    if (fulfillErrors.length) res.setHeader('X-Fulfill-Errors', fulfillErrors.join(' | ').slice(0, 500));
    res.send(finalPdf);
  } catch (err) {
    console.error('royal-mail-full-process error:', err);
    res.status(500).json({ message: err.message });
  }
});

// ─── POST /api/orders/shipping-csv ───────────────────────────────────────────
// Body: { orderIds: [], carrier: 'Royal Mail' | 'DPD' }
router.post('/shipping-csv', authenticateToken, async (req, res) => {
  try {
    const { orderIds = [], carrier = 'Royal Mail' } = req.body;
    if (!orderIds.length) return res.status(400).json({ message: 'orderIds is required' });

    const { buildShippingCsv } = await import('./preorders.js');

    const placeholders = orderIds.map(() => '?').join(',');
    const [rows] = await pool.query(
      `SELECT raw_data FROM orders WHERE id IN (${placeholders})`,
      orderIds
    );

    const orders = rows.map(r => {
      const raw = typeof r.raw_data === 'string' ? JSON.parse(r.raw_data) : r.raw_data;
      return raw;
    }).filter(Boolean);

    const csv = buildShippingCsv(orders, carrier);
    const date = new Date().toISOString().slice(0, 10);
    const filename = `${carrier.replace(' ', '_')}_${date}.csv`;
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(csv);
  } catch (err) {
    console.error('shipping-csv error:', err);
    res.status(500).json({ message: err.message });
  }
});

// ─── POST /api/orders/royal-mail-excel ───────────────────────────────────────
// Body: { orderIds: [] }
router.post('/royal-mail-excel', authenticateToken, async (req, res) => {
  try {
    const { orderIds = [] } = req.body;
    if (!orderIds.length) return res.status(400).json({ message: 'orderIds is required' });

    const placeholders = orderIds.map(() => '?').join(',');
    const [rows] = await pool.query(
      `SELECT raw_data FROM orders WHERE id IN (${placeholders})`,
      orderIds
    );

    const orders = rows
      .map(r => (typeof r.raw_data === 'string' ? JSON.parse(r.raw_data) : r.raw_data))
      .filter(Boolean);

    const headers = [
      'Order ID', 'E-mail', 'Shipping: first name', 'Shipping: last name',
      'Shipping Address', 'Shipping: address2', 'Shipping: city',
      'Shipping: state', 'Shipping: country', 'Shipping: zipcode',
      'Notes', 'Phone', 'Weight in g (to convert)', 'Weight', 'Package Size', 'Service Code', 'Yes',
    ];

    const dataRows = orders.map(o => {
      const a = o.shipping_address || {};
      const c = o.customer || {};
      const first = c.first_name || (a.name || '').split(' ').slice(0, -1).join(' ') || '';
      const last  = c.last_name  || (a.name || '').split(' ').slice(-1)[0] || '';
      const totalG = (o.line_items || []).reduce((sum, li) => {
        return sum + (li.grams > 0 ? li.grams : 999) * (li.quantity || 1);
      }, 0) || 999;
      const tags = (o.tags || '').toLowerCase();
      const serviceCode = tags.includes('royal-mail-letter') ? 'CRL1' : 'TPS48';
      return [
        `#${o.order_number}`,
        c.email || o.email || '',
        first,
        last,
        a.address1 || '',
        a.address2 || '',
        a.city || '',
        a.province || '',
        a.country || 'United Kingdom',
        a.zip || '',
        o.note || '',
        a.phone || c.phone || '',
        totalG,
        parseFloat((totalG / 1000).toFixed(2)),
        'Parcel',
        serviceCode,
        'Yes',
      ];
    });

    const wsData = [headers, ...dataRows];
    const ws = XLSX.utils.aoa_to_sheet(wsData);

    // Column widths
    ws['!cols'] = [
      { wch: 10 }, { wch: 28 }, { wch: 14 }, { wch: 14 },
      { wch: 22 }, { wch: 14 }, { wch: 14 }, { wch: 12 },
      { wch: 16 }, { wch: 12 }, { wch: 16 }, { wch: 16 },
      { wch: 20 }, { wch: 8 }, { wch: 12 }, { wch: 14 }, { wch: 5 },
    ];

    // Style header row
    const range = XLSX.utils.decode_range(ws['!ref']);
    for (let C = range.s.c; C <= range.e.c; C++) {
      const cell = XLSX.utils.encode_cell({ r: 0, c: C });
      if (!ws[cell]) continue;
      ws[cell].s = {
        font: { bold: true, sz: 10 },
        fill: { fgColor: { rgb: 'D9E2F3' } },
        alignment: { horizontal: 'center', vertical: 'center', wrapText: true },
        border: {
          top: { style: 'thin', color: { rgb: '000000' } },
          bottom: { style: 'thin', color: { rgb: '000000' } },
          left: { style: 'thin', color: { rgb: '000000' } },
          right: { style: 'thin', color: { rgb: '000000' } },
        },
      };
    }

    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'DPD Orders');

    const buffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
    const filename = `Royal_Mail_Orders_${new Date().toISOString().slice(0, 10)}.xlsx`;
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(buffer);
  } catch (err) {
    console.error('royal-mail-excel error:', err);
    res.status(500).json({ message: err.message });
  }
});

// ─── POST /api/orders/s17-packingslips ───────────────────────────────────────
// Body: { orderIds: [] }
router.post('/s17-packingslips', authenticateToken, async (req, res) => {
  try {
    const { orderIds = [] } = req.body;
    if (!orderIds.length) return res.status(400).json({ message: 'orderIds is required' });

    const { buildS17Html } = await import('./preorders.js');

    const placeholders = orderIds.map(() => '?').join(',');
    const [rows] = await pool.query(
      `SELECT raw_data FROM orders WHERE id IN (${placeholders})`,
      orderIds
    );

    const orders = rows.map(r => {
      const raw = typeof r.raw_data === 'string' ? JSON.parse(r.raw_data) : r.raw_data;
      return raw;
    }).filter(Boolean);

    const date = new Date().toLocaleDateString('en-GB');
    const html = buildS17Html(orders, date);
    res.setHeader('Content-Type', 'text/html');
    res.send(html);
  } catch (err) {
    console.error('s17-packingslips error:', err);
    res.status(500).json({ message: err.message });
  }
});

// ─── POST /api/orders/order-records ──────────────────────────────────────────
// Body: { orderIds: [] }
// Returns a multi-page PDF — one 100mm×150mm page per order — compact packing record.
router.post('/order-records', authenticateToken, async (req, res) => {
  try {
    const { buildRecordPdf } = await import('./preorders.js');
    const { orderIds = [] } = req.body;
    if (!orderIds.length) return res.status(400).json({ message: 'orderIds is required' });

    const placeholders = orderIds.map(() => '?').join(',');
    const [rows] = await pool.query(
      `SELECT raw_data FROM orders WHERE id IN (${placeholders})`,
      orderIds
    );
    const orders = rows
      .map(r => (typeof r.raw_data === 'string' ? JSON.parse(r.raw_data) : r.raw_data))
      .filter(Boolean);

    const pdfBuffer = await buildRecordPdf(orders);
    const date = new Date().toISOString().slice(0, 10);

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="order_records_${date}.pdf"`);
    res.send(Buffer.from(pdfBuffer));
  } catch (err) {
    console.error('order-records error:', err);
    res.status(500).json({ message: err.message });
  }
});

// ─── POST /api/orders/royal-mail-s17 ─────────────────────────────────────────
// Body: { orderIds, despatchDate }
// Runs Royal Mail process (create/match + fetch individual labels) and returns
// a multi-page S/17 integrated-label PDF — one A4 per order, plain label area at bottom.
router.post('/royal-mail-s17', authenticateToken, async (req, res) => {
  try {
    const { buildS17Pdf } = await import('./preorders.js');

    const { orderIds = [], despatchDate } = req.body;
    if (!orderIds.length) return res.status(400).json({ message: 'orderIds is required' });

    // Load Shopify orders from DB
    const placeholders = orderIds.map(() => '?').join(',');
    const [rows] = await pool.query(
      `SELECT id, order_number, raw_data FROM orders WHERE id IN (${placeholders})`,
      orderIds
    );
    const shopifyOrders = rows
      .map(r => (typeof r.raw_data === 'string' ? JSON.parse(r.raw_data) : r.raw_data))
      .filter(Boolean);

    const pdfBuffer = await buildS17Pdf(shopifyOrders);
    const date = despatchDate || new Date().toISOString().slice(0, 10);

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="s17_packing_slips_${date}.pdf"`);
    res.send(Buffer.from(pdfBuffer));
  } catch (err) {
    console.error('royal-mail-s17 error:', err);
    res.status(500).json({ message: err.message });
  }
});

// ─── POST /api/orders/send-notification ──────────────────────────────────────
// Body: { orderIds: [], trackingNumbers?: { [shopifyOrderId]: { trackingNumber, carrier } } }
// Sends Brevo dispatch email to each order's customer
router.post('/send-notification', authenticateToken, async (req, res) => {
  try {
    const { orderIds = [], trackingNumbers = {} } = req.body;
    if (!orderIds.length) return res.status(400).json({ message: 'orderIds is required' });

    const { isConfigured, sendOrderNotification } = await import('../services/email.js');
    if (!isConfigured()) {
      return res.status(503).json({ message: 'Email not configured. Set EMAIL_USER and EMAIL_PASS in .env' });
    }

    const placeholders = orderIds.map(() => '?').join(',');
    const [rows] = await pool.query(
      `SELECT raw_data FROM orders WHERE id IN (${placeholders})`,
      orderIds
    );

    const orders = rows.map(r => {
      const raw = typeof r.raw_data === 'string' ? JSON.parse(r.raw_data) : r.raw_data;
      return raw;
    }).filter(Boolean);

    const results = [];
    for (const order of orders) {
      try {
        const tracking = trackingNumbers[order.id] || null;
        const result = await sendOrderNotification(order, tracking);
        results.push({ orderNumber: order.order_number, ...result, success: true });
      } catch (err) {
        results.push({
          orderNumber: order.order_number,
          error: err.message,
          success: false,
        });
      }
      await new Promise(r => setTimeout(r, 200));
    }

    res.json({ results });
  } catch (err) {
    console.error('send-notification error:', err);
    res.status(500).json({ message: err.message });
  }
});

// ─── POST /api/orders/order-packing-slips ────────────────────────────────────
// Body: { orderIds: [] }
// Returns Shopify-style per-order packing slip HTML (auto-prints)
router.post('/order-packing-slips', authenticateToken, async (req, res) => {
  try {
    const { orderIds = [] } = req.body;
    if (!orderIds.length) return res.status(400).json({ message: 'orderIds is required' });

    const { buildOrderPackingSlipHtml } = await import('./preorders.js');

    const placeholders = orderIds.map(() => '?').join(',');
    const [rows] = await pool.query(
      `SELECT raw_data FROM orders WHERE id IN (${placeholders}) ORDER BY order_number ASC`,
      orderIds
    );

    const orders = rows.map(r => {
      const raw = typeof r.raw_data === 'string' ? JSON.parse(r.raw_data) : r.raw_data;
      return raw;
    }).filter(Boolean);

    const html = buildOrderPackingSlipHtml(orders);
    res.setHeader('Content-Type', 'text/html');
    res.send(html);
  } catch (err) {
    console.error('order-packing-slips error:', err);
    res.status(500).json({ message: err.message });
  }
});

// ─── POST /api/orders/dpd-create ─────────────────────────────────────────────
// Body: { orderIds: [], despatchDate: 'YYYY-MM-DD' }
router.post('/dpd-create', authenticateToken, async (req, res) => {
  try {
    const { orderIds = [], despatchDate } = req.body;
    if (!orderIds.length) return res.status(400).json({ message: 'orderIds is required' });

    const { isConfigured, createShipment } = await import('../services/dpd.js');
    if (!isConfigured()) {
      return res.status(503).json({ message: 'DPD not configured. Set DPD_USERNAME and DPD_PASSWORD in .env' });
    }

    const placeholders = orderIds.map(() => '?').join(',');
    const [rows] = await pool.query(
      `SELECT raw_data FROM orders WHERE id IN (${placeholders})`,
      orderIds
    );

    const orders = rows.map(r => {
      const raw = typeof r.raw_data === 'string' ? JSON.parse(r.raw_data) : r.raw_data;
      return raw;
    }).filter(Boolean);

    const date = despatchDate || new Date().toISOString().slice(0, 10);

    // Run up to 3 shipments in parallel to speed up bulk creates
    const CONCURRENCY = 3;
    const results = [];
    for (let i = 0; i < orders.length; i += CONCURRENCY) {
      const batch = orders.slice(i, i + CONCURRENCY);
      const settled = await Promise.allSettled(
        batch.map(order => createShipment(order, date))
      );
      for (let j = 0; j < settled.length; j++) {
        const s = settled[j];
        if (s.status === 'fulfilled') {
          results.push(s.value);
        } else {
          const order = batch[j];
          results.push({
            orderNumber: order.order_number,
            shopifyOrderId: order.id,
            error: s.reason?.response?.data?.error?.errorMessage || s.reason?.message,
          });
        }
      }
    }

    res.json({ results });
  } catch (err) {
    console.error('dpd-create error:', err);
    res.status(500).json({ message: err.message });
  }
});

// ─── POST /api/orders/royal-mail-fetch-identifiers ───────────────────────────
// Body: { orderNumbers: [] }   (Shopify order numbers, e.g. [52846, 52848])
// Calls GET /api/v1/orders, matches by orderReference, returns RM identifiers.
router.post('/royal-mail-fetch-identifiers', authenticateToken, async (req, res) => {
  try {
    const { orderNumbers = [] } = req.body;
    if (!orderNumbers.length) return res.status(400).json({ message: 'orderNumbers required' });

    const { listOrders } = await import('../services/royalMail.js');
    const rmOrders = await listOrders();

    // Match by orderReference — we send order_number (e.g. 52846), RM may store it as-is or as "#52846"
    const numSet = new Set(orderNumbers.map(n => String(n).replace(/^#/, '')));
    const matched = rmOrders.filter(o => {
      const ref = String(o.orderReference || '').replace(/^#/, '');
      return numSet.has(ref);
    });

    res.json({
      total: rmOrders.length,
      matched: matched.map(o => ({
        orderIdentifier: o.orderIdentifier,
        orderReference: o.orderReference,
        status: o.status,
      })),
    });
  } catch (err) {
    console.error('royal-mail-fetch-identifiers error:', err);
    res.status(500).json({ message: err.message });
  }
});

// ─── POST /api/orders/seed-test-order ────────────────────────────────────────
// Inserts a fake Royal Mail test order for end-to-end flow testing.
router.post('/seed-test-order', authenticateToken, async (req, res) => {
  const fakeOrder = {
    id: 999999999,
    order_number: 999005,
    email: 'testcustomer@yopmail.com',
    financial_status: 'paid',
    fulfillment_status: null,
    total_price: '15.97',
    subtotal_price: '13.97',
    currency: 'GBP',
    tags: 'royal-mail-parcel',
    note: 'TEST ORDER — delete after Royal Mail flow testing',
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    customer: {
      id: 999999,
      first_name: 'Test',
      last_name: 'Customer',
      email: 'testcustomer@yopmail.com',
      phone: '+447700900000',
    },
    shipping_address: {
      name: 'Test Customer',
      address1: '10 Downing Street',
      address2: '',
      city: 'London',
      province: 'England',
      zip: 'SW1A 2AA',
      country: 'United Kingdom',
      country_code: 'GB',
      phone: '+447700900000',
    },
    billing_address: {
      name: 'Test Customer',
      address1: '10 Downing Street',
      city: 'London',
      zip: 'SW1A 2AA',
      country: 'United Kingdom',
    },
    line_items: [
      {
        id: 9999991,
        title: 'Numex Twilight Chilli Plant',
        variant_title: '9cm Pot',
        sku: 'PLANT-TEST-001',
        quantity: 2,
        price: '5.99',
        grams: 350,
        product_id: 9999991,
      },
      {
        id: 9999992,
        title: 'Carolina Reaper Chilli Plant',
        variant_title: '9cm Pot',
        sku: 'PLANT-TEST-002',
        quantity: 1,
        price: '3.99',
        grams: 320,
        product_id: 9999992,
      },
    ],
    shipping_lines: [
      {
        title: 'Royal Mail Tracked 48',
        price: '2.00',
        code: 'royal-mail-tracked-48',
      },
    ],
    order_status_url: 'https://example.com/orders/test001',
  };

  try {
    await upsertOrder(fakeOrder);
    res.json({
      success: true,
      message: 'Test order inserted — it will appear in the orders list as #999005',
      orderId: fakeOrder.id,
      orderNumber: fakeOrder.order_number,
    });
  } catch (err) {
    console.error('seed-test-order error:', err);
    res.status(500).json({ message: err.message });
  }
});

// ─── DELETE /api/orders/seed-test-order ──────────────────────────────────────
// Removes the fake test order inserted by the route above.
router.delete('/seed-test-order', authenticateToken, async (req, res) => {
  try {
    await pool.query('DELETE FROM orders WHERE id = ?', [999999999]);
    res.json({ success: true, message: 'Test order removed' });
  } catch (err) {
    console.error('seed-test-order delete error:', err);
    res.status(500).json({ message: err.message });
  }
});

// ─── POST /api/orders/dpd-labels ─────────────────────────────────────────────
// Body: { shipments: [{consignmentNumber, shipmentId}] }  OR legacy: { consignmentNumbers: [] }
router.post('/dpd-labels', authenticateToken, async (req, res) => {
  try {
    // Support both new format (shipments[]) and legacy (consignmentNumbers[])
    let shipments = req.body.shipments || [];
    if (!shipments.length && req.body.consignmentNumbers?.length) {
      shipments = req.body.consignmentNumbers.map(cn => ({ consignmentNumber: cn, shipmentId: null }));
    }
    if (!shipments.length) return res.status(400).json({ message: 'shipments is required' });

    const { getLabel, mergeLabels } = await import('../services/dpd.js');

    // Pre-fetch order data for label generation
    const orderMap = {};
    const shopifyIds = shipments.map(s => s.shopifyOrderId).filter(Boolean);
    if (shopifyIds.length) {
      const ph = shopifyIds.map(() => '?').join(',');
      const [orows] = await pool.query(`SELECT id, raw_data FROM orders WHERE id IN (${ph})`, shopifyIds);
      for (const row of orows) {
        const raw = typeof row.raw_data === 'string' ? JSON.parse(row.raw_data) : row.raw_data;
        if (raw) orderMap[String(row.id)] = raw;
      }
    }

    const pdfBuffers = [];
    for (const s of shipments) {
      const cn = s.consignmentNumber;
      const sid = s.shipmentId || null;
      const orderData = orderMap[String(s.shopifyOrderId)] || null;
      try {
        const buf = await getLabel(cn, sid, orderData);
        if (buf && buf.length > 100) pdfBuffers.push(buf);
      } catch (err) {
        console.warn(`Label fetch failed for ${cn}:`, err.message);
      }
    }

    if (!pdfBuffers.length) return res.status(404).json({ message: 'No labels retrieved' });

    const merged = await mergeLabels(pdfBuffers);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="dpd_labels_${new Date().toISOString().slice(0, 10)}.pdf"`);
    res.send(merged);
  } catch (err) {
    console.error('dpd-labels error:', err);
    res.status(500).json({ message: err.message });
  }
});

// ─── POST /api/orders/dpd-epl ────────────────────────────────────────────────
// Body: { shipments: [{consignmentNumber, shipmentId}] }
// Returns raw EPL file(s) concatenated for thermal printer
// ─── GET /api/orders/dpd-networks ─────────────────────────────────────────────
// Returns all available network codes for this DPD account
router.get('/dpd-networks', authenticateToken, async (req, res) => {
  try {
    const { authenticate, authHeaders } = await import('../services/dpd.js');
    const { token, accountNumber } = await authenticate();
    const axios = (await import('axios')).default;
    const BASE = process.env.DPD_API_URL || 'https://api.dpdlocal.co.uk';
    const { data } = await axios.get(`${BASE}/shipping/network`, {
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', GeoClient: `account/${accountNumber}`, GeoSession: token },
    });
    res.json(data);
  } catch (err) {
    res.status(500).json({ message: err.message, response: err.response?.data });
  }
});

router.post('/dpd-epl', authenticateToken, async (req, res) => {
  try {
    let shipments = req.body.shipments || [];
    if (!shipments.length) return res.status(400).json({ message: 'shipments is required' });

    const { getLabelEpl } = await import('../services/dpd.js');

    const eplParts = [];
    for (const s of shipments) {
      try {
        const buf = await getLabelEpl(s.consignmentNumber, s.shipmentId);
        if (buf && buf.length > 10) eplParts.push(buf);
      } catch (err) {
        console.warn(`EPL fetch failed for ${s.consignmentNumber}:`, err.message);
      }
    }

    if (!eplParts.length) return res.status(404).json({ message: 'No EPL labels retrieved' });

    const merged = Buffer.concat(eplParts);
    const filename = `dpd_labels_${new Date().toISOString().slice(0, 10)}.epl`;
    res.setHeader('Content-Type', 'text/vnd.eltron-epl');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(merged);
  } catch (err) {
    console.error('dpd-epl error:', err);
    res.status(500).json({ message: err.message });
  }
});

// ─── POST /api/orders/dpd-excel ───────────────────────────────────────────────
// Body: { orderIds: [] }
router.post('/dpd-excel', authenticateToken, async (req, res) => {
  try {
    const { orderIds = [] } = req.body;
    if (!orderIds.length) return res.status(400).json({ message: 'orderIds is required' });

    const placeholders = orderIds.map(() => '?').join(',');
    const [rows] = await pool.query(
      `SELECT raw_data FROM orders WHERE id IN (${placeholders})`,
      orderIds
    );

    const orders = rows
      .map(r => (typeof r.raw_data === 'string' ? JSON.parse(r.raw_data) : r.raw_data))
      .filter(Boolean);

    const headers = [
      'Order ID', 'E-mail', 'First name', 'Last name',
      'Address 1', 'Address 2', 'City', 'County',
      'Country', 'Postcode', 'Order Notes', 'Phone',
      'Weight (g)', 'Weight (kg)', 'Service',
    ];

    const dataRows = orders.map(o => {
      const a = o.shipping_address || {};
      const c = o.customer || {};
      const first = c.first_name || (a.name || '').split(' ').slice(0, -1).join(' ') || '';
      const last  = c.last_name  || (a.name || '').split(' ').slice(-1)[0] || '';
      const totalG = (o.line_items || []).reduce((sum, li) => {
        return sum + (li.grams > 0 ? li.grams : 999) * (li.quantity || 1);
      }, 0) || 999;
      const tags = (o.tags || '').toLowerCase();
      const service = tags.includes('dpd-parcel') ? 'DPD Parcel' : 'DPD Express Pack';
      return [
        `#${o.order_number}`,
        c.email || o.email || '',
        first,
        last,
        a.address1 || '',
        a.address2 || '',
        a.city || '',
        a.province || '',
        a.country || 'United Kingdom',
        a.zip || '',
        o.note || '',
        a.phone || c.phone || '',
        totalG,
        parseFloat((totalG / 1000).toFixed(2)),
        service,
      ];
    });

    const wsData = [headers, ...dataRows];
    const ws = XLSX.utils.aoa_to_sheet(wsData);

    ws['!cols'] = [
      { wch: 10 }, { wch: 28 }, { wch: 14 }, { wch: 14 },
      { wch: 22 }, { wch: 14 }, { wch: 14 }, { wch: 14 },
      { wch: 16 }, { wch: 12 }, { wch: 20 }, { wch: 16 },
      { wch: 10 }, { wch: 10 }, { wch: 18 },
    ];

    const range = XLSX.utils.decode_range(ws['!ref']);
    for (let C = range.s.c; C <= range.e.c; C++) {
      const cell = XLSX.utils.encode_cell({ r: 0, c: C });
      if (!ws[cell]) continue;
      ws[cell].s = {
        font: { bold: true, sz: 10 },
        fill: { fgColor: { rgb: 'D9E2F3' } },
        alignment: { horizontal: 'center', vertical: 'center', wrapText: true },
        border: {
          top: { style: 'thin', color: { rgb: '000000' } },
          bottom: { style: 'thin', color: { rgb: '000000' } },
          left: { style: 'thin', color: { rgb: '000000' } },
          right: { style: 'thin', color: { rgb: '000000' } },
        },
      };
    }

    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'DPD Orders');

    const buffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
    const filename = `DPD_Orders_${new Date().toISOString().slice(0, 10)}.xlsx`;
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(buffer);
  } catch (err) {
    console.error('dpd-excel error:', err);
    res.status(500).json({ message: err.message });
  }
});

export default router;
