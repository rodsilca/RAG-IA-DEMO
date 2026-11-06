import { loadConfig } from "../config.js";
import { createPool } from "../db.js";
import { seedDatabase } from "../seed.js";
import { categories, products } from "../seed-data.js";
import { runCli } from "./run.js";

await runCli(async () => {
  const pool = createPool(loadConfig());
  try {
    await seedDatabase(pool);
    console.log(`Seed aplicado: ${categories.length} categorias e ${products.length} produtos (dados fictícios).`);
  } finally {
    await pool.end();
  }
});
