import mysql from 'mysql2/promise';
import dotenv from 'dotenv';

dotenv.config();

const DB_NAME = process.env.DB_NAME || 'shopify_admin';

// Pool used by the rest of the app
let pool;

export function getPool() {
  return pool;
}

// Default export proxy
const poolProxy = new Proxy(
  {},
  {
    get(_, prop) {
      return (...args) => getPool()[prop](...args);
    },
  }
);

export default poolProxy;

// ─────────────────────────────────────────────────────────────
// Run migrations and initialize DB
// ─────────────────────────────────────────────────────────────
export async function runMigrations() {
  // =========================================================
  // CREATE DATABASE IF NOT EXISTS
  // =========================================================

  const bootstrap = await mysql.createConnection({
    host: process.env.DB_HOST || '127.0.0.1',
    port: parseInt(process.env.DB_PORT || '3306'),
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
  });

  await bootstrap.query(`CREATE DATABASE IF NOT EXISTS \`${DB_NAME}\``);

  await bootstrap.end();

  // =========================================================
  // MAIN DB POOL
  // =========================================================

  pool = mysql.createPool({
    host: process.env.DB_HOST || '127.0.0.1',
    port: parseInt(process.env.DB_PORT || '3306'),
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    database: DB_NAME,
    waitForConnections: true,
    connectionLimit: parseInt(process.env.DB_POOL_SIZE || '25'),
    queueLimit: 100,
    connectTimeout: 10000,
    enableKeepAlive: true,
    keepAliveInitialDelay: 30000,
    timezone: '+00:00',
  });

  const conn = await pool.getConnection();

  try {
    // =========================================================
    // USERS
    // =========================================================

    await conn.query(`
      CREATE TABLE IF NOT EXISTS users (
        id INT AUTO_INCREMENT PRIMARY KEY,

        username VARCHAR(100) NOT NULL UNIQUE,
        password VARCHAR(255) NOT NULL,

        role VARCHAR(50) NOT NULL DEFAULT 'admin',

        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,

        updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
                    ON UPDATE CURRENT_TIMESTAMP
      )
    `);

    // =========================================================
    // CUSTOMERS
    // =========================================================

    await conn.query(`
      CREATE TABLE IF NOT EXISTS customers (
        id BIGINT PRIMARY KEY,

        first_name VARCHAR(255),
        last_name VARCHAR(255),

        email VARCHAR(255) UNIQUE,
        phone VARCHAR(100),

        accepts_marketing BOOLEAN DEFAULT FALSE,
        verified_email BOOLEAN DEFAULT FALSE,

        orders_count INT DEFAULT 0,

        total_spent DECIMAL(12,2),

        state VARCHAR(100),
        tags TEXT,

        currency VARCHAR(20),

        address1 TEXT,
        city VARCHAR(255),
        province VARCHAR(255),
        country VARCHAR(255),
        zip VARCHAR(50),

        raw_data JSON,

        created_at DATETIME,
        updated_at DATETIME,

        deleted_at DATETIME NULL,

        synced_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
                  ON UPDATE CURRENT_TIMESTAMP
      )
    `);

    // =========================================================
    // PRODUCTS
    // =========================================================

    await conn.query(`
      CREATE TABLE IF NOT EXISTS products (
        id BIGINT PRIMARY KEY,

        title VARCHAR(255),

        handle VARCHAR(255),

        vendor VARCHAR(255),

        product_type VARCHAR(255),

        seo_title VARCHAR(255),
        seo_description TEXT,

        status VARCHAR(100),

        tags TEXT,

        price DECIMAL(12,2),

        compare_at_price DECIMAL(12,2),

        inventory_quantity INT DEFAULT 0,

        image TEXT,

        variants JSON,

        options_data JSON,

        raw_data JSON,

        created_at DATETIME,
        updated_at DATETIME,

        deleted_at DATETIME NULL,

        synced_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
                  ON UPDATE CURRENT_TIMESTAMP
      )
    `);

    // =========================================================
    // ORDERS
    // =========================================================

    await conn.query(`
      CREATE TABLE IF NOT EXISTS orders (
        id BIGINT PRIMARY KEY,

        order_number INT NOT NULL,

        email VARCHAR(255),

        financial_status VARCHAR(50),

        fulfillment_status VARCHAR(50),

        total_price DECIMAL(12,2),

        currency VARCHAR(10),

        tags TEXT,

        note TEXT,

        customer_id BIGINT,

        customer_first_name VARCHAR(100),

        customer_last_name VARCHAR(100),

        customer_email VARCHAR(255),

        customer_phone VARCHAR(50),

        shipping_name VARCHAR(200),

        shipping_address1 VARCHAR(255),

        shipping_address2 VARCHAR(255),

        shipping_city VARCHAR(100),

        shipping_province VARCHAR(100),

        shipping_zip VARCHAR(20),

        shipping_country VARCHAR(100),

        shipping_phone VARCHAR(50),

        line_items JSON,

        shipping_lines JSON,

        raw_data JSON,

        total_quantity INT NOT NULL DEFAULT 0,

        created_at DATETIME,

        updated_at DATETIME,

        synced_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
                  ON UPDATE CURRENT_TIMESTAMP
      )
    `);

    // Add total_quantity to existing tables that predate this migration
    try {
      await conn.query(`ALTER TABLE orders ADD COLUMN total_quantity INT NOT NULL DEFAULT 0`);
    } catch { }

    // =========================================================
    // WEBHOOK LOGS
    // =========================================================

    await conn.query(`
      CREATE TABLE IF NOT EXISTS webhook_logs (
        id BIGINT AUTO_INCREMENT PRIMARY KEY,

        topic VARCHAR(255),

        shop VARCHAR(255),

        webhook_id VARCHAR(255),

        status VARCHAR(50),

        payload JSON,

        error_message TEXT,

        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // =========================================================
    // INDEXES
    // =========================================================

    try {
      await conn.query(`
        CREATE INDEX idx_orders_created_at
        ON orders(created_at)
      `);
    } catch { }

    try {
      await conn.query(`
        CREATE INDEX idx_orders_status
        ON orders(financial_status, fulfillment_status)
      `);
    } catch { }

    try {
      await conn.query(`
        CREATE INDEX idx_products_title
        ON products(title)
      `);
    } catch { }

    try {
      await conn.query(`
        CREATE INDEX idx_products_handle
        ON products(handle)
      `);
    } catch { }

    try {
      await conn.query(`
        CREATE INDEX idx_customers_email
        ON customers(email)
      `);
    } catch { }

    try {
      await conn.query(`
        CREATE INDEX idx_customers_name
        ON customers(first_name, last_name)
      `);
    } catch { }

    try {
      await conn.query(`CREATE INDEX idx_orders_order_number ON orders(order_number)`);
    } catch { }

    try {
      await conn.query(`CREATE INDEX idx_orders_customer_email ON orders(customer_email)`);
    } catch { }

    try {
      await conn.query(`CREATE INDEX idx_orders_customer_name ON orders(customer_first_name, customer_last_name)`);
    } catch { }

    try {
      await conn.query(`CREATE INDEX idx_orders_total_quantity ON orders(total_quantity)`);
    } catch { }

    // =========================================================
    // DEFAULT ADMIN USER
    // =========================================================

    const [rows] = await conn.query(
      'SELECT COUNT(*) AS cnt FROM users'
    );

    if (rows[0].cnt === 0) {
      const username = process.env.ADMIN_USERNAME || 'admin';

      const password = process.env.ADMIN_PASSWORD || 'admin123';

      await conn.query(
        'INSERT INTO users (username, password, role) VALUES (?, ?, ?)',
        [username, password, 'admin']
      );

      console.log(`✅ Default admin "${username}" created.`);
    }

    console.log('✅ Database migrations complete.');
  } finally {
    conn.release();
  }
}