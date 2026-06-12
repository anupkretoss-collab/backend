import axios from 'axios';
import { PDFDocument } from 'pdf-lib';

const BASE = process.env.ROYAL_MAIL_API_URL || 'https://api.parcel.royalmail.com/api/v1';
// Royal Mail Click & Drop service codes (affix "48" or "24" to the base code):
//   TPS48 = Tracked 48 Signature / No Signature  ← used here
//   TPS24 = Tracked 24 Signature / No Signature
//   TSS   = Tracked Returns 48
//   TSN   = Tracked Returns 24
const SERVICE_CODE = 'TPS48';

function authHeaders() {
  return {
    Authorization: `Bearer ${process.env.ROYAL_MAIL_OBA_TOKEN}`,
    'Content-Type': 'application/json',
    Accept: 'application/json',
  };
}

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

// Strip undefined/null/empty-string keys so RM API doesn't reject the payload
function compact(obj) {
  return Object.fromEntries(
    Object.entries(obj).filter(([, v]) => v !== null && v !== undefined && v !== '')
  );
}

function buildPayload(order, despatchDate) {
  const a = order.shipping_address || {};
  const c = order.customer || {};
  const lineItems = order.line_items || [];
  const weightG   = calcWeightG(lineItems);

  // Royal Mail requires orderDate in strict UTC ISO-8601 format
  const rawDate  = order.created_at ? new Date(order.created_at) : new Date();
  const orderDate = rawDate.toISOString();

  // Build address — omit optional fields when empty
  const address = compact({
    fullName:     a.name || `${c.first_name || ''} ${c.last_name || ''}`.trim() || 'Unknown',
    companyName:  a.company  || undefined,
    addressLine1: a.address1 || '',
    addressLine2: a.address2 || undefined,
    city:         a.city     || '',
    county:       a.province || undefined,
    postcode:     a.zip      || '',
    countryCode:  toGB(a.country_code, a.country),
  });

  const phone = (a.phone || c.phone || '').replace(/\s/g, '');
  const email = c.email || order.email || '';

  const recipient = {
    address,
    ...(phone ? { phoneNumber: phone } : {}),
    ...(email ? { emailAddress: email } : {}),
  };

  const payload = {
    orderReference:       String(order.order_number),
    recipient,
    packages: [
      {
        weightInGrams:           weightG,
        packageFormatIdentifier: 'parcel',
      },
    ],
    orderDate,
    // plannedDespatchDate omitted — account has "Allow future dated orders" disabled
    subtotal:            parseFloat(order.subtotal_price || order.total_price || 0),
    shippingCostCharged: 0,
    total:               parseFloat(order.total_price || 0),
    currencyCode:        order.currency || 'GBP',
    serviceCode:         SERVICE_CODE,
    // postageDetails applies TPS48 postage at creation time → assigns tracking number immediately
    postageDetails: {
      serviceCode: SERVICE_CODE,
    },
    // includeLabelInResponse returns the label as base64 directly in the creation response
    label: {
      includeLabelInResponse: true,
    },
  };

  // Only include notes when non-empty; strip non-ASCII to avoid RM parser rejections
  if (order.note) {
    payload.specialInstructions = order.note.replace(/[^\x00-\x7F]/g, '-');
  }

  return payload;
}

/**
 * Create a single shipment in Royal Mail Click & Drop.
 * Returns { orderIdentifier, trackingNumber, status }
 */
export async function createShipment(order, despatchDate) {
  const payload = buildPayload(order, despatchDate);
  // API requires { items: [...] } wrapper — raw array returns 400
  const body = JSON.stringify({ items: [payload] });

  console.log('[RM] POST /orders payload:', body);

  let resp;
  try {
    resp = await axios.post(`${BASE}/orders`, body, {
      headers: {
        ...authHeaders(),
        'Content-Type': 'application/json',
      },
    });
  } catch (err) {
    const status = err.response?.status;
    const detail = err.response?.data;
    console.error(`[RM] POST /orders failed — HTTP ${status}:`, JSON.stringify(detail));
    throw err;
  }

  const data = resp.data;
  console.log('[RM] POST /orders result:', JSON.stringify(data));

  // Handle application-level failures reported in failedOrders
  if (data.failedOrders?.length > 0) {
    const errs = data.failedOrders[0].errors?.map(e => e.errorMessage).join('; ') || '';
    // Service contract error means the Royal Mail account hasn't enabled this service
    if (errs.toLowerCase().includes('service contract') || errs.toLowerCase().includes('does not exist')) {
      throw new Error(`Royal Mail service '${SERVICE_CODE}' is not enabled on this account. Contact your Royal Mail account manager to enable Tracked 48 (TPS48). ${errs}`);
    }
    throw new Error(`Royal Mail order creation failed: ${errs}`);
  }

  const result = data.createdOrders?.[0] || data;

  // Extract inline label returned when label.includeLabelInResponse is true
  // RM API may return label as: result.label (string), result.label.pdf (string), or result.labelPdf
  let labelBuffer = null;
  const rawLabel = result.label ?? result.labelPdf ?? null;
  if (rawLabel) {
    const base64 = typeof rawLabel === 'string' ? rawLabel : (rawLabel.pdf ?? rawLabel.labelPdf ?? null);
    if (base64) labelBuffer = Buffer.from(base64, 'base64');
  }

  return {
    orderIdentifier: result.orderIdentifier,
    trackingNumber: result.trackingNumber || null,
    status: result.orderStatus || 'created',
    shopifyOrderId: order.id,
    orderNumber: order.order_number,
    labelBuffer,
  };
}

/**
 * Fetch the label PDF for a given RM orderIdentifier.
 * Returns a Buffer containing the PDF bytes.
 */
export async function getLabel(orderIdentifier) {
  // documentType=1 is required by the Click & Drop API v1
  const resp = await axios.get(`${BASE}/orders/${orderIdentifier}/label?documentType=1`, {
    headers: { ...authHeaders(), Accept: 'application/pdf' },
    responseType: 'arraybuffer',
  });
  const ct = resp.headers['content-type'] || '';
  if (!ct.includes('pdf') && !ct.includes('octet-stream')) {
    // RM returned a non-PDF (e.g. JSON error) with HTTP 200 — surface the message
    const bodyText = Buffer.from(resp.data).toString('utf8').slice(0, 300);
    let detail = bodyText;
    try { detail = JSON.parse(bodyText)?.message || bodyText; } catch { /* use raw */ }
    throw new Error(`Royal Mail returned unexpected content (${ct}): ${detail}`);
  }
  return Buffer.from(resp.data);
}

/**
 * Merge an array of PDF Buffers into a single PDF Buffer using pdf-lib.
 * copies: how many identical copies of each label to include (default 2 for double-copy printing).
 */
export async function mergeLabels(pdfBuffers, copies = 2) {
  const merged = await PDFDocument.create();
  for (const buf of pdfBuffers) {
    try {
      const src = await PDFDocument.load(buf);
      const indices = src.getPageIndices();
      for (let c = 0; c < copies; c++) {
        const pages = await merged.copyPages(src, indices);
        pages.forEach(p => merged.addPage(p));
      }
    } catch {
      // skip malformed/empty pages
    }
  }
  const bytes = await merged.save();
  return Buffer.from(bytes);
}

/**
 * Create a manifest in Royal Mail Click & Drop for the given order identifiers ONLY.
 * orderIdentifiers must be a non-empty array — never manifests all orders.
 */
export async function createManifest(orderIdentifiers) {
  if (!orderIdentifiers?.length) {
    throw new Error('orderIdentifiers is required — pass the identifiers returned by the labelling step.');
  }
  // Click & Drop expects integer order IDs; safely coerce numeric strings back to numbers
  const ids = orderIdentifiers.map(id => {
    const n = Number(id);
    return Number.isFinite(n) && n > 0 ? n : id;
  });
  const body = {
    carrierName: 'Royal Mail OBA',
    orderIdentifiers: ids,
  };
  const { data } = await axios.post(`${BASE}/manifests`, body, {
    headers: authHeaders(),
  });
  return data;
}

/**
 * Poll GET /manifests/{guid} until completed, then return the base64-encoded PDF as a Buffer.
 * Returns null if the manifest never completes or has no PDF.
 */
export async function getManifestLabel(manifestGuid) {
  for (let attempt = 0; attempt < 8; attempt++) {
    await new Promise(r => setTimeout(r, 2000));
    try {
      const { data } = await axios.get(`${BASE}/manifests/${manifestGuid}`, {
        headers: authHeaders(),
      });
      if (data.manifestStatus === 'Completed' || data.documentStatus === 'Completed') {
        if (data.pdf) return Buffer.from(data.pdf, 'base64');
        return null;
      }
      if (data.manifestStatus === 'Failed') return null;
    } catch {
      // retry
    }
  }
  return null;
}

/**
 * List all orders in Click & Drop, following pagination (max pageSize=100).
 * Returns a flat array of RM order objects.
 * Each object has: orderIdentifier, orderReference, trackingNumber, etc.
 */
export async function listOrders(maxResults = 500) {
  const results = [];
  let continuationToken = null;
  const pageSize = 100; // API maximum

  do {
    const params = { pageSize, ...(continuationToken ? { continuationToken } : {}) };
    const { data } = await axios.get(`${BASE}/orders`, {
      headers: authHeaders(),
      params,
    });
    const page = Array.isArray(data) ? data : (data.orders || []);
    results.push(...page);
    continuationToken = Array.isArray(data) ? null : (data.continuationToken || null);
  } while (continuationToken && results.length < maxResults);

  return results;
}

export function isConfigured() {
  return Boolean(process.env.ROYAL_MAIL_OBA_TOKEN);
}
