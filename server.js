import express from 'express';
import cors from 'cors';
import compression from 'compression';
import dotenv from 'dotenv';
import axios from 'axios';
import path from 'path';
import { fileURLToPath } from 'url';
import http from 'http';
import https from 'https';
dotenv.config();

// Node 19+ switched the default global HTTP(S) agent to keepAlive: true.
// @shopify/shopify-api still bundles node-fetch@2 internally, which predates
// that change — on this combination, reused keep-alive sockets to Shopify get
// closed mid-response under load, surfacing as
// "FetchError: ... Premature close" (ERR_STREAM_PREMATURE_CLOSE) while
// decompressing a response body, most visible on larger payloads like
// customers.json. Forcing a fresh connection per request avoids it.
http.globalAgent.keepAlive = false;
https.globalAgent.keepAlive = false;

const __dirname = path.dirname(fileURLToPath(import.meta.url));

import { runMigrations } from './services/db.js';
import authRoutes from './routes/auth.js';
import ordersRoutes, { batchUpsertOrders, invalidateMetaCache } from './routes/orders.js';
import preordersRoutes from './routes/preorders.js';
import delayedRoutes from './routes/delayed.js';
import webhookRoutes from './routes/webhooks.js';
import { fetchRecentlyUpdatedOrders } from './services/shopify.js';

const app = express();
const PORT = process.env.PORT || 3000;
// Capture raw body for Shopify HMAC validation
app.use('/api/webhooks', webhookRoutes);

app.use(compression());

app.use(
  cors({
    origin: "*",
    methods: ["GET", "POST", "DELETE", "PUT", "FETCH", "PATCH"],
    allowedHeaders: ["Content-Type", "authorization", "public-request"],
    exposedHeaders: ["X-Shipment-Count", "X-Order-Identifiers", "X-Failed-Orders", "X-Processed-Shopify-Ids", "X-Tracking-Numbers", "X-Fulfilled-Count", "X-Manifest-Number", "X-Has-Labels", "X-Has-S17", "X-Has-Manifest", "X-Has-Records", "X-Fulfill-Errors", "X-Manifest-Error", "X-Records-Error", "X-Saved-File-Url", "X-Skipped-Orders", "X-Fulfill-Job-Id"],
  })
);

// Standing copies of generated batch PDFs (Royal Mail / DPD) — written by
// routes/orders.js so a failed download doesn't mean redoing the whole batch.
app.use('/files', express.static(path.join(__dirname, 'public', 'generated')));

const SHOPIFY_API_KEY = process.env.SHOPIFY_API_KEY;
const SHOPIFY_API_SECRET = process.env.SHOPIFY_API_SECRET_TOKEN_KEY;

app.get("/", (req, res) => {
  res.send("Backend running");
});


app.get("/api/auth/callback", async (req, res) => {
  try {
    const { shop, code } = req.query;

    if (!shop || !code) {
      return res.status(400).json({
        success: false,
        message: "Missing shop or code",
      });
    }

    const tokenResponse = await axios.post(
      `https://${shop}/admin/oauth/access_token`,
      {
        client_id: SHOPIFY_API_KEY,
        client_secret: SHOPIFY_API_SECRET,
        code,
      },
      {
        headers: {
          "Content-Type": "application/json",
        },
      }
    );

    const accessToken = tokenResponse.data.access_token;

    console.log("✅ ACCESS TOKEN:", accessToken);

    // Save token into DB here

    res.json({
      success: true,
      shop,
      accessToken,
    });

  } catch (error) {
    console.log(
      "❌ SHOPIFY ERROR:",
      error.response?.data || error.message
    );

    res.status(500).json({
      success: false,
      error: error.response?.data || error.message,
    });
  }
});

app.use(express.json({ limit: '10mb' }));

// Routes
app.use('/api/auth', authRoutes);
app.use('/api/orders', ordersRoutes);
app.use('/api/preorders', preordersRoutes);
app.use('/api/delayed', delayedRoutes);

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', message: 'Server is running' });
});

// Run DB migrations then start server
// Start the server first so Render health checks pass,
// then attempt DB migrations in the background.
app.listen(PORT, () => {
  console.log(`🚀 Backend server running on http://localhost:${PORT}`);
});

runMigrations()
  .then(() => {
    console.log('✅ Database ready.');
  })
  .catch(err => {
    console.warn('⚠️  DB not available:', err.message);
    console.warn('   API routes requiring DB will return 503 until a database is connected.');
    console.warn('   Set DB_HOST, DB_PORT, DB_USER, DB_PASSWORD, DB_NAME as environment variables.');
  });

// ─── Webhook safety net ────────────────────────────────────────────────────
// Webhooks can be missed (server mid-restart/deploy, a dropped request,
// Shopify's own retry window exhausted) with nothing to signal it happened —
// the local order silently goes stale. Rather than trying to detect/retry
// individual missed webhooks, this just polls Shopify every few minutes for
// anything changed recently and re-syncs it, so a missed webhook is caught
// within one poll cycle instead of staying wrong indefinitely. The lookback
// window is wider than the poll interval so a slow/delayed run still overlaps
// the previous one with no gap.
const RECONCILE_INTERVAL_MS = 5 * 60 * 1000;   // 5 minutes
const RECONCILE_LOOKBACK_MS = 20 * 60 * 1000;  // 20 minutes
let reconciling = false;

async function reconcileRecentOrders() {
  if (reconciling) return; // previous run still in flight — skip this tick rather than overlap
  if (!process.env.SHOPIFY_SHOP_NAME || !process.env.SHOPIFY_ACCESS_TOKEN) return;
  reconciling = true;
  try {
    const since = new Date(Date.now() - RECONCILE_LOOKBACK_MS).toISOString();
    const orders = await fetchRecentlyUpdatedOrders(since);
    if (orders.length) {
      await batchUpsertOrders(orders);
      invalidateMetaCache();
      console.log(`🔄 Reconcile: re-synced ${orders.length} recently-updated order(s) (webhook safety net)`);
    }
  } catch (err) {
    console.warn('⚠️  Reconcile poll failed (will retry next cycle):', err.message);
  } finally {
    reconciling = false;
  }
}

setInterval(reconcileRecentOrders, RECONCILE_INTERVAL_MS);
// Also run shortly after boot, so a webhook missed just before a restart
// isn't left stale for the first full interval.
setTimeout(reconcileRecentOrders, 30 * 1000);
