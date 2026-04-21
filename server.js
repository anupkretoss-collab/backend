import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
dotenv.config();

import { runMigrations } from './services/db.js';
import authRoutes     from './routes/auth.js';
import ordersRoutes   from './routes/orders.js';
import preordersRoutes from './routes/preorders.js';
import delayedRoutes  from './routes/delayed.js';

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: '10mb' }));

// Routes
app.use('/api/auth',      authRoutes);
app.use('/api/orders',    ordersRoutes);
app.use('/api/preorders', preordersRoutes);
app.use('/api/delayed',   delayedRoutes);

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', message: 'Server is running' });
});

// Run DB migrations then start server
runMigrations()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`🚀 Backend server running on http://localhost:${PORT}`);
    });
  })
  .catch(err => {
    console.error('❌ Failed to run DB migrations:', err.message);
    console.error('   Check your DB_HOST, DB_USER, DB_PASSWORD, DB_NAME in .env');
    process.exit(1);
  });
