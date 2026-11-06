import type { Product } from "./db.js";
import type { TurnResult } from "./rag.js";

const BRL = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" });

export function formatBRL(cents: number): string {
  return BRL.format(cents / 100).replace(/\s/u, " ");
}

function availability(product: Product): string {
  if (product.stockQuantity === 0) return "Sem estoque";
  const unit = product.stockQuantity === 1 ? "unidade" : "unidades";
  return `Em estoque (${product.stockQuantity} ${unit})`;
}

function summarize(description: string, maxLength = 160): string {
  const firstSentence = description.match(/^.+?[.!?](?=\s|$)/)?.[0] ?? description;
  return firstSentence.length <= maxLength ? firstSentence : `${firstSentence.slice(0, maxLength - 1).trimEnd()}…`;
}

function specLines(product: Product, keys: string[]): string[] {
  return keys.map((key) => `     - ${key}: ${String(product.specs[key])}`);
}

function comparisonLines(products: Product[]): string[] {
  const rows: [string, (product: Product) => string][] = [
    ["Preço", (product) => formatBRL(product.priceCents)],
    ["Disponibilidade", availability],
  ];
  for (const key of new Set(products.flatMap((product) => Object.keys(product.specs)))) {
    rows.push([key, (product) => (Object.hasOwn(product.specs, key) ? String(product.specs[key]) : "não informado")]);
  }

  const lines = ["", "Comparação (dados atuais do cadastro):"];
  const shared: string[] = [];
  for (const [label, read] of rows) {
    const values = products.map(read);
    if (new Set(values).size === 1) {
      shared.push(`${label}: ${values[0]}`);
      continue;
    }
    lines.push(`  ${label}`);
    products.forEach((product, position) => lines.push(`    - ${product.name}: ${values[position]}`));
  }
  if (shared.length > 0) lines.push("  Iguais entre as opções", ...shared.map((item) => `    - ${item}`));
  return lines;
}

/** Nome, preço, estoque, descrição e especificações vêm do banco; do modelo, só o texto do motivo. */
export function renderTurn(turn: TurnResult): string {
  const lines = [turn.message];

  turn.recommendations.forEach(({ product, reason, relevantSpecs }, position) => {
    lines.push(
      "",
      `${position + 1}. ${product.name}`,
      `   Preço: ${formatBRL(product.priceCents)}`,
      `   Disponibilidade: ${availability(product)}`,
      `   Descrição: ${summarize(product.description)}`,
      "   Especificações relevantes:",
      ...specLines(product, relevantSpecs),
      `   Motivo: ${reason}`,
    );
  });

  if (turn.outOfStock.length > 0) {
    lines.push("", "Relevante, mas indisponível (não é uma recomendação de compra agora):");
    for (const { product, reason } of turn.outOfStock) {
      lines.push(`  - ${product.name} | ${formatBRL(product.priceCents)} | ${availability(product)}`);
      if (reason) lines.push(`    ${reason}`);
    }
  }

  if (turn.comparison.length > 0) lines.push(...comparisonLines(turn.comparison));
  if (turn.appliedFilters.length > 0) lines.push("", `Filtros aplicados: ${turn.appliedFilters.join("; ")}.`);
  for (const notice of turn.notices) lines.push(`Aviso: ${notice}`);
  return lines.join("\n");
}
