import '@shopify/shopify-api/adapters/node';
import { shopifyApi, LATEST_API_VERSION } from '@shopify/shopify-api';

const shopify = shopifyApi({
  apiKey: 'not-needed-for-custom-app',
  apiSecretKey: 'not-needed-for-custom-app',
  scopes: ['read_orders', 'write_orders'],
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

// ─── Fetch all orders ─────────────────────────────────────────────────────────
export async function fetchShopifyOrders() {
  return fetchAllPages('orders', { status: 'any' });
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
export async function bulkTagOrders(orderIds, tag) {
  const client = getClient();
  const results = [];

  for (const id of orderIds) {
    try {
      // Fetch current tags
      const res = await client.get({ path: `orders/${id}`, query: { fields: 'id,tags' } });
      const current = res.body.order.tags || '';
      const tagSet = new Set(current.split(',').map(t => t.trim()).filter(Boolean));
      tagSet.add(tag);
      const newTags = Array.from(tagSet).join(', ');

      await client.put({
        path: `orders/${id}`,
        data: { order: { id, tags: newTags } },
      });
      results.push({ id, success: true });
    } catch (err) {
      results.push({ id, success: false, error: err.message });
    }
  }
  return results;
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
export async function markOrdersFulfilled(orderIds, notifyCustomer = true) {
  const client = getClient();
  const results = [];

  for (const id of orderIds) {
    try {
      // Get line items
      const orderRes = await client.get({ path: `orders/${id}`, query: { fields: 'id,line_items,fulfillment_status' } });
      const order = orderRes.body.order;

      if (order.fulfillment_status === 'fulfilled') {
        results.push({ id, success: true, skipped: true });
        continue;
      }

      const lineItemIds = order.line_items.map(li => ({ id: li.id }));

      await client.post({
        path: `orders/${id}/fulfillments`,
        data: {
          fulfillment: {
            line_items: lineItemIds,
            notify_customer: notifyCustomer,
          },
        },
      });
      results.push({ id, success: true });
    } catch (err) {
      results.push({ id, success: false, error: err.message });
    }
  }
  return results;
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
