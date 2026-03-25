// import "dotenv/config";
// import pool from "./db.js";

// async function init() {
//   try {
//     await pool.query(`
//       CREATE TABLE IF NOT EXISTS users (
//         id SERIAL PRIMARY KEY,
//         email TEXT UNIQUE NOT NULL,
//         password_hash TEXT NOT NULL,
//         company_name TEXT NOT NULL
//       );
//     `);

//     console.log("Users table created or already exists");
//   } catch (err) {
//     console.error("Error creating users table:", err);
//   } finally {
//     await pool.end();
//   }
// }

// init();

import pool from "./db.js";
import dotenv from "dotenv";

dotenv.config();

async function init() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        email TEXT UNIQUE NOT NULL,
        password_hash TEXT NOT NULL,
        company_name TEXT NOT NULL,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS menus (
        id SERIAL PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        name TEXT NOT NULL DEFAULT 'Main menu',
        description TEXT,
        is_active BOOLEAN NOT NULL DEFAULT TRUE,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS menu_items (
        id SERIAL PRIMARY KEY,
        menu_id INTEGER NOT NULL REFERENCES menus(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        category TEXT,
        price_cents INTEGER,
        estimated_emissions_kg_co2e NUMERIC(12, 4) DEFAULT 0,
        is_active BOOLEAN NOT NULL DEFAULT TRUE,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS facility_profiles (
        id SERIAL PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        energy_type TEXT,
        electricity_usage TEXT,
        efficient_appliances TEXT[],
        renewables TEXT,
        food_waste_handling TEXT,
        food_waste_percent TEXT,
        recycling TEXT,
        water_tracking TEXT,
        water_efficient TEXT,
        sourcing TEXT,
        delivery_frequency TEXT,
        packaging_type TEXT,
        reusable_program TEXT,
        vehicles TEXT,
        weekly_km TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS ingredient_waste_events (
        id SERIAL PRIMARY KEY,
        user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
        ingredient_id INTEGER,
        purchase_id INTEGER,
        quantity_grams NUMERIC,
        waste_date DATE,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
    `);

    console.log("Base tables created or already exist");
  } catch (err) {
    console.error("Error creating base tables:", err);
  } finally {
    await pool.end();
  }
}

init();