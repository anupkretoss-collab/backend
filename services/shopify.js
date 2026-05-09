import '@shopify/shopify-api/adapters/node';
import { shopifyApi, LATEST_API_VERSION } from '@shopify/shopify-api';

const shopify = shopifyApi({
  apiKey: 'not-needed-for-custom-app',
  apiSecretKey: 'not-needed-for-custom-app',
  scopes: [
    // Orders
    'read_orders',
    'write_orders',

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

      // STEP 1: Get fulfillment orders
      const fulfillmentRes = await client.get({
        path: `orders/${id}/fulfillment_orders`,
      });

      const fulfillmentOrders =
        fulfillmentRes.body.fulfillment_orders || [];

      if (!fulfillmentOrders.length) {
        results.push({
          id,
          success: false,
          error: 'No fulfillment orders found',
        });
        continue;
      }

      // STEP 2: Prepare fulfillment payload
      const line_items_by_fulfillment_order =
        fulfillmentOrders.map((fo) => ({
          fulfillment_order_id: fo.id,
        }));

      // STEP 3: Create fulfillment
      const fulfillmentCreate = await client.post({
        path: 'fulfillments',
        data: {
          fulfillment: {
            notify_customer: notifyCustomer,
            line_items_by_fulfillment_order,
          },
        },
        type: 'application/json',
      });

      results.push({
        id,
        success: true,
        fulfillment: fulfillmentCreate.body,
      });

    } catch (err) {

      let errorMessage = err.message;

      // Better Shopify error logging
      if (err.response?.body) {
        errorMessage = JSON.stringify(err.response.body);
      }

      results.push({
        id,
        success: false,
        error: errorMessage,
      });
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
