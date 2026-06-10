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

const router = express.Router();

const backgroundJobs = new Map();

// ─── Upsert a single Shopify order into MySQL ─────────────────────────────────
export async function upsertOrder(order) {
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
      order.created_at ? new Date(order.created_at) : null,
      order.updated_at ? new Date(order.updated_at) : null,
    ]
  );
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
  try {
    // 1. Unique Tags (Orders)
    const [tagRows] = await pool.query('SELECT DISTINCT tags FROM orders WHERE tags IS NOT NULL AND tags != ""');
    const orderTagsSet = new Set();
    tagRows.forEach(row => {
      row.tags.split(',').forEach(t => orderTagsSet.add(t.trim()));
    });

    // 2. Unique Tags (Products)
    const [productTagRows] = await pool.query('SELECT DISTINCT tags FROM products WHERE tags IS NOT NULL AND tags != ""');
    const productTagsSet = new Set();
    productTagRows.forEach(row => {
      if (row.tags) {
        row.tags.split(',').forEach(t => productTagsSet.add(t.trim()));
      }
    });

    const combinedTags = new Set([...orderTagsSet, ...productTagsSet]);

    // 2. Unique Varieties (Line Item Titles)
    const [varietyRows] = await pool.query(`
      SELECT DISTINCT jt.title
FROM orders,
JSON_TABLE(
  COALESCE(orders.line_items, '[]'),
  '$[*]'
  COLUMNS (
    title VARCHAR(255) PATH '$.title'
  )
) as jt
WHERE jt.title IS NOT NULL
    `);

    // 3. Unique Shipping Methods
    const [shippingRows] = await pool.query(`
      SELECT DISTINCT jt.title
FROM orders,
JSON_TABLE(
  COALESCE(orders.shipping_lines, '[]'),
  '$[*]'
  COLUMNS (
    title VARCHAR(255) PATH '$.title'
  )
) as jt
WHERE jt.title IS NOT NULL
    `);

    // 4. Unique Payment Statuses
    const [paymentRows] = await pool.query('SELECT DISTINCT financial_status FROM orders WHERE financial_status IS NOT NULL AND financial_status != ""');

    // 5. Unique Fulfillment Statuses
    const [fulfillRows] = await pool.query('SELECT DISTINCT COALESCE(fulfillment_status, "unfulfilled") as status FROM orders');

    res.json({
      tags: Array.from(combinedTags).sort(),
      orderTags: Array.from(orderTagsSet).sort(),
      productTags: Array.from(productTagsSet).sort(),
      varieties: varietyRows.map(r => r.title).sort(),
      shipping: shippingRows.map(r => r.title).sort(),
      payments: paymentRows.map(r => r.financial_status).sort(),
      fulfillments: Array.from(new Set(fulfillRows.map(r => r.status))).sort()
    });
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

      let synced = 0;

      for (const order of orders) {

        await upsertOrder(order);

        synced++;

        console.log(
          `Synced ${synced}/${orders.length}`
        );
      }

      return res.json({
        success: true,
        skip,
        limit,
        fetched: orders.length,
        synced,
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

    // Calculate stats for the current filters (or overall)
    const [statsRows] = await pool.query(
      `
      SELECT 
        COUNT(*) as total,
        COALESCE(SUM(total_price), 0) as total_revenue,
        COUNT(
          CASE
            WHEN fulfillment_status = 'fulfilled'
            THEN 1
          END
        ) as fulfilled_count,
        COUNT(
          CASE
            WHEN fulfillment_status IS NULL
            OR fulfillment_status = 'unfulfilled'
            THEN 1
          END
        ) as pending_count,
        COALESCE(
          SUM(
            (
              SELECT COALESCE(
                SUM(
                  CAST(quantity AS UNSIGNED)
                ),
                0
              )
              FROM JSON_TABLE(
                COALESCE(orders.line_items, '[]'),
                '$[*]'
                COLUMNS (
                  quantity INT PATH '$.quantity'
                )
              ) jt
            )
          ),
          0
        ) as total_products,
        COALESCE(
          SUM(
            CASE
              WHEN orders.tags IS NOT NULL AND orders.tags != ''
              THEN (
                SELECT COALESCE(SUM(CAST(quantity AS UNSIGNED)), 0)
                FROM JSON_TABLE(COALESCE(orders.line_items, '[]'), '$[*]' COLUMNS (quantity INT PATH '$.quantity')) jt
              )
              ELSE 0
            END
          ),
          0
        ) as tagged_products,
        COALESCE(
          SUM(
            CASE
              WHEN orders.tags IS NULL OR orders.tags = ''
              THEN (
                SELECT COALESCE(SUM(CAST(quantity AS UNSIGNED)), 0)
                FROM JSON_TABLE(COALESCE(orders.line_items, '[]'), '$[*]' COLUMNS (quantity INT PATH '$.quantity')) jt
              )
              ELSE 0
            END
          ),
          0
        ) as untagged_products
      FROM orders
      ${whereSql}
      `,
      queryParams
    );
    const stats = statsRows[0];
    const total = stats.total;

    // Fetch paginated data
    const [rows] = await pool.query(
      `SELECT DISTINCT orders.* FROM orders ${whereSql} ORDER BY ${orderBy} ${orderDir} LIMIT ? OFFSET ?`,
      [...queryParams, limit, offset]
    );

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

    let synced = 0;

    for (const product of products) {
      await upsertProduct(product);

      synced++;
    }

    res.json({
      message: `Synced ${synced} products from Shopify.`,
      synced,
    });
  } catch (err) {
    console.error('Product sync error:', err);

    res.status(500).json({
      message: 'Product sync failed',
      error: err.message,
    });
  }
});

router.post('/sync-customers', authenticateToken, async (req, res) => {
  try {
    const customers = await fetchShopifyCustomers();

    let synced = 0;

    for (const customer of customers) {
      await upsertCustomer(customer);

      synced++;
    }

    res.json({
      message: `Synced ${synced} customers from Shopify.`,
      synced,
    });
  } catch (err) {
    console.error('Customer sync error:', err);

    res.status(500).json({
      message: 'Customer sync failed',
      error: err.message,
    });
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

    let syncedCustomers = 0;

    for (const customer of shopifyCustomers) {

      await upsertCustomer(customer);

      syncedCustomers++;
    }

    // ============================================
    // SYNC PRODUCTS
    // ============================================

    let syncedProducts = 0;

    for (const product of shopifyProducts) {

      await upsertProduct(product);

      syncedProducts++;
    }

    // ============================================
    // SYNC ORDERS LAST
    // ============================================

    let syncedOrders = 0;

    for (const order of shopifyOrders) {

      await upsertOrder(order);

      syncedOrders++;
    }

    // ============================================
    // RESPONSE
    // ============================================

    res.json({
      success: true,

      message: 'Shopify sync completed successfully.',

      synced: {
        orders: syncedOrders,
        products: syncedProducts,
        customers: syncedCustomers,
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
    const failed    = results.filter(r => !r.success);
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

    for (const id of rmOrderIdentifiers) {
      let buf = null;
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          buf = await getLabel(id);
          break;
        } catch {
          await new Promise(r => setTimeout(r, 2000));
        }
      }
      if (buf) pdfBuffers.push(buf);
      else errors.push(id);
      await new Promise(r => setTimeout(r, 200));
    }

    if (!pdfBuffers.length) {
      return res.status(404).json({ message: 'No labels could be retrieved', errors });
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

// POST /api/orders/royal-mail-manifest
// Manifests all ready orders in Royal Mail Click & Drop; returns manifest PDF if available.
router.post('/royal-mail-manifest', authenticateToken, async (req, res) => {
  try {
    const { createManifest, getManifestLabel, isConfigured } = await import('../services/royalMail.js');

    if (!isConfigured()) {
      return res.status(503).json({ message: 'Royal Mail API token not configured.' });
    }

    const manifest = await createManifest();

    if (manifest.manifestIdentifier) {
      await new Promise(r => setTimeout(r, 1500));
      const pdfBuf = await getManifestLabel(manifest.manifestIdentifier);
      if (pdfBuf) {
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `attachment; filename="manifest_${manifest.manifestIdentifier}.pdf"`);
        res.setHeader('X-Manifest-Id', manifest.manifestIdentifier);
        return res.send(pdfBuf);
      }
    }

    res.json(manifest);
  } catch (err) {
    const apiMsg = err.response?.data?.message || JSON.stringify(err.response?.data);
    console.error('royal-mail-manifest error:', apiMsg || err.message);
    res.status(500).json({ message: apiMsg || err.message });
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

    const results = [];
    for (const order of orders) {
      try {
        const result = await createShipment(order, despatchDate || new Date().toISOString().slice(0, 10));
        results.push(result);
      } catch (err) {
        results.push({
          orderNumber: order.order_number,
          shopifyOrderId: order.id,
          error: err.response?.data?.error?.errorMessage || err.message,
        });
      }
      await new Promise(r => setTimeout(r, 300));
    }

    res.json({ results });
  } catch (err) {
    console.error('dpd-create error:', err);
    res.status(500).json({ message: err.message });
  }
});

// ─── POST /api/orders/dpd-labels ─────────────────────────────────────────────
// Body: { consignmentNumbers: [] }
router.post('/dpd-labels', authenticateToken, async (req, res) => {
  try {
    const { consignmentNumbers = [] } = req.body;
    if (!consignmentNumbers.length) return res.status(400).json({ message: 'consignmentNumbers is required' });

    const { getLabel, mergeLabels } = await import('../services/dpd.js');

    const pdfBuffers = [];
    for (const cn of consignmentNumbers) {
      // Retry up to 3 times with 2s delay
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const buf = await getLabel(cn);
          if (buf && buf.length > 100) { pdfBuffers.push(buf); break; }
        } catch (err) {
          if (attempt === 2) console.warn(`Label fetch failed for ${cn}:`, err.message);
          else await new Promise(r => setTimeout(r, 2000));
        }
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

export default router;
