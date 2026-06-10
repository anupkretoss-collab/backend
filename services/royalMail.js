import axios from 'axios';
import { PDFDocument } from 'pdf-lib';

const BASE = process.env.ROYAL_MAIL_API_URL || 'https://api.parcel.royalmail.com/api/v1';
const SERVICE_CODE = 'TPS48'; // Royal Mail Tracked 48 Parcel

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

function buildPayload(order, despatchDate) {
  const a = order.shipping_address || {};
  const c = order.customer || {};
  const lineItems = order.line_items || [];
  const weightG = calcWeightG(lineItems);

  return {
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
    plannedDespatchDate: despatchDate || new Date().toISOString().slice(0, 10),
    specialInstructions: order.note || '',
    subtotal: parseFloat(order.subtotal_price || order.total_price || 0),
    shippingCostCharged: 0,
    total: parseFloat(order.total_price || 0),
    currencyCode: order.currency || 'GBP',
    label: { includeLabelInResponse: false },
    serviceCode: SERVICE_CODE,
  };
}

/**
 * Create a single shipment in Royal Mail Click & Drop.
 * Returns { orderIdentifier, trackingNumber, status }
 */
export async function createShipment(order, despatchDate) {
  const payload = buildPayload(order, despatchDate);
  const { data } = await axios.post(`${BASE}/orders`, payload, {
    headers: authHeaders(),
  });
  return {
    orderIdentifier: data.orderIdentifier,
    trackingNumber: data.trackingNumber || null,
    status: data.status || 'created',
    shopifyOrderId: order.id,
    orderNumber: order.order_number,
  };
}

/**
 * Fetch the label PDF for a given RM orderIdentifier.
 * Returns a Buffer containing the PDF bytes.
 */
export async function getLabel(orderIdentifier) {
  const { data } = await axios.get(`${BASE}/orders/${orderIdentifier}/label`, {
    headers: { ...authHeaders(), Accept: 'application/pdf' },
    responseType: 'arraybuffer',
  });
  return Buffer.from(data);
}

/**
 * Merge an array of PDF Buffers into a single PDF Buffer using pdf-lib.
 */
export async function mergeLabels(pdfBuffers) {
  const merged = await PDFDocument.create();
  for (const buf of pdfBuffers) {
    try {
      const src = await PDFDocument.load(buf);
      const indices = src.getPageIndices();
      const pages = await merged.copyPages(src, indices);
      pages.forEach(p => merged.addPage(p));
    } catch {
      // skip malformed/empty pages
    }
  }
  const bytes = await merged.save();
  return Buffer.from(bytes);
}

/**
 * Create a manifest in Royal Mail (manifests all orders in ready-to-manifest state).
 * Returns the manifest response data.
 */
export async function createManifest() {
  const { data } = await axios.post(`${BASE}/manifests`, {}, {
    headers: authHeaders(),
  });
  return data;
}

/**
 * Fetch the manifest label/PDF for a given manifestIdentifier.
 * Returns a Buffer (PDF) or null if the endpoint is not supported.
 */
export async function getManifestLabel(manifestIdentifier) {
  try {
    const { data } = await axios.get(`${BASE}/manifests/${manifestIdentifier}/label`, {
      headers: { ...authHeaders(), Accept: 'application/pdf' },
      responseType: 'arraybuffer',
    });
    return Buffer.from(data);
  } catch {
    return null;
  }
}

export function isConfigured() {
  return Boolean(process.env.ROYAL_MAIL_OBA_TOKEN);
}
