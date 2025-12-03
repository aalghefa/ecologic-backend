require("dotenv").config();
const pool = require("./db");

async function init() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        email TEXT UNIQUE NOT NULL,
        password_hash TEXT NOT NULL,
        company_name TEXT NOT NULL
      );
    `);

    console.log("Users table created or already exists");
  } catch (err) {
    console.error("Error creating users table:", err);
  } finally {
    await pool.end();
  }
}

init();
