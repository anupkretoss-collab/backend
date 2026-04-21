import express from 'express';
import { authenticateToken } from '../middleware/auth.js';
import { readLog, addToLog, removeFromLog, bulkRemoveFromLog } from '../services/delayedLog.js';
import { bulkTagOrders } from '../services/shopify.js';

const router = express.Router();

// GET /api/delayed — list all delayed orders
router.get('/', authenticateToken, async (req, res) => {
  try {
    const entries = await readLog();
    res.json({ entries });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// POST /api/delayed — add or update an entry
router.post('/', authenticateToken, async (req, res) => {
  const { orderId, orderNumber, customerName, reason, delayUntil } = req.body;
  if (!orderId) return res.status(400).json({ message: 'orderId is required' });

  try {
    const entries = await addToLog({ orderId: String(orderId), orderNumber, customerName, reason, delayUntil });
    res.json({ message: 'Order added to delayed log', entries });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// DELETE /api/delayed/:orderId — remove a single entry
router.delete('/:orderId', authenticateToken, async (req, res) => {
  try {
    const entries = await removeFromLog(req.params.orderId);
    res.json({ message: 'Order removed from delayed log', entries });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// POST /api/delayed/bulk-remove — remove multiple entries
router.post('/bulk-remove', authenticateToken, async (req, res) => {
  const { orderIds = [] } = req.body;
  try {
    const entries = await bulkRemoveFromLog(orderIds);
    res.json({ message: `${orderIds.length} orders removed from delayed log`, entries });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// POST /api/delayed/bulk-tag — tag delayed orders in Shopify
router.post('/bulk-tag', authenticateToken, async (req, res) => {
  try {
    const log = await readLog();
    const orderIds = log.map(e => e.orderId);
    if (!orderIds.length) return res.json({ message: 'No delayed orders to tag', results: [] });

    const results = await bulkTagOrders(orderIds, 'DELAYED SHIPPING');
    res.json({ message: 'Delayed orders tagged in Shopify', results });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

export default router;
