import { z } from "zod";

/** Erro com mensagem pronta para o usuário no terminal (sem stack trace). */
export class UserError extends Error {}

const DEMO_DATABASE = "makerswap_rag_demo";
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

const envSchema = z.object({
  DATABASE_URL: z.string().min(1).default(`postgres://rag_demo:rag_demo_local@127.0.0.1:5544/${DEMO_DATABASE}`),
  AI_PROVIDER: z.string().default("gemini"),
  GEMINI_API_KEY: z.string().trim().default(""),
  GENERATION_MODEL: z.string().min(1).default("gemini-3.5-flash-lite"),
  EMBEDDING_MODEL: z.string().min(1).default("gemini-embedding-2"),
  // 128-3072 é a faixa aceita pelos modelos de embedding do Gemini. Validar como inteiro
  // também torna seguro interpolar o valor no DDL, que não aceita parâmetros.
  EMBEDDING_DIMENSIONS: z.coerce.number().int().min(128).max(3072).default(768),
  RELEVANCE_MIN_SIMILARITY: z.coerce.number().min(-1).max(1).default(0.35),
  RETRIEVAL_TOP_K: z.coerce.number().int().min(1).max(50).default(8),
  RETRIEVAL_OUT_OF_STOCK_K: z.coerce.number().int().min(0).max(20).default(3),
  HISTORY_MAX_TURNS: z.coerce.number().int().min(0).max(20).default(6),
  RAG_DEBUG: z.string().default("false"),
});

export type Config = ReturnType<typeof loadConfig>;

export function loadConfig(env: NodeJS.ProcessEnv = readEnvFile()) {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    const fields = parsed.error.issues.map((issue) => issue.path.join(".")).join(", ");
    throw new UserError(`Configuração inválida no .env: ${fields}. Consulte o .env.example.`);
  }
  const values = parsed.data;
  return {
    databaseUrl: assertDemoDatabase(values.DATABASE_URL),
    aiProvider: values.AI_PROVIDER,
    geminiApiKey: values.GEMINI_API_KEY,
    generationModel: values.GENERATION_MODEL,
    embeddingModel: values.EMBEDDING_MODEL,
    embeddingDimensions: values.EMBEDDING_DIMENSIONS,
    minSimilarity: values.RELEVANCE_MIN_SIMILARITY,
    topK: values.RETRIEVAL_TOP_K,
    outOfStockK: values.RETRIEVAL_OUT_OF_STOCK_K,
    historyMaxTurns: values.HISTORY_MAX_TURNS,
    debug: values.RAG_DEBUG.toLowerCase() === "true",
  };
}

/** Falha cedo, com instruções, quando faltam provedor ou credencial. */
export function assertAiConfigured(config: Config): void {
  if (config.aiProvider !== "gemini") {
    throw new UserError(`AI_PROVIDER="${config.aiProvider}" não é suportado. O único provedor implementado é "gemini".`);
  }
  if (!config.geminiApiKey) {
    throw new UserError(
      "GEMINI_API_KEY não configurada. Copie .env.example para .env e informe a chave " +
        "(crie uma em https://aistudio.google.com/apikey).",
    );
  }
}

/** Impede que qualquer comando deste projeto escreva em outro banco por engano. */
function assertDemoDatabase(databaseUrl: string): string {
  let url: URL;
  try {
    url = new URL(databaseUrl);
  } catch {
    throw new UserError("DATABASE_URL inválida. Consulte o .env.example.");
  }
  if (!LOCAL_HOSTS.has(url.hostname) || url.pathname !== `/${DEMO_DATABASE}`) {
    throw new UserError(
      `DATABASE_URL precisa apontar para o banco local "${DEMO_DATABASE}" do Docker Compose desta demonstração ` +
        `(recebido: ${url.hostname}${url.pathname}).`,
    );
  }
  return databaseUrl;
}

function readEnvFile(): NodeJS.ProcessEnv {
  try {
    process.loadEnvFile(".env");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  return process.env;
}
