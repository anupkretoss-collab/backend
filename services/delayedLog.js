// Delayed shipping log — backed by MySQL delayed_log table
import pool from './db.js';

export async function readLog() {
  const [rows] = await pool.query(
    'SELECT * FROM delayed_log ORDER BY added_at DESC'
  );
  return rows.map(r => ({
    orderId:      r.order_id,
    orderNumber:  r.order_number,
    customerName: r.customer_name,
    reason:       r.reason,
    delayUntil:   r.delay_until ? r.delay_until.toISOString().split('T')[0] : null,
    addedAt:      r.added_at,
    updatedAt:    r.updated_at,
  }));
}

export async function addToLog({ orderId, orderNumber, customerName, reason, delayUntil }) {
  await pool.query(
    `INSERT INTO delayed_log (order_id, order_number, customer_name, reason, delay_until)
     VALUES (?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
       order_number  = VALUES(order_number),
       customer_name = VALUES(customer_name),
       reason        = VALUES(reason),
       delay_until   = VALUES(delay_until),
       updated_at    = CURRENT_TIMESTAMP`,
    [
      String(orderId),
      orderNumber || null,
      customerName || null,
      reason || null,
      delayUntil || null,
    ]
  );
  return readLog();
}

export async function removeFromLog(orderId) {
  await pool.query('DELETE FROM delayed_log WHERE order_id = ?', [String(orderId)]);
  return readLog();
}

export async function bulkRemoveFromLog(orderIds) {
  if (!orderIds.length) return readLog();
  const placeholders = orderIds.map(() => '?').join(',');
  await pool.query(
    `DELETE FROM delayed_log WHERE order_id IN (${placeholders})`,
    orderIds.map(String)
  );
  return readLog();
}

export async function isDelayed(orderId) {
  const [rows] = await pool.query(
    'SELECT 1 FROM delayed_log WHERE order_id = ? LIMIT 1',
    [String(orderId)]
  );
  return rows.length > 0;
}
