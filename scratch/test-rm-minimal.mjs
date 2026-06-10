/**
 * Final Royal Mail API probe — correct { items: [...] } structure + all required fields.
 * Run: node scratch/test-rm-minimal.mjs
 */
import axios from 'axios';
import dotenv from 'dotenv';
dotenv.config();

const BASE = process.env.ROYAL_MAIL_API_URL || 'https://api.parcel.royalmail.com/api/v1';
const TOKEN = process.env.ROYAL_MAIL_OBA_TOKEN;

const headers = {
  Authorization: `Bearer ${TOKEN}`,
  'Content-Type': 'application/json',
  Accept: 'application/json',
};

console.log(`\n🔑  Token: ${TOKEN?.slice(0, 8)}...`);
console.log(`🌐  Base : ${BASE}\n`);

// ── Test: Full correct payload with all required fields ───────────────────
const fullPayload = {
  items: [
    {
      orderReference: '#FULL-ORDER-001',
      recipient: {
        address: {
          fullName: 'order Recipient',
          addressLine1: '1 order Street',
          city: 'London',
          postcode: 'SW1A 1AA',
          countryCode: 'GB',
        },
        emailAddress: 'order@yopmail.com',
      },
      packages: [
        {
          weightInGrams: 500,
          packageFormatIdentifier: 'Parcel',
          contents: [
            {
              name: 'Order Product',
              SKU: 'Order-001',
              quantity: 1,
              unitValue: 10.00,
              unitWeightInGrams: 500,
            },
          ],
        },
      ],
      orderDate: new Date().toISOString().slice(0, 10),
      plannedDespatchDate: new Date(Date.now() + 86400000).toISOString().slice(0, 10),
      subtotal: 10.00,
      shippingCostCharged: 0,
      total: 10.00,
      currencyCode: 'GBP',
      label: { includeLabelInResponse: false },
      serviceCode: 'TPS48',
    },
  ],
};

console.log('── Full payload with all required fields ─────────────────');
console.log(JSON.stringify(fullPayload, null, 2));

try {
  const r = await axios.post(`${BASE}/orders`, fullPayload, { headers });
  console.log('\n✅  HTTP', r.status);
  console.log(JSON.stringify(r.data, null, 2));

  const order = r.data?.createdOrders?.[0] || r.data?.orders?.[0];
  if (order?.orderIdentifier) {
    console.log(`\n🎯  Order Identifier: ${order.orderIdentifier}`);
    console.log(`🎯  Tracking Number : ${order.trackingNumber || 'N/A'}`);
  }
} catch (e) {
  console.error(`\n❌  HTTP ${e.response?.status}`);
  console.error(JSON.stringify(e.response?.data, null, 2));
}
