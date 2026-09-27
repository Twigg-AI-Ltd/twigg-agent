import { describe, expect, it } from "vitest";
import type { CatalogueModel } from "../src/api/types.js";
import { formatModels } from "../src/models.js";

const model = (
  name: string,
  provider: string,
  context: number,
  input: string,
  output: string,
  currency = "USD",
) =>
  ({
    name,
    provider_label: provider,
    context_window: context,
    rates: { input, output, currency },
  }) as CatalogueModel;

describe("formatModels", () => {
  it("lists each model with its context window and rates, lined up", () => {
    const text = formatModels([
      model("claude-opus-5-5", "Anthropic", 1_000_000, "4.200000000000", "21.000000000000"),
      model("gpt-6-luna", "OpenAI", 1_050_000, "0.105000000000", "0.525000000000"),
      model("tiny", "Fireworks", 128_000, "0.052500000000", "0.210000000000"),
    ]);
    expect(text).toBe(
      [
        "Models your API key can use. Input and output prices are USD per million tokens.",
        "",
        "MODEL            PROVIDER   CONTEXT   INPUT  OUTPUT",
        "claude-opus-5-5  Anthropic       1M    4.20   21.00",
        "gpt-6-luna       OpenAI       1.05M   0.105   0.525",
        "tiny             Fireworks     128k  0.0525   0.210",
        "",
        'Pick one with --model <name>, or "model" in frontmatter or a settings file.',
        "",
      ].join("\n"),
    );
  });

  it("names the currency on each price when models differ", () => {
    const text = formatModels([
      model("a", "P", 1000, "1", "2", "USD"),
      model("b", "P", 1000, "1", "2", "EUR"),
    ]);
    expect(text).toContain("prices are per million tokens");
    expect(text).toContain("1.00 EUR");
  });

  it("says so when there are no models", () => {
    expect(formatModels([])).toMatch(/no models available/);
  });
});
