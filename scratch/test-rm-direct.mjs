/**
 * Direct Royal Mail API test — bypasses the Express server entirely.
 * Tests the actual RM Click & Drop API with a minimal UK-style payload.
 * Run: node scratch/test-rm-direct.mjs
 */
import axios from 'axios';
import dotenv from 'dotenv';
import mysql from 'mysql2/promise';
dotenv.config();

const BASE  = process.env.ROYAL_MAIL_API_URL || 'https://api.parcel.royalmail.com/api/v1';
const TOKEN = process.env.ROYAL_MAIL_OBA_TOKEN;

const DIVIDER = '─'.repeat(60);

if (!TOKEN) {
  console.error('❌  ROYAL_MAIL_OBA_TOKEN not set in .env');
  process.exit(1);
}

const headers = {
  Authorization: `Bearer ${TOKEN}`,
  'Content-Type': 'application/json',
  Accept: 'application/json',
};

// ── 1. Print token (partial) ───────────────────────────────────────────────
console.log(`\n🔑  RM OBA Token (first 8 chars): ${TOKEN.slice(0, 8)}...`);
console.log(`🌐  API Base: ${BASE}`);

// ── 2. Fetch real order from DB ────────────────────────────────────────────
const conn = await mysql.createConnection({
  host: process.env.DB_HOST, port: Number(process.env.DB_PORT),
  user: process.env.DB_USER, password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
});
const [rows] = await conn.query('SELECT raw_data FROM orders LIMIT 20');
await conn.end();

const orders = rows
  .map(r => typeof r.raw_data === 'string' ? JSON.parse(r.raw_data) : r.raw_data)
  .filter(Boolean);

const gbOrder = orders.find(o => (o.shipping_address?.country_code || '').toUpperCase() === 'GB')
  || orders[0];

console.log(`\n📦  Using order #${gbOrder.order_number} — country: ${gbOrder.shipping_address?.country_code || 'N/A'}`);

// ── 3. Build compact payload ───────────────────────────────────────────────
function compact(obj) {
  return Object.fromEntries(
    Object.entries(obj).filter(([, v]) => v !== null && v !== undefined && v !== '')
  );
}

const a = gbOrder.shipping_address || {};
const c = gbOrder.customer || {};
const lineItems = gbOrder.line_items || [];

const address = compact({
  fullName:     a.name || `${c.first_name||''} ${c.last_name||''}`.trim() || 'Unknown',
  companyName:  a.company   || undefined,
  addressLine1: a.address1  || 'Unknown Road',
  addressLine2: a.address2  || undefined,
  city:         a.city      || 'London',
  county:       a.province  || undefined,
  postcode:     a.zip       || 'SW1A 1AA',
  countryCode:  (a.country_code || 'GB').toUpperCase().slice(0, 2),
});

const phone = (a.phone || c.phone || '').replace(/\s/g, '');
const email = c.email || gbOrder.email || '';

const recipient = {
  address,
  ...(phone ? { phoneNumber: phone } : {}),
  ...(email ? { emailAddress: email } : {}),
};

const contents = lineItems.map(li => compact({
  name:              li.title || 'Item',
  SKU:               li.sku   || undefined,
  quantity:          li.quantity || 1,
  unitValue:         parseFloat(li.price || 0),
  unitWeightInGrams: li.grams || 999,
}));

const orderDate = new Date(gbOrder.created_at || Date.now()).toISOString();

const payload = {
  orderReference:      `#${gbOrder.order_number}-TEST`,
  recipient,
  packages: [{
    weightInGrams:           lineItems.reduce((s, li) => s + ((li.grams || 999) * (li.quantity || 1)), 0) || 999,
    packageFormatIdentifier: 'Parcel',
    ...(contents.length ? { contents } : {}),
  }],
  orderDate,
  plannedDespatchDate: new Date().toISOString().slice(0, 10),
  subtotal:            parseFloat(gbOrder.subtotal_price || gbOrder.total_price || 0),
  shippingCostCharged: 0,
  total:               parseFloat(gbOrder.total_price || 0),
  currencyCode:        gbOrder.currency || 'GBP',
  label:               { includeLabelInResponse: false },
  serviceCode:         'TPS48',
};

console.log(`\n${DIVIDER}`);
console.log('  PAYLOAD BEING SENT TO ROYAL MAIL API');
console.log(DIVIDER);
console.log(JSON.stringify([payload], null, 2));

// ── 4. POST to Royal Mail ─────────────────────────────────────────────────
console.log(`\n${DIVIDER}`);
console.log('  POST /orders → Royal Mail API');
console.log(DIVIDER);

try {
  const res = await axios.post(`${BASE}/orders`, [payload], { headers });
  console.log('\n✅  SUCCESS — HTTP', res.status);
  console.log(JSON.stringify(res.data, null, 2));
} catch (err) {
  const status = err.response?.status;
  const body   = err.response?.data;
  console.error(`\n❌  FAILED — HTTP ${status}`);
  console.error('Response body:', JSON.stringify(body, null, 2));
  console.error('Message:', err.message);
}

// ── 5. Test manifest (with 'Royal Mail') ─────────────────────────────────
console.log(`\n${DIVIDER}`);
console.log('  POST /manifests → Royal Mail API (carrierName: "Royal Mail")');
console.log(DIVIDER);

try {
  const res = await axios.post(`${BASE}/manifests`, { carrierName: 'Royal Mail' }, { headers });
  console.log('\n✅  Manifest SUCCESS — HTTP', res.status);
  console.log(JSON.stringify(res.data, null, 2));
} catch (err) {
  const status = err.response?.status;
  const body   = err.response?.data;
  console.error(`\n❌  Manifest FAILED — HTTP ${status}`);
  console.error('Response body:', JSON.stringify(body, null, 2));
}
