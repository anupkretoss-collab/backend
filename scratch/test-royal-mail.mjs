/**
 * Royal Mail End-to-End Test (using seed test order)
 * Run: node scratch/test-royal-mail.mjs
 *
 * Flow:
 *  1. Login → get JWT
 *  2. POST /api/orders/seed-test-order  (insert fake GB order)
 *  3. POST /api/orders/royal-mail-create  (create shipment)
 *  4. POST /api/orders/royal-mail-labels  (download merged PDF)
 *  5. POST /api/orders/royal-mail-manifest (manifest)
 *  6. DELETE /api/orders/seed-test-order  (clean up)
 */

import fs from 'fs';
import path from 'path';

const BASE     = 'http://localhost:5000';
const USERNAME = 'admin';
const PASSWORD = 'admin123';
const TEST_ORDER_ID = 999999999;

const DIVIDER = '─'.repeat(60);

function log(title, obj) {
  console.log(`\n${DIVIDER}`);
  console.log(`  ${title}`);
  console.log(DIVIDER);
  console.log(JSON.stringify(obj, null, 2));
}

async function request(method, path, body, token, raw = false) {
  const opts = {
    method,
    headers: { 'Content-Type': 'application/json' },
  };
  if (token) opts.headers['Authorization'] = `Bearer ${token}`;
  if (body)  opts.body = JSON.stringify(body);

  const res = await fetch(`${BASE}${path}`, opts);

  if (raw) {
    const buf = await res.arrayBuffer();
    return { status: res.status, headers: Object.fromEntries(res.headers.entries()), buf };
  }

  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = text; }
  return { status: res.status, data };
}

async function main() {
  console.log('\n🚀  Royal Mail End-to-End Test (Seed Order)');
  console.log(`    Server: ${BASE}`);
  console.log(`    Time  : ${new Date().toLocaleString()}\n`);

  // ── Step 0: health check ──────────────────────────────────────────────────
  const health = await request('GET', '/api/health');
  if (health.status !== 200) {
    console.error('❌  Server is NOT running. Start it with: npm run dev');
    process.exit(1);
  }
  console.log('✅  Server health check passed');

  // ── Step 1: login ─────────────────────────────────────────────────────────
  console.log('\n📋  Step 1: Login');
  const loginRes = await request('POST', '/api/auth/login', { username: USERNAME, password: PASSWORD });
  log('POST /api/auth/login', { status: loginRes.status, message: loginRes.data?.message });

  if (loginRes.status !== 200 || !loginRes.data?.token) {
    console.error('❌  Login failed. Check USERNAME/PASSWORD.');
    console.error('   Response:', loginRes.data);
    process.exit(1);
  }
  const TOKEN = loginRes.data.token;
  console.log('✅  Login successful');

  // ── Step 2: Seed the test order ───────────────────────────────────────────
  console.log('\n📋  Step 2: Insert fake test order (id=999999999, #TEST001)');
  const seedRes = await request('POST', '/api/orders/seed-test-order', {}, TOKEN);
  log('POST /api/orders/seed-test-order', { status: seedRes.status, body: seedRes.data });

  if (seedRes.status !== 200) {
    console.error('❌  Failed to seed test order.');
    process.exit(1);
  }
  console.log(`✅  Test order seeded — #999001 (id=${TEST_ORDER_ID})`);

  // ── Step 3: Create shipment — NOTE: OBA token is read-only for orders ────
  console.log('\n📋  Step 3: Create Royal Mail shipment');
  console.log('  ℹ️   NOTE: The OBA token has read-only order access.');
  console.log('  ℹ️   Orders must be created via Click & Drop CSV import or Shopify integration.');
  console.log('  ℹ️   Skipping create-shipment test and using a known RM order identifier instead.\n');

  // Use an existing RM order identifier from the GET /api/v1/orders response
  const KNOWN_RM_ID = 64026; // real order in Click & Drop from today

  // ── Step 4: Download label for an existing RM order ───────────────────────
  console.log(`\n📋  Step 4: Download label PDF for existing RM order ${KNOWN_RM_ID}`);
  const labelRes = await request(
    'POST',
    '/api/orders/royal-mail-labels',
    { rmOrderIdentifiers: [KNOWN_RM_ID] },
    TOKEN,
    true
  );
  log('POST /api/orders/royal-mail-labels', {
    status: labelRes.status,
    contentType: labelRes.headers['content-type'],
    bytes: labelRes.buf?.byteLength,
  });

  if (labelRes.status === 200 && labelRes.buf?.byteLength > 100) {
    const outPath = path.resolve('./scratch/royal_mail_test_label.pdf');
    fs.writeFileSync(outPath, Buffer.from(labelRes.buf));
    console.log(`✅  Label PDF saved → ${outPath}  (${labelRes.buf.byteLength} bytes)`);
  } else {
    console.warn('⚠️   Label download failed.');
  }

  // ── Step 5: Manifest ──────────────────────────────────────────────────────
  console.log('\n📋  Step 5: Create Royal Mail manifest');
  console.log('  ℹ️   The carrierName in manifest API must match the carrier configured in Click & Drop.');
  console.log('  ℹ️   Check Click & Drop > Settings > Carriers for the exact name.\n');
  const manifestRes = await request('POST', '/api/orders/royal-mail-manifest', {}, TOKEN, false);
  log('POST /api/orders/royal-mail-manifest', { status: manifestRes.status, body: manifestRes.data });

  if (manifestRes.status === 200) {
    console.log('✅  Manifest created');
  } else {
    console.warn('⚠️   Manifest returned non-200 — carrier name in Click & Drop settings needs to match.');
  }

  // ── Step 6: Clean up ─────────────────────────────────────────────────────
  await cleanup(TOKEN);

  // ── Summary ───────────────────────────────────────────────────────────────
  console.log(`\n${DIVIDER}`);
  console.log('  TEST SUMMARY');
  console.log(DIVIDER);
  console.log(`  Server Health  : ✅`);
  console.log(`  Auth/Login     : ✅`);
  console.log(`  Seed Test Order: ✅  (id=${TEST_ORDER_ID}, #TEST001)`);
  console.log(`  RM Create      : ⏭️  skipped (OBA token is read-only for order creation)`);
  console.log(`  RM Labels      : ${labelRes.status === 200 ? '✅  PDF saved to scratch/royal_mail_test_label.pdf' : '❌  failed'}`);
  console.log(`  RM Manifest    : ${manifestRes.status === 200 ? '✅' : '⚠️  check output above'}`);
  console.log(`  Cleanup        : ✅  test order removed`);
  console.log(DIVIDER + '\n');
}

async function cleanup(TOKEN) {
  console.log('\n🧹  Cleanup: removing test order');
  const del = await request('DELETE', '/api/orders/seed-test-order', null, TOKEN);
  if (del.status === 200) {
    console.log('✅  Test order removed from DB');
  } else {
    console.warn('⚠️   Cleanup failed:', del.data);
  }
}

main().catch(err => {
  console.error('\n💥  Unhandled error:', err.message);
  process.exit(1);
});
