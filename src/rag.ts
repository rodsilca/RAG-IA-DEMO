import { z } from "zod";
import { UserError, type Config } from "./config.js";
import {
  getActiveProductsByIds,
  getCatalogStatus,
  listCategories,
  searchProducts,
  type Db,
  type Product,
  type ScoredProduct,
  type SearchFilters,
} from "./db.js";
import type { AiClient } from "./gemini.js";
import {
  ANALYSIS_SYSTEM,
  ANSWER_SYSTEM,
  analysisResponseSchema,
  answerResponseSchema,
  buildAnalysisPrompt,
  buildAnswerPrompt,
  type HistoryEntry,
} from "./prompts.js";
import { formatBRL } from "./render.js";

export const NO_MATCH_TEXT = "Não encontrei uma opção adequada entre os produtos consultados.";
const NO_STOCK_TEXT = "No momento, não há produtos disponíveis no catálogo, então não tenho o que recomendar.";
const WIFI_CLARIFICATION =
  "Você procura uma placa para projetos eletrônicos (como ESP32 ou ESP8266) ou um adaptador Wi-Fi para conectar um PC à rede?";
const OFF_TOPIC_TEXT = "Posso ajudar a encontrar peças e componentes do catálogo do MakerSwap. O que você está procurando?";
const NEUTRAL_INTRO = "Estas são as opções do catálogo que atendem ao pedido:";
const NEUTRAL_REASON = "Atende ao pedido de acordo com as especificações cadastradas listadas aqui.";
const MAX_RECOMMENDATIONS = 3;
const MAX_PRICE_BRL = 1_000_000;

const analysisSchema = z.object({
  intent: z.enum(["product_search", "product_question", "compare", "clarify", "off_topic"]),
  searchQuery: z.string(),
  maxPriceBRL: z.number().nullish(),
  minPriceBRL: z.number().nullish(),
  cheaperThanPrevious: z.boolean().nullish(),
  category: z.string().nullish(),
  referencedProductIds: z.array(z.string()).nullish(),
  clarificationQuestion: z.string().nullish(),
});

const answerSchema = z.object({
  outcome: z.enum(["recommend", "no_match", "answer"]),
  message: z.string(),
  recommendations: z.array(
    z.object({ productId: z.string(), reason: z.string(), relevantSpecs: z.array(z.string()) }),
  ),
  outOfStock: z.array(z.object({ productId: z.string(), reason: z.string() })),
});

export type ModelAnswer = z.infer<typeof answerSchema>;

export interface Recommendation {
  product: Product;
  reason: string;
  relevantSpecs: string[];
}

export interface TurnResult {
  kind: "recommendation" | "answer" | "out_of_stock" | "comparison" | "clarify" | "no_match" | "no_stock" | "off_topic";
  message: string;
  recommendations: Recommendation[];
  outOfStock: { product: Product; reason: string }[];
  comparison: Product[];
  appliedFilters: string[];
  notices: string[];
}

export interface Session {
  history: HistoryEntry[];
  /** Produtos da última resposta que mostrou produtos; base de "mais barata". */
  lastShownIds: string[];
  /** Produtos mostrados recentemente; base de "essas duas". */
  recentIds: string[];
}

export function createSession(): Session {
  return { history: [], lastShownIds: [], recentIds: [] };
}

export interface RagDeps {
  db: Db;
  ai: AiClient;
  config: Pick<Config, "embeddingModel" | "minSimilarity" | "topK" | "outOfStockK" | "historyMaxTurns">;
  debug?: (title: string, data: unknown) => void;
}

function result(kind: TurnResult["kind"], message: string, extra: Partial<TurnResult> = {}): TurnResult {
  return { kind, message, recommendations: [], outOfStock: [], comparison: [], appliedFilters: [], notices: [], ...extra };
}

/** Responde a um turno e só registra no histórico o que foi concluído sem erro. */
export async function answerTurn(deps: RagDeps, session: Session, question: string): Promise<TurnResult> {
  const turn = await resolveTurn(deps, session, question);
  rememberTurn(session, question, turn, deps.config.historyMaxTurns);
  return turn;
}

async function resolveTurn(deps: RagDeps, session: Session, question: string): Promise<TurnResult> {
  const { db, ai, config, debug } = deps;

  const status = await getCatalogStatus(db, config.embeddingModel);
  if (status.available === 0) return result("no_stock", NO_STOCK_TEXT);
  if (status.availableIndexed === 0) {
    throw new UserError(`Nenhum produto foi indexado com o modelo ${config.embeddingModel}. Rode: npm run index`);
  }

  const earlierQuestions = session.history.filter((entry) => entry.role === "usuario").map((entry) => entry.text);
  if (needsWifiBoardClarification(question, earlierQuestions)) {
    debug?.("Esclarecimento", "A regra determinística de 'placa Wi-Fi' sem contexto de uso foi acionada.");
    return result("clarify", WIFI_CLARIFICATION);
  }

  const categories = await listCategories(db);
  const recentProducts = await getActiveProductsByIds(db, session.recentIds);
  const analysis = analysisSchema.safeParse(
    await ai.generateJson({
      system: ANALYSIS_SYSTEM,
      prompt: buildAnalysisPrompt({ question, history: session.history, categories, recentProducts }),
      schema: analysisResponseSchema,
    }),
  );
  if (!analysis.success) {
    throw new UserError("A IA não interpretou a pergunta em um formato válido. Nenhum produto foi recomendado; tente novamente.");
  }
  debug?.("Análise da pergunta (saída do modelo, ainda não validada)", analysis.data);

  switch (analysis.data.intent) {
    case "off_topic":
      return result("off_topic", OFF_TOPIC_TEXT);
    case "clarify":
      return result("clarify", analysis.data.clarificationQuestion?.trim() || "Pode dar mais detalhes sobre o que você precisa?");
    case "compare":
      return compareProducts(deps, session, question, analysis.data);
    default:
      return searchAndAnswer(deps, session, question, analysis.data, categories);
  }
}

async function searchAndAnswer(
  deps: RagDeps,
  session: Session,
  question: string,
  analysis: z.infer<typeof analysisSchema>,
  categories: { id: string; name: string }[],
): Promise<TurnResult> {
  const { db, ai, config, debug } = deps;

  const { filters, rejected } = validateFilters(analysis, categories.map((category) => category.id));
  if (analysis.cheaperThanPrevious) {
    const shown = await getActiveProductsByIds(db, session.lastShownIds);
    if (shown.length === 0) {
      return result("clarify", "Mais barata em relação a qual produto? Ainda não mostrei nenhum nesta conversa.");
    }
    filters.belowPriceCents = Math.min(...shown.map((product) => product.priceCents));
  }
  const appliedFilters = describeFilters(filters, categories);
  const notices = rejected.map((reason) => `Ignorei um filtro inválido: ${reason}.`);
  debug?.("Filtros aplicados (validados, enviados como parâmetros SQL)", {
    disponibilidade: "ativos; com e sem estoque buscados em separado",
    ...filters,
    rejeitados: rejected,
  });

  const query = analysis.searchQuery.trim() || question;
  const embedding = await ai.embedQuery(query);
  const search = { embedding, embeddingModel: config.embeddingModel, filters };
  const retrievedAvailable = await searchProducts(db, { ...search, inStock: true, limit: config.topK });
  const retrievedUnavailable =
    config.outOfStockK > 0 ? await searchProducts(db, { ...search, inStock: false, limit: config.outOfStockK }) : [];
  debug?.(`Produtos recuperados para "${query}"`, describeRetrieved(retrievedAvailable, retrievedUnavailable, config.minSimilarity));

  // Critério de relevância, etapa 1: piso de similaridade. Abaixo dele o modelo nem é consultado.
  const available = retrievedAvailable.filter((product) => product.similarity >= config.minSimilarity);
  const unavailable = retrievedUnavailable.filter((product) => product.similarity >= config.minSimilarity);
  if (available.length === 0 && unavailable.length === 0) {
    return result("no_match", NO_MATCH_TEXT, { appliedFilters, notices });
  }

  // Etapa 2: o modelo só vê os candidatos e precisa apontar a evidência cadastrada.
  const prompt = buildAnswerPrompt({
    question,
    resolvedNeed: query,
    appliedFilters,
    history: session.history,
    products: [...available, ...unavailable],
    formatPrice: formatBRL,
  });
  debug?.("Contexto enviado ao modelo", prompt);
  const answer = answerSchema.safeParse(
    await ai.generateJson({ system: ANSWER_SYSTEM, prompt, schema: answerResponseSchema }),
  );
  if (!answer.success) {
    throw new UserError("A IA não respondeu em um formato válido. Nenhum produto foi recomendado; tente novamente.");
  }
  debug?.("Resposta do modelo (antes da verificação)", answer.data);

  // Etapa 3: o código confere a evidência e descarta o que não se sustenta.
  const allowedPrices = [...available, ...unavailable].map((product) => product.priceCents);
  for (const limit of [filters.maxPriceCents, filters.belowPriceCents, filters.minPriceCents]) {
    if (limit !== undefined) allowedPrices.push(limit);
  }
  const verified = enforceAnswer(answer.data, available, unavailable, allowedPrices);
  if (verified.discarded.length > 0) debug?.("Descartado na verificação", verified.discarded);
  return { ...verified.turn, appliedFilters, notices };
}

async function compareProducts(
  deps: RagDeps,
  session: Session,
  question: string,
  analysis: z.infer<typeof analysisSchema>,
): Promise<TurnResult> {
  const { db, ai, debug } = deps;
  const referenced = (analysis.referencedProductIds ?? []).filter((id) => session.recentIds.includes(id));
  const ids = referenced.length >= 2 ? referenced : session.recentIds.slice(0, 2);
  const products = await getActiveProductsByIds(db, [...new Set(ids)]);
  if (products.length < 2) {
    return result("clarify", "Ainda não tenho dois produtos para comparar nesta conversa. Quais você quer comparar?");
  }

  const prompt = buildAnswerPrompt({
    question,
    resolvedNeed: analysis.searchQuery,
    appliedFilters: [],
    history: session.history,
    products,
    formatPrice: formatBRL,
    task: 'Use outcome "answer". Em message, explique as diferenças práticas entre estes produtos usando apenas os dados cadastrados. A tabela comparativa é exibida pelo sistema.',
  });
  debug?.("Contexto enviado ao modelo", prompt);
  const answer = answerSchema.safeParse(
    await ai.generateJson({ system: ANSWER_SYSTEM, prompt, schema: answerResponseSchema }),
  );
  const message = answer.success ? answer.data.message.trim() : "";
  const prices = products.map((product) => product.priceCents);
  const safeMessage = message && !hasUnverifiedPrice(message, prices) ? message : "Comparação com os dados cadastrados:";
  return result("comparison", safeMessage, { comparison: products });
}

/**
 * Última barreira entre o modelo e o terminal, escrita para valer mesmo se o modelo errar ou
 * obedecer a um texto malicioso em um anúncio: só passam IDs candidatos, com estoque e com ao
 * menos uma especificação citada que exista de fato. Preços citados fora dos dados são removidos.
 */
export function enforceAnswer(
  answer: ModelAnswer,
  available: Product[],
  unavailable: Product[],
  allowedPrices: number[],
): { turn: TurnResult; discarded: string[] } {
  const discarded: string[] = [];
  const recommendations: Recommendation[] = [];
  const seen = new Set<string>();

  if (answer.outcome === "no_match" && answer.recommendations.length > 0) {
    discarded.push("recomendações ignoradas: o modelo também declarou no_match");
  } else {
    for (const item of answer.recommendations) {
      const product = available.find((candidate) => candidate.id === item.productId);
      if (!product || seen.has(product.id)) {
        discarded.push(`${item.productId}: não é um candidato disponível`);
        continue;
      }
      const relevantSpecs = [...new Set(item.relevantSpecs)].filter((key) => Object.hasOwn(product.specs, key));
      if (relevantSpecs.length === 0) {
        discarded.push(`${item.productId}: nenhuma especificação citada existe no cadastro`);
        continue;
      }
      if (recommendations.length === MAX_RECOMMENDATIONS) {
        discarded.push(`${item.productId}: acima do limite de ${MAX_RECOMMENDATIONS} recomendações`);
        continue;
      }
      seen.add(product.id);
      const reason = item.reason.trim();
      recommendations.push({
        product,
        relevantSpecs,
        reason: reason && !hasUnverifiedPrice(reason, allowedPrices) ? reason : NEUTRAL_REASON,
      });
    }
  }

  const outOfStock = answer.outOfStock.flatMap((item) => {
    const product = unavailable.find((candidate) => candidate.id === item.productId);
    if (!product) {
      discarded.push(`${item.productId}: citado como sem estoque, mas não é um candidato sem estoque`);
      return [];
    }
    return [{ product, reason: hasUnverifiedPrice(item.reason, allowedPrices) ? "" : item.reason.trim() }];
  });

  const message = answer.message.trim();
  // Se algo foi descartado, a mensagem pode citar o item removido e não é mais confiável.
  const messageIsSafe = message !== "" && discarded.length === 0 && !hasUnverifiedPrice(message, allowedPrices);

  if (recommendations.length > 0) {
    const kind = answer.outcome === "answer" ? "answer" : "recommendation";
    return { turn: result(kind, messageIsSafe ? message : NEUTRAL_INTRO, { recommendations, outOfStock }), discarded };
  }
  if (outOfStock.length > 0) {
    const text =
      answer.outcome === "answer" && messageIsSafe
        ? message
        : "Encontrei produto relevante, mas sem estoque no momento. Não há opção disponível para recomendar.";
    return { turn: result("out_of_stock", text, { outOfStock }), discarded };
  }
  if (answer.outcome === "answer" && messageIsSafe) return { turn: result("answer", message), discarded };

  const explanation = answer.outcome === "no_match" && messageIsSafe ? ` ${message}` : "";
  return { turn: result("no_match", `${NO_MATCH_TEXT}${explanation}`), discarded };
}

/** Valida os filtros propostos pelo modelo. O que for inválido é descartado e informado ao usuário. */
export function validateFilters(
  raw: { maxPriceBRL?: number | null; minPriceBRL?: number | null; category?: string | null },
  categoryIds: string[],
): { filters: SearchFilters; rejected: string[] } {
  const filters: SearchFilters = {};
  const rejected: string[] = [];

  const toCents = (value: number | null | undefined, label: string): number | undefined => {
    if (value === null || value === undefined) return undefined;
    if (!Number.isFinite(value) || value <= 0 || value > MAX_PRICE_BRL) {
      rejected.push(`${label} fora da faixa aceita (${value})`);
      return undefined;
    }
    return Math.round(value * 100);
  };

  const maxPriceCents = toCents(raw.maxPriceBRL, "preço máximo");
  const minPriceCents = toCents(raw.minPriceBRL, "preço mínimo");
  if (maxPriceCents !== undefined && minPriceCents !== undefined && minPriceCents > maxPriceCents) {
    rejected.push("preço mínimo maior que o preço máximo");
  } else {
    if (maxPriceCents !== undefined) filters.maxPriceCents = maxPriceCents;
    if (minPriceCents !== undefined) filters.minPriceCents = minPriceCents;
  }

  if (raw.category) {
    if (categoryIds.includes(raw.category)) filters.categoryId = raw.category;
    else rejected.push(`categoria desconhecida (${raw.category})`);
  }
  return { filters, rejected };
}

function describeFilters(filters: SearchFilters, categories: { id: string; name: string }[]): string[] {
  const applied: string[] = [];
  if (filters.maxPriceCents !== undefined) applied.push(`preço até ${formatBRL(filters.maxPriceCents)}`);
  if (filters.belowPriceCents !== undefined) applied.push(`preço abaixo de ${formatBRL(filters.belowPriceCents)}`);
  if (filters.minPriceCents !== undefined) applied.push(`preço a partir de ${formatBRL(filters.minPriceCents)}`);
  const category = categories.find((candidate) => candidate.id === filters.categoryId);
  if (category) applied.push(`categoria ${category.name}`);
  return applied;
}

function describeRetrieved(available: ScoredProduct[], unavailable: ScoredProduct[], minSimilarity: number) {
  return {
    observacao: "similaridade de cosseno; serve para ordenar e cortar, não é probabilidade de acerto",
    piso: minSimilarity,
    produtos: [...available, ...unavailable].map((product) => ({
      id: product.id,
      similaridade: Number(product.similarity.toFixed(4)),
      passouNoPiso: product.similarity >= minSimilarity,
      preco: formatBRL(product.priceCents),
      estoque: product.stockQuantity,
    })),
  };
}

function normalize(text: string): string {
  return text.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
}

const WIFI_BOARD = /\bplacas?\b.*\b(wi[\s-]?fi|wireless)\b|\b(wi[\s-]?fi|wireless)\b.*\bplacas?\b/;
const USAGE_CONTEXT =
  /\b(projeto|automac|iot\b|arduino|esp[\s-]?\d|nodemcu|microcontrol|embarcad|sensor|rele\b|robo|maker|eletronic|prototip|protoboard|residencial|casa inteligente|pc\b|computador|notebook|laptop|desktop|adaptador|rede\b|usb)/;

/** "Placa Wi-Fi" sem contexto de uso, nem nesta mensagem nem nas anteriores, é ambígua. */
export function needsWifiBoardClarification(question: string, earlierQuestions: string[]): boolean {
  const current = normalize(question);
  if (!WIFI_BOARD.test(current)) return false;
  return ![current, ...earlierQuestions.map(normalize)].some((text) => USAGE_CONTEXT.test(text));
}

/** Verdadeiro se o texto citar um valor em reais que não esteja entre os permitidos. */
export function hasUnverifiedPrice(text: string, allowedCents: number[]): boolean {
  for (const match of text.matchAll(/R\$\s*(\d[\d.]*(?:,\d{1,2})?)/g)) {
    const cents = Math.round(Number(match[1]!.replaceAll(".", "").replace(",", ".")) * 100);
    if (!allowedCents.includes(cents)) return true;
  }
  return false;
}

function rememberTurn(session: Session, question: string, turn: TurnResult, maxTurns: number): void {
  const shown = [
    ...turn.recommendations.map((item) => item.product),
    ...turn.outOfStock.map((item) => item.product),
    ...turn.comparison,
  ];
  // Um item sem estoque não serve de referência para "mais barata", mas pode ser comparado.
  const purchasable = [...turn.recommendations.map((item) => item.product), ...turn.comparison];
  if (purchasable.length > 0) session.lastShownIds = purchasable.map((product) => product.id);
  session.recentIds = [...new Set([...shown.map((product) => product.id), ...session.recentIds])].slice(0, 6);
  // Só nomes: preço e estoque antigos no histórico poderiam contradizer o banco.
  const names = shown.map((product) => product.name).join("; ");
  session.history.push(
    { role: "usuario", text: question },
    { role: "assistente", text: names ? `${turn.message} Produtos mostrados: ${names}.` : turn.message },
  );
  session.history = maxTurns > 0 ? session.history.slice(-maxTurns * 2) : [];
}
