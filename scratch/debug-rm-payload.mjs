/**
 * Debug: fetch order raw_data and print the RM payload
 */
import mysql from 'mysql2/promise';
import dotenv from 'dotenv';
dotenv.config();

const conn = await mysql.createConnection({
  host: process.env.DB_HOST || '127.0.0.1',
  port: Number(process.env.DB_PORT) || 3306,
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || 'admin',
  database: process.env.DB_NAME || 'shopify_admin',
});

const [rows] = await conn.query('SELECT raw_data FROM orders LIMIT 1');
await conn.end();

if (!rows.length) { console.error('No orders in DB'); process.exit(1); }

const order = typeof rows[0].raw_data === 'string'
  ? JSON.parse(rows[0].raw_data)
  : rows[0].raw_data;

// ── replicate buildPayload from royalMail.js ──────────────────────────────────
function calcWeightG(lineItems = []) {
  const total = lineItems.reduce((sum, li) => {
    return sum + (li.grams > 0 ? li.grams : 999) * (li.quantity || 1);
  }, 0);
  return total || 999;
}

function toGB(countryCode, countryName) {
  if (countryCode) return countryCode.toUpperCase().slice(0, 2);
  if ((countryName || '').toLowerCase().includes('united kingdom')) return 'GB';
  return 'GB';
}

const a = order.shipping_address || {};
const c = order.customer || {};
const lineItems = order.line_items || [];
const weightG = calcWeightG(lineItems);

const payload = {
  orderReference: `#${order.order_number}`,
  recipient: {
    address: {
      fullName: a.name || `${c.first_name || ''} ${c.last_name || ''}`.trim() || 'Unknown',
      companyName: a.company || '',
      addressLine1: a.address1 || '',
      addressLine2: a.address2 || '',
      city: a.city || '',
      county: a.province || '',
      postcode: a.zip || '',
      countryCode: toGB(a.country_code, a.country),
    },
    phoneNumber: (a.phone || c.phone || '').replace(/\s/g, ''),
    emailAddress: c.email || order.email || '',
  },
  packages: [
    {
      weightInGrams: weightG,
      packageFormatIdentifier: 'parcel',
      contents: lineItems.map(li => ({
        name: li.title || 'Item',
        SKU: li.sku || '',
        quantity: li.quantity || 1,
        unitValue: parseFloat(li.price || 0),
        unitWeightInGrams: li.grams || 999,
      })),
    },
  ],
  orderDate: order.created_at || new Date().toISOString(),
  plannedDespatchDate: new Date().toISOString().slice(0, 10),
  specialInstructions: order.note || '',
  subtotal: parseFloat(order.subtotal_price || order.total_price || 0),
  shippingCostCharged: 0,
  total: parseFloat(order.total_price || 0),
  currencyCode: order.currency || 'GBP',
  label: { includeLabelInResponse: false },
  serviceCode: 'TPS48',
};

console.log('\n── Raw shipping_address ──────────────────────────────');
console.log(JSON.stringify(a, null, 2));

console.log('\n── Built payload (single object) ─────────────────────');
console.log(JSON.stringify(payload, null, 2));

console.log('\n── Payload as array (what RM API expects) ────────────');
console.log(JSON.stringify([payload], null, 2));
