// The `models` command's output: one line per model with its context window and rates.

import type { CatalogueModel } from "./api/types.js";

/** A table of the models, in the order Twigg lists them, with how to use one. */
export function formatModels(models: CatalogueModel[]): string {
  if (!models.length) return "Your API key has no models available. Check your Twigg dashboard.\n";
  const currencies = new Set(models.map((m) => m.rates.currency));
  const currency = currencies.size === 1 ? `${[...currencies][0]} ` : "";
  const rows = [
    ["MODEL", "PROVIDER", "CONTEXT", "INPUT", "OUTPUT"],
    ...models.map((m) => [
      m.name,
      m.provider_label,
      tokens(m.context_window),
      price(m.rates.input, currency ? "" : m.rates.currency),
      price(m.rates.output, currency ? "" : m.rates.currency),
    ]),
  ];
  const widths = rows[0]?.map((_, i) => Math.max(...rows.map((r) => (r[i] ?? "").length))) ?? [];
  // Text columns line up on the left, numbers on the right.
  const line = (r: string[]) =>
    r
      .map((cell, i) => (i < 2 ? cell.padEnd(widths[i] ?? 0) : cell.padStart(widths[i] ?? 0)))
      .join("  ")
      .trimEnd();
  return [
    `Models your API key can use. Input and output prices are ${currency}per million tokens.`,
    "",
    ...rows.map(line),
    "",
    'Pick one with --model <name>, or "model" in frontmatter or a settings file.',
    "",
  ].join("\n");
}

/** 1000000 as "1M", 1050000 as "1.05M", 128000 as "128k". */
function tokens(n: number): string {
  if (n >= 1_000_000) return `${Number((n / 1_000_000).toFixed(2))}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}k`;
  return String(n);
}

/** A rate with enough decimals to tell cheap models apart: 10.50, 0.105, 0.0525. */
function price(rate: string | number, currency: string): string {
  const n = Number(rate);
  if (!Number.isFinite(n)) return "-";
  const text = n.toFixed(n >= 1 ? 2 : n >= 0.1 ? 3 : 4);
  return currency ? `${text} ${currency}` : text;
}
