import express from 'express';
import crypto from 'crypto';

import { deleteProduct, upsertCustomer, upsertOrder, upsertProduct } from './orders.js';

const router = express.Router();

router.post(
  '/shopify',
  express.raw({ type: '*/*' }),
  async (req, res) => {
    try {
      const secret = process.env.SHOPIFY_API_SECRET_KEY;

      const hmac = req.get('X-Shopify-Hmac-Sha256');
      const topic = req.get('X-Shopify-Topic');
      const shop = req.get('X-Shopify-Shop-Domain');

      console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
      console.log('📩 Shopify Webhook Received');
      console.log('🏪 Shop:', shop);
      console.log('📌 Topic:', topic);

      // Verify webhook signature
      const generatedHash = crypto
        .createHmac('sha256', secret)
        .update(req.body)
        .digest('base64');

      console.log('Generated:', generatedHash);
      console.log('Received :', hmac);

      const hashBuffer = Buffer.from(generatedHash, 'utf8');
      const hmacBuffer = Buffer.from(hmac || '', 'utf8');

      if (hashBuffer.length !== hmacBuffer.length) {
        console.error('❌ Hash length mismatch');
        return res.status(401).send('Invalid signature');
      }

      const isValid = crypto.timingSafeEqual(
        hashBuffer,
        hmacBuffer
      );

      if (!isValid) {
        console.error('❌ Invalid webhook signature');
        return res.status(401).send('Invalid signature');
      }

      console.log(`✅ Valid webhook: ${topic}`);

      // Parse Shopify payload
      const payload = JSON.parse(req.body.toString('utf8'));

      // ====================================================
      // ORDER WEBHOOKS
      // ====================================================

      switch (topic) {

        case 'orders/create':
          console.log(`🛒 New order #${payload.order_number}`);

          await upsertOrder(payload);

          console.log(`✅ Order created #${payload.order_number}`);
          break;

        case 'orders/updated':
          console.log(`✏️ Order updated #${payload.order_number}`);

          await upsertOrder(payload);

          console.log(`✅ Order updated #${payload.order_number}`);
          break;

        case 'orders/fulfilled':
          console.log(`📦 Order fulfilled #${payload.order_number}`);

          await upsertOrder(payload);

          console.log(`✅ Order fulfilled #${payload.order_number}`);
          break;

        case 'orders/paid':
          console.log(`💰 Order paid #${payload.order_number}`);

          await upsertOrder(payload);

          console.log(`✅ Payment updated #${payload.order_number}`);
          break;

        case 'orders/cancelled':
          console.log(`❌ Order cancelled #${payload.order_number}`);

          await upsertOrder(payload);

          console.log(`✅ Cancelled order synced #${payload.order_number}`);
          break;

        // // ====================================================
        // // PRODUCT WEBHOOKS
        // // ====================================================

        // case 'products/create':
        //   console.log(`🆕 Product created: ${payload.title}`);

        //   // TODO:
        //   await upsertProduct(payload);

        //   console.log(`✅ Product synced`);
        //   break;

        // case 'products/update':
        //   console.log(`✏️ Product updated: ${payload.title}`);

        //   // TODO:
        //   await upsertProduct(payload);

        //   console.log(`✅ Product updated`);
        //   break;

        // case 'products/delete':
        //   console.log(`🗑️ Product deleted: ${payload.id}`);

        //   // TODO:
        //   await deleteProduct(payload.id);

        //   console.log(`✅ Product deleted`);
        //   break;

        // // ====================================================
        // // CUSTOMER WEBHOOKS
        // // ====================================================

        // case 'customers/create':
        //   console.log(`👤 Customer created: ${payload.email}`);

        //   // TODO:
        //   await upsertCustomer(payload);

        //   console.log(`✅ Customer synced`);
        //   break;

        // case 'customers/update':
        //   console.log(`✏️ Customer updated: ${payload.email}`);

        //   // TODO:
        //   await upsertCustomer(payload);

        //   console.log(`✅ Customer updated`);
        //   break;

        // // ====================================================
        // // APP WEBHOOKS
        // // ====================================================

        // case 'app/uninstalled':
        //   console.log(`⚠️ App uninstalled from ${shop}`);

        //   // TODO:
        //   // deactivate store
        //   // clear tokens
        //   // disable sync
        //   break;

        // ====================================================
        // DEFAULT
        // ====================================================

        default:
          console.log(`ℹ️ Unhandled topic: ${topic}`);
          break;
      }

      res.status(200).send('Webhook processed');
    } catch (err) {
      console.error('❌ Shopify webhook error:', err);

      res.status(500).send('Server Error');
    }
  }
);

export default router;