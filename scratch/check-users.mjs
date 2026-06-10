import mysql from 'mysql2/promise';
import dotenv from 'dotenv';
dotenv.config();

const conn = await mysql.createConnection({
  host: process.env.DB_HOST || '127.0.0.1',
  port: Number(process.env.DB_PORT) || 3306,
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || 'admin',
  database: process.env.DB_NAME || 'shopify_admin',
});

const [rows] = await conn.query('SELECT id, username, password, role FROM users LIMIT 10');
console.log('Users in DB:');
console.table(rows);
await conn.end();
