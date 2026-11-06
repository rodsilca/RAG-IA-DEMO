import { createInterface } from "node:readline";
import { assertAiConfigured, loadConfig, UserError } from "../config.js";
import { assertEmbeddingColumn, createPool, getCatalogStatus } from "../db.js";
import { createGeminiClient } from "../gemini.js";
import { findProductsToIndex } from "../indexer.js";
import { answerTurn, createSession } from "../rag.js";
import { renderTurn } from "../render.js";
import { describeError, runCli } from "./run.js";

const EXIT_WORDS = new Set(["sair", "exit"]);

function printDebug(title: string, data: unknown): void {
  const body = typeof data === "string" ? data : JSON.stringify(data, null, 2);
  console.log(`\n[debug] ${title}\n${body}`);
}

await runCli(async () => {
  const config = loadConfig();
  assertAiConfigured(config);
  const debugEnabled = config.debug || process.argv.includes("--debug");
  const pool = createPool(config);

  try {
    await assertEmbeddingColumn(pool, config.embeddingDimensions);
    const status = await getCatalogStatus(pool, config.embeddingModel);
    if (status.available > 0 && status.availableIndexed === 0) {
      throw new UserError(`Nenhum produto foi indexado com o modelo ${config.embeddingModel}. Rode: npm run index`);
    }
    if (status.available === 0) {
      console.log("Aviso: nenhum produto disponível no banco. Para cadastrar ou restaurar os dados: npm run seed");
    }
    const { pending } = await findProductsToIndex(pool, config.embeddingModel);
    if (pending.length > 0) {
      console.log(`Aviso: ${pending.length} produto(s) sem indexação atualizada. Para atualizar: npm run index`);
    }

    console.log(`Assistente MakerSwap (dados fictícios). Digite "sair" ou "exit" para encerrar.${debugEnabled ? " Depuração ligada." : ""}`);
    const deps = {
      db: pool,
      ai: createGeminiClient(config),
      config,
      ...(debugEnabled ? { debug: printDebug } : {}),
    };
    const session = createSession();

    const terminal = createInterface({ input: process.stdin, output: process.stdout, prompt: "\nVocê: " });
    // A entrada pode terminar durante uma resposta (Ctrl+D ou pipe); as linhas já lidas continuam na fila.
    let inputClosed = false;
    terminal.once("close", () => {
      inputClosed = true;
    });
    terminal.prompt();
    for await (const line of terminal) {
      const question = line.trim();
      if (EXIT_WORDS.has(question.toLowerCase())) break;
      if (question) {
        try {
          console.log(`\nAssistente: ${renderTurn(await answerTurn(deps, session, question))}`);
        } catch (error) {
          // Um erro em uma pergunta não encerra a conversa nem entra no histórico.
          console.error(`\nErro: ${describeError(error)}`);
        }
      }
      if (!inputClosed) terminal.prompt();
    }
    terminal.close();
    console.log("\nAté mais!");
  } finally {
    await pool.end();
  }
});
