import { loadConfig } from "../config.js";
import { applySchema, assertEmbeddingColumn, createPool } from "../db.js";
import { runCli } from "./run.js";

await runCli(async () => {
  const config = loadConfig();
  const pool = createPool(config);
  try {
    await applySchema(pool, config.embeddingDimensions);
    await assertEmbeddingColumn(pool, config.embeddingDimensions);
    console.log(`Schema pronto (embedding com ${config.embeddingDimensions} dimensões).`);
  } finally {
    await pool.end();
  }
});
