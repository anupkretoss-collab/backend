import express from 'express';
import cors from 'cors';
import compression from 'compression';
import dotenv from 'dotenv';
import axios from 'axios';
dotenv.config();

import { runMigrations } from './services/db.js';
import authRoutes from './routes/auth.js';
import ordersRoutes from './routes/orders.js';
import preordersRoutes from './routes/preorders.js';
import delayedRoutes from './routes/delayed.js';
import webhookRoutes from './routes/webhooks.js';

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
  })
);

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

app.use(cors());

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
