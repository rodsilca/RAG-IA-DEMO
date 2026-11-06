import { assertAiConfigured, loadConfig } from "../config.js";
import { assertEmbeddingColumn, createPool, resetEmbeddings } from "../db.js";
import { createGeminiClient } from "../gemini.js";
import { indexProducts } from "../indexer.js";
import { runCli } from "./run.js";

await runCli(async () => {
  const config = loadConfig();
  assertAiConfigured(config);
  const pool = createPool(config);
  try {
    if (process.argv.includes("--rebuild")) {
      await resetEmbeddings(pool, config.embeddingDimensions);
      console.log(`Vetores descartados; coluna recriada com ${config.embeddingDimensions} dimensões.`);
    }
    await assertEmbeddingColumn(pool, config.embeddingDimensions);

    console.log(`Indexando com ${config.embeddingModel}...`);
    const summary = await indexProducts(pool, createGeminiClient(config), config.embeddingModel, console.log);
    if (summary.total === 0) {
      console.log("Nenhum produto no banco. Rode: npm run seed");
      return;
    }
    console.log(`Concluído: ${summary.indexed} indexados, ${summary.skipped} sem alteração, ${summary.total} no total.`);
  } finally {
    await pool.end();
  }
});
