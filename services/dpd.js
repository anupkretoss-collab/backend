import axios from 'axios';
import { PDFDocument } from 'pdf-lib';

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

  console.log(`[DPD] Creating shipment for order #${order.order_number} | network: ${networkCode} | weight: ${weightKg}kg`);
  console.log(`[DPD] Payload:`, JSON.stringify(payload, null, 2));

  const { data } = await axios.post(`${BASE}/shipping/shipment`, payload, {
    headers: authHeaders(token, accountNumber),
  });

  console.log(`[DPD] Raw response for #${order.order_number}:`, JSON.stringify(data, null, 2));

  const shipmentId = String(data.data?.shipmentId || '');
  const detail = data.data?.consignmentDetail?.[0];
  const consignmentNumber = detail?.consignmentNumber || shipmentId;
  const parcelNumber = detail?.parcelNumbers?.[0] || consignmentNumber;

  console.log(`[DPD] Parsed — shipmentId: ${shipmentId} | consignmentNumber: ${consignmentNumber} | parcelNumber: ${parcelNumber}`);

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
 * Fetch label PDF for a DPD consignment.
 * Returns a Buffer containing PDF bytes.
 */
export async function getLabel(consignmentNumber, shipmentId) {
  const { token, accountNumber } = await authenticate();
  const headers = authHeaders(token, accountNumber);

  const logErr = (label, err) => {
    const body = err.response?.data
      ? Buffer.isBuffer(err.response.data)
        ? err.response.data.toString('utf8').slice(0, 300)
        : JSON.stringify(err.response.data).slice(0, 300)
      : err.message;
    console.warn(`[DPD] ${label}: ${err.response?.status} — ${body}`);
  };

  // 1. POST /shipping/shipment/label  (body: consignmentNumber + outputFormat)
  try {
    console.log(`[DPD] Label attempt 1: POST /shipping/shipment/label`);
    const { data } = await axios.post(
      `${BASE}/shipping/shipment/label`,
      { consignmentNumber, outputFormat: 'PDF' },
      { headers }
    );
    console.log(`[DPD] Label attempt 1 JSON:`, JSON.stringify(data).slice(0, 300));
    const b64 = data?.data?.label || data?.label;
    if (b64) return Buffer.from(b64, 'base64');
  } catch (err) { logErr('Label attempt 1', err); }

  // 2. GET /shipping/shipment/label/{consignmentNumber} — JSON response (no Accept: pdf)
  try {
    console.log(`[DPD] Label attempt 2: GET /shipping/shipment/label/${consignmentNumber}`);
    const { data } = await axios.get(`${BASE}/shipping/shipment/label/${consignmentNumber}`, { headers });
    console.log(`[DPD] Label attempt 2 JSON:`, JSON.stringify(data).slice(0, 300));
    const b64 = data?.data?.label || data?.label;
    if (b64) return Buffer.from(b64, 'base64');
  } catch (err) { logErr('Label attempt 2', err); }

  // 3. GET /shipping/shipment/label/{consignmentNumber}?outputFormat=PDF — binary
  try {
    console.log(`[DPD] Label attempt 3: GET /shipping/shipment/label/${consignmentNumber}?outputFormat=PDF (binary)`);
    const { data } = await axios.get(
      `${BASE}/shipping/shipment/label/${consignmentNumber}?outputFormat=PDF`,
      { headers: { ...headers, Accept: 'application/pdf' }, responseType: 'arraybuffer' }
    );
    const buf = Buffer.from(data);
    if (buf.length > 100) { console.log(`[DPD] Label attempt 3 OK — ${buf.length} bytes`); return buf; }
  } catch (err) { logErr('Label attempt 3', err); }

  // 4. GET using shipmentId if available
  if (shipmentId) {
    try {
      console.log(`[DPD] Label attempt 4: GET /shipping/shipment/${shipmentId}/label`);
      const { data } = await axios.get(`${BASE}/shipping/shipment/${shipmentId}/label`, { headers });
      console.log(`[DPD] Label attempt 4 JSON:`, JSON.stringify(data).slice(0, 300));
      const b64 = data?.data?.label || data?.label;
      if (b64) return Buffer.from(b64, 'base64');
    } catch (err) { logErr('Label attempt 4', err); }

    // 5. POST /shipping/shipment/label with shipmentId
    try {
      console.log(`[DPD] Label attempt 5: POST /shipping/shipment/label (shipmentId)`);
      const { data } = await axios.post(
        `${BASE}/shipping/shipment/label`,
        { shipmentId, outputFormat: 'PDF' },
        { headers }
      );
      console.log(`[DPD] Label attempt 5 JSON:`, JSON.stringify(data).slice(0, 300));
      const b64 = data?.data?.label || data?.label;
      if (b64) return Buffer.from(b64, 'base64');
    } catch (err) { logErr('Label attempt 5', err); }
  }

  throw new Error('All label fetch attempts failed — check DPD API logs');
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
