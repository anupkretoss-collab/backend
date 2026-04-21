import mysql from 'mysql2/promise';
import dotenv from 'dotenv';
dotenv.config();

const DB_NAME = process.env.DB_NAME || 'shopify_admin';

// Pool used by the rest of the app (with database selected)
let pool;

export function getPool() {
  return pool;
}

// Default export — proxy so existing imports `pool.query(...)` still work
const poolProxy = new Proxy({}, {
  get(_, prop) {
    return (...args) => getPool()[prop](...args);
  },
});

export default poolProxy;

// ─── Run migrations then initialise the main pool ─────────────────────────────
export async function runMigrations() {
  // Step 1: connect WITHOUT a database to create it if missing
  const bootstrap = await mysql.createConnection({
    host:     process.env.DB_HOST     || '127.0.0.1',
    port:     parseInt(process.env.DB_PORT || '3306'),
    user:     process.env.DB_USER     || 'root',
    password: process.env.DB_PASSWORD || '',
  });

  await bootstrap.query(`CREATE DATABASE IF NOT EXISTS \`${DB_NAME}\``);
  await bootstrap.end();

  // Step 2: now create the real pool with the database selected
  pool = mysql.createPool({
    host:               process.env.DB_HOST     || '127.0.0.1',
    port:               parseInt(process.env.DB_PORT || '3306'),
    user:               process.env.DB_USER     || 'root',
    password:           process.env.DB_PASSWORD || '',
    database:           DB_NAME,
    waitForConnections: true,
    connectionLimit:    10,
    queueLimit:         0,
    timezone:           '+00:00',
  });

  // Step 3: create tables
  const conn = await pool.getConnection();
  try {
    // users
    await conn.query(`
      CREATE TABLE IF NOT EXISTS users (
        id         INT AUTO_INCREMENT PRIMARY KEY,
        username   VARCHAR(100) NOT NULL UNIQUE,
        password   VARCHAR(255) NOT NULL,
        role       VARCHAR(50)  NOT NULL DEFAULT 'admin',
        created_at DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
      )
    `);

    // orders
    await conn.query(`
      CREATE TABLE IF NOT EXISTS orders (
        id                  BIGINT       PRIMARY KEY,
        order_number        INT          NOT NULL,
        email               VARCHAR(255),
        financial_status    VARCHAR(50),
        fulfillment_status  VARCHAR(50),
        total_price         DECIMAL(12,2),
        currency            VARCHAR(10),
        tags                TEXT,
        note                TEXT,
        customer_id         BIGINT,
        customer_first_name VARCHAR(100),
        customer_last_name  VARCHAR(100),
        customer_email      VARCHAR(255),
        customer_phone      VARCHAR(50),
        shipping_name       VARCHAR(200),
        shipping_address1   VARCHAR(255),
        shipping_address2   VARCHAR(255),
        shipping_city       VARCHAR(100),
        shipping_province   VARCHAR(100),
        shipping_zip        VARCHAR(20),
        shipping_country    VARCHAR(10),
        shipping_phone      VARCHAR(50),
        line_items          JSON,
        shipping_lines      JSON,
        raw_data            JSON,
        created_at          DATETIME,
        updated_at          DATETIME,
        synced_at           DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
      )
    `);

    // delayed_log
    await conn.query(`
      CREATE TABLE IF NOT EXISTS delayed_log (
        id            INT AUTO_INCREMENT PRIMARY KEY,
        order_id      VARCHAR(50)  NOT NULL UNIQUE,
        order_number  VARCHAR(50),
        customer_name VARCHAR(200),
        reason        TEXT,
        delay_until   DATE,
        added_at      DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
      )
    `);

    // Seed default admin if table is empty
    const [rows] = await conn.query('SELECT COUNT(*) AS cnt FROM users');
    if (rows[0].cnt === 0) {
      const username = process.env.ADMIN_USERNAME || 'admin';
      const password = process.env.ADMIN_PASSWORD || 'admin123';
      await conn.query(
        'INSERT INTO users (username, password, role) VALUES (?, ?, ?)',
        [username, password, 'admin']
      );
      console.log(`✅ Default admin user "${username}" created.`);
    }

    console.log('✅ Database migrations complete.');
  } finally {
    conn.release();
  }
}
