import '@shopify/shopify-api/adapters/node';
import { shopifyApi, LATEST_API_VERSION } from '@shopify/shopify-api';

const shopify = shopifyApi({
  apiKey: 'not-needed-for-custom-app',
  apiSecretKey: 'not-needed-for-custom-app',
  scopes: [
    // Orders
    'read_orders',
    'write_orders',
    "read_all_orders",

    // Products
    'read_products',
    'write_products',

    // Customers
    'read_customers',
    'write_customers',

    // Fulfillments
    'read_fulfillments',
    'write_fulfillments',

    // Fulfillment orders
    'read_merchant_managed_fulfillment_orders',
    'write_merchant_managed_fulfillment_orders',
  ],
  hostName: 'localhost',
  apiVersion: LATEST_API_VERSION,
  isEmbeddedApp: false,
});

function getClient() {
  const shopName = process.env.SHOPIFY_SHOP_NAME;
  const accessToken = process.env.SHOPIFY_ACCESS_TOKEN;
  if (!shopName || !accessToken) {
    throw new Error('Shopify credentials not configured.');
  }
  const session = shopify.session.customAppSession(shopName);
  session.accessToken = accessToken;
  return new shopify.clients.Rest({ session });
}

// ─── Generic paginated fetch ──────────────────────────────────────────────────
async function fetchAllPages(path, query = {}) {
  const client = getClient();
  let results = [];
  let pageInfo = null;

  do {
    const q = pageInfo
      ? { limit: 250, page_info: pageInfo }
      : { limit: 250, ...query };

    const response = await client.get({ path, query: q });
    const data = response.body[path] || response.body.orders || [];
    results = results.concat(data);

    const linkHeader = response.headers?.get?.('link') || '';
    const nextMatch = linkHeader.match(/<[^>]*page_info=([^&>]+)[^>]*>;\s*rel="next"/);
    pageInfo = nextMatch ? nextMatch[1] : null;
  } while (pageInfo);

  return results;
}

// ─── Fetch orders with skip + limit ──────────────────────────────────────────
// ─── Fetch orders with skip + limit ──────────────────────────────────────────
export async function fetchShopifyOrdersChunk({
  skip = 0,
  limit = 1000,
} = {}) {

  const client = getClient();

  let collectedOrders = [];

  let skipped = 0;

  let pageInfo = null;

  const pageLimit = 250;

  while (collectedOrders.length < limit) {

    const query = pageInfo
      ? {
        limit: pageLimit,
        page_info: pageInfo,
      }
      : {
        limit: pageLimit,
        status: 'any',
      };

    const response = await client.get({
      path: 'orders',
      query,
    });

    const orders =
      response.body.orders || [];

    console.log(
      `Fetched page orders: ${orders.length}`
    );

    if (!orders.length) {
      break;
    }

    // ============================================
    // SKIP + COLLECT
    // ============================================

    for (const order of orders) {

      if (skipped < skip) {

        skipped++;

        continue;
      }

      if (collectedOrders.length < limit) {

        collectedOrders.push(order);
      }
    }

    console.log({
      skipped,
      collected: collectedOrders.length
    });

    // ============================================
    // NEXT PAGE
    // ============================================

    let linkHeader =
      response.headers?.Link ||
      response.headers?.link ||
      '';

    if (Array.isArray(linkHeader)) {
      linkHeader = linkHeader.join(',');
    }

    const nextMatch =
      linkHeader.match(
        /page_info=([^&>]+)[^>]*>;\s*rel="next"/
      );

    pageInfo =
      nextMatch
        ? nextMatch[1]
        : null;

    console.log(
      'NEXT PAGE INFO:',
      pageInfo
    );

    if (!pageInfo) {
      break;
    }
  }

  console.log(
    `Final collected orders: ${collectedOrders.length}`
  );

  return collectedOrders;
}

// ─── Fetch all orders ─────────────────────────────────────────────────────────
export async function fetchShopifyOrders() {
  return fetchAllPages('orders', { status: 'any' });
}

export async function fetchShopifyProducts() {
  return fetchAllPages('products');
}

// ─── Fetch all customers ────────────────────────────────────
export async function fetchShopifyCustomers() {
  return fetchAllPages('customers');
}

export async function createProduct(productData) {
  const client = getClient();

  const response = await client.post({
    path: 'products',
    data: {
      product: productData,
    },
    type: 'application/json',
  });

  return response.body.product;
}

export async function updateProduct(productId, productData) {
  const client = getClient();

  const response = await client.put({
    path: `products/${productId}`,
    data: {
      product: {
        id: productId,
        ...productData,
      },
    },
    type: 'application/json',
  });

  return response.body.product;
}

export async function deleteProduct(productId) {
  const client = getClient();

  await client.delete({
    path: `products/${productId}`,
  });

  return true;
}

export async function createCustomer(customerData) {
  const client = getClient();

  const response = await client.post({
    path: 'customers',
    data: {
      customer: customerData,
    },
    type: 'application/json',
  });

  return response.body.customer;
}

export async function updateCustomer(customerId, customerData) {
  const client = getClient();

  const response = await client.put({
    path: `customers/${customerId}`,
    data: {
      customer: {
        id: customerId,
        ...customerData,
      },
    },
    type: 'application/json',
  });

  return response.body.customer;
}

export async function deleteCustomer(customerId) {
  const client = getClient();

  await client.delete({
    path: `customers/${customerId}`,
  });

  return true;
}

export async function fullStoreSync() {
  const [
    orders,
    products,
    customers,
  ] = await Promise.all([
    fetchShopifyOrders(),
    fetchShopifyProducts(),
    fetchShopifyCustomers(),
  ]);

  return {
    orders,
    products,
    customers,
  };
}

// ─── Fetch preorders by tag ───────────────────────────────────────────────────
// Preorders are identified by having a tag that contains "preorder" (case-insensitive)
// or by having a specific tag passed in.
export async function fetchPreorders({ type = 'all', dateFrom = null, dateTo = null } = {}) {
  const query = {
    status: 'any',
    fulfillment_status: 'unfulfilled',
  };

  if (dateFrom) query.created_at_min = new Date(dateFrom).toISOString();
  if (dateTo) {
    const d = new Date(dateTo);
    d.setHours(23, 59, 59, 999);
    query.created_at_max = d.toISOString();
  }

  const orders = await fetchAllPages('orders', query);

  // Filter by preorder tag
  const tagFilter = type === 'seedling'
    ? o => (o.tags || '').toLowerCase().includes('seedling') && (o.tags || '').toLowerCase().includes('preorder')
    : type === 'potplant'
      ? o => (o.tags || '').toLowerCase().includes('pot plant') && (o.tags || '').toLowerCase().includes('preorder')
      : o => (o.tags || '').toLowerCase().includes('preorder');

  return orders.filter(tagFilter);
}

// ─── Fetch a single order ─────────────────────────────────────────────────────
export async function fetchOrder(orderId) {
  const client = getClient();
  const response = await client.get({ path: `orders/${orderId}` });
  return response.body.order;
}

// ─── Add tag to orders (bulk) ─────────────────────────────────────────────────
export async function bulkTagOrders(
  orderIds,
  tag,
  onProgress = () => { }
) {

  const client = getClient();

  const results = [];

  const successfulIds = [];

  const sleep = (ms) =>
    new Promise(resolve =>
      setTimeout(resolve, ms)
    );

  let processed = 0;

  for (const orderId of orderIds) {

    try {

      // ============================================
      // GET CURRENT TAGS
      // ============================================

      const res =
        await client.get({
          path: `orders/${orderId}`,
          query: {
            fields: 'id,tags'
          }
        });

      const currentTags =
        res.body.order.tags || '';

      // ============================================
      // UNIQUE TAGS
      // ============================================

      const tagSet =
        new Set(
          currentTags
            .split(',')
            .map(t => t.trim())
            .filter(Boolean)
        );

      tagSet.add(tag);

      const newTags =
        Array.from(tagSet)
          .join(', ');

      // ============================================
      // UPDATE SHOPIFY ORDER
      // ============================================

      await client.put({
        path: `orders/${orderId}`,
        data: {
          order: {
            id: orderId,
            tags: newTags
          }
        },
        type: 'application/json',
      });

      successfulIds.push(orderId);

      results.push({
        id: orderId,
        success: true,
        tags: newTags
      });

      console.log(
        `✅ Tagged order ${orderId}`
      );

    } catch (err) {

      const message =
        err?.message || 'Unknown error';

      console.error(
        `❌ Tag failed for ${orderId}`,
        message
      );

      results.push({
        id: orderId,
        success: false,
        error: message
      });

      // ============================================
      // THROTTLE RECOVERY
      // ============================================

      if (
        message
          .toLowerCase()
          .includes('thrott')
      ) {

        console.log(
          '⏳ Shopify throttled. Waiting 60 seconds...'
        );

        await sleep(60000);
      }
    }

    processed++;

    // ============================================
    // UPDATE PROGRESS
    // ============================================

    onProgress({
      progress: Math.round(
        (processed / orderEntries.length) * 100
      ),
      completed:
        results.filter(r => r.success).length,
      failed:
        results.filter(r => !r.success).length,
    });

    // ============================================
    // RATE LIMIT PROTECTION
    // ============================================

    await sleep(4000);
  }

  return {
    results,
    successfulIds
  };
}

// ─── Remove tag from orders (bulk) ───────────────────────────────────────────
export async function bulkRemoveTag(orderIds, tag) {
  const client = getClient();
  const results = [];

  for (const id of orderIds) {
    try {
      const res = await client.get({ path: `orders/${id}`, query: { fields: 'id,tags' } });
      const current = res.body.order.tags || '';
      const tagSet = current.split(',').map(t => t.trim()).filter(t => t && t !== tag);
      await client.put({
        path: `orders/${id}`,
        data: { order: { id, tags: tagSet.join(', ') } },
      });
      results.push({ id, success: true });
    } catch (err) {
      results.push({ id, success: false, error: err.message });
    }
  }
  return results;
}

// ─── Mark orders as fulfilled ─────────────────────────────────────────────────
// orders: array of { shopifyId, trackingNumber? } OR plain order ID strings/numbers (legacy)
export async function markOrdersFulfilled(
  orders,
  notifyCustomer = true,
  onProgress = () => { }
) {

  console.log(orders, "order fullfulled");
  console.log(notifyCustomer, "notifycustomer");

  const client = getClient();

  const results = [];

  const successfulIds = [];

  const sleep = (ms) =>
    new Promise(resolve =>
      setTimeout(resolve, ms)
    );

  let processed = 0;

  // Normalise: accept both [{ shopifyId, trackingNumber, carrier }] and plain ID arrays
  const orderEntries = orders.map(o =>
    typeof o === 'object' && o.shopifyId
      ? o
      : { shopifyId: String(o), trackingNumber: null, carrier: 'royal-mail' }
  );

  // Shopify recognises these carrier names and auto-generates the correct tracking
  // URL for each — so no hand-built URL is needed except for Royal Mail (kept as-is
  // for backwards compatibility with existing behaviour).
  const CARRIER_INFO = {
    'royal-mail': {
      company: 'Royal Mail',
      url: (n) => `https://www.royalmail.com/portal/rm/track?trackNumber=${n}`,
    },
    'dpd': {
      company: 'DPD Local',
      // The tracking route is "/parcels/{parcelCode}" where parcelCode includes a
      // depot suffix (e.g. "15976709918193*21379") resolved via
      // getDpdParcelCode(parcelNumber, postcode) — callers that have it should pass
      // it as `trackingUrl` on the order entry (takes priority below). Falls back to
      // the tracking homepage if the lookup wasn't done/failed.
      url: () => 'https://track.dpdlocal.co.uk/',
    },
  };

  for (const { shopifyId: orderId, trackingNumber, carrier, trackingUrl: trackingUrlOverride } of orderEntries) {

    try {

      console.log(
        `🚚 Processing fulfillment for ${orderId}${trackingNumber ? ` (${trackingNumber})` : ''}`
      );

      // ============================================
      // GET FULFILLMENT ORDERS
      // ============================================

      const fulfillmentRes =
        await client.get({
          path: `orders/${orderId}/fulfillment_orders`,
        });

      const fulfillmentOrders =
        fulfillmentRes.body
          .fulfillment_orders || [];

      if (!fulfillmentOrders.length) {

        results.push({
          id: orderId,
          success: false,
          error:
            'No fulfillment orders found',
        });

        processed++;

        continue;
      }

      // ============================================
      // PREPARE PAYLOAD
      // ============================================

      const line_items_by_fulfillment_order =
        fulfillmentOrders.map(fo => ({
          fulfillment_order_id: fo.id,
        }));

      const fulfillmentPayload = {
        notify_customer: notifyCustomer,
        line_items_by_fulfillment_order,
      };

      // Include tracking info if available
      if (trackingNumber) {
        const info = CARRIER_INFO[carrier] || CARRIER_INFO['royal-mail'];
        const url = trackingUrlOverride || (info.url ? info.url(trackingNumber) : null);
        fulfillmentPayload.tracking_info = {
          number: trackingNumber,
          company: info.company,
          ...(url ? { url } : {}),
        };
      }

      // ============================================
      // CREATE FULFILLMENT
      // ============================================

      const fulfillmentCreate =
        await client.post({
          path: 'fulfillments',
          data: {
            fulfillment: fulfillmentPayload,
          },
          type: 'application/json',
        });

      successfulIds.push(orderId);

      results.push({
        id: orderId,
        success: true,
        fulfillment:
          fulfillmentCreate.body,
      });

      console.log(
        `✅ Fulfilled order ${orderId}`
      );

    } catch (err) {

      let errorMessage =
        err?.message || 'Unknown error';

      if (err.response?.body) {

        errorMessage =
          JSON.stringify(
            err.response.body
          );
      }

      console.error(
        `❌ Fulfillment failed ${orderId}`,
        errorMessage
      );

      results.push({
        id: orderId,
        success: false,
        error: errorMessage,
      });

      // ============================================
      // THROTTLE RECOVERY
      // ============================================

      if (
        errorMessage
          .toLowerCase()
          .includes('thrott')
      ) {

        console.log(
          '⏳ Shopify throttled. Waiting 60 seconds...'
        );

        await sleep(60000);
      }
    }

    processed++;

    // ============================================
    // UPDATE PROGRESS
    // ============================================

    onProgress({
      progress: Math.round(
        (processed / orderEntries.length) * 100
      ),
      completed:
        results.filter(r => r.success).length,
      failed:
        results.filter(r => !r.success).length,
    });

    // ============================================
    // RATE LIMIT PROTECTION
    // ============================================

    if (orderEntries.length > 1) {
      await sleep(5000);
    }
  }

  return {
    results,
    successfulIds
  };
}

// ─── Fetch orders by tag ──────────────────────────────────────────────────────
export async function fetchOrdersByTag(tag) {
  // Shopify doesn't support tag filtering in REST API directly for all orders,
  // so we fetch all unfulfilled and filter client-side
  const orders = await fetchAllPages('orders', { status: 'any', fulfillment_status: 'unfulfilled' });
  return orders.filter(o => {
    const tags = (o.tags || '').split(',').map(t => t.trim());
    return tags.includes(tag);
  });
}
