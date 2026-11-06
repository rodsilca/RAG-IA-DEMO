import { loadConfig } from "../config.js";
import { createPool } from "../db.js";
import { runCli } from "./run.js";

// Prepara o cenário "banco sem produtos disponíveis" no chat. Para restaurar: npm run seed
await runCli(async () => {
  const pool = createPool(loadConfig());
  try {
    const { rowCount } = await pool.query("UPDATE products SET stock_quantity = 0, updated_at = now()");
    console.log(`Estoque zerado em ${rowCount} produtos do banco da demonstração. Para restaurar: npm run seed`);
  } finally {
    await pool.end();
  }
});
