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

  // Correct endpoint is /shipping/shipment/{shipmentId}/label
  // Default returns EPL (thermal format) — try PDF variants first
  if (shipmentId) {
    const base = `${BASE}/shipping/shipment/${shipmentId}/label`;

    // Try PDF output in various ways
    for (const qs of ['?outputFormat=PDF', '?outputFormat=pdf', '?format=PDF', '?labelFormat=PDF', '?paperFormat=A4PDF']) {
      try {
        console.log(`[DPD] Label try PDF: GET ${base}${qs}`);
        const { data, headers: rh } = await axios.get(`${base}${qs}`, {
          headers: { ...headers, Accept: '*/*' },
          responseType: 'arraybuffer',
        });
        const buf = Buffer.from(data);
        const ct = rh['content-type'] || '';
        console.log(`[DPD] content-type: ${ct} | size: ${buf.length}`);
        // Accept only if it looks like PDF (starts with %PDF)
        if (buf.length > 100 && buf.slice(0, 4).toString() === '%PDF') {
          console.log(`[DPD] Got PDF — ${buf.length} bytes`);
          return buf;
        }
        console.log(`[DPD] Not PDF (got ${ct}), trying next param`);
      } catch (err) { logErr(`Label PDF try ${qs}`, err); }
    }

    // Last resort: return whatever DPD gives (EPL/ZPL) — caller will get an error
    // but at least we tried everything
    try {
      console.log(`[DPD] Label fallback: GET ${base} (accept any)`);
      const { data, headers: rh } = await axios.get(base, {
        headers: { ...headers, Accept: '*/*' },
        responseType: 'arraybuffer',
      });
      const buf = Buffer.from(data);
      const ct = rh['content-type'] || '';
      console.log(`[DPD] Fallback content-type: ${ct} | size: ${buf.length}`);
      if (buf.slice(0, 4).toString() === '%PDF') return buf;
      throw new Error(`DPD returned ${ct} (not PDF). Label printing must be done from DPD portal → Shipment Review → Print Shipment.`);
    } catch (err) {
      if (err.message.includes('DPD returned')) throw err;
      logErr('Label fallback', err);
    }
  }

  throw new Error('Label download not available via API. Use DPD portal → Shipment Review → Print Shipment.');
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
