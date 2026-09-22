import { AGENTD_BACKED_PROVIDER_KINDS, type ProviderKind } from '../protocol/index.js';
import type { Database } from '../db/driver.js';

/** Dollars per million tokens, as providers publish them. */
export interface ModelPrice {
  providerKind: string;
  model: string;
  inputPerMTokUsd: number;
  outputPerMTokUsd: number;
  source: 'list' | 'custom';
}

/**
 * Public list prices, USD per million tokens, for models whose price was known
 * when this was written. Deliberately short: a wrong price is worse than none,
 * because none shows as "unpriced" and prompts an admin to set it. Anything
 * missing, or negotiated differently, is set in model_prices.
 */
const LIST_PRICES: Record<string, [input: number, output: number]> = {
  'claude-haiku-4-5': [1, 5],
  'claude-sonnet-4-5': [3, 15],
  'claude-sonnet-4': [3, 15],
  'claude-opus-4-1': [15, 75],
  'claude-3-5-haiku': [0.8, 4],
  'gpt-4o': [2.5, 10],
  'gpt-4o-mini': [0.15, 0.6],
  'gpt-4.1': [2, 8],
  'gpt-4.1-mini': [0.4, 1.6],
  'deepseek-chat': [0.27, 1.1],
  'deepseek-reasoner': [0.55, 2.19],
};

const MICROS_PER_USD = 1_000_000;

/** OpenRouter names models `vendor/model`; the list is keyed by the bare model. */
function bareModel(model: string): string {
  const slash = model.lastIndexOf('/');
  return slash === -1 ? model : model.slice(slash + 1);
}

interface PriceRow {
  provider_kind: string;
  model: string;
  input_per_mtok_micros: number;
  output_per_mtok_micros: number;
}

export function findModelPrice(db: Database, kind: ProviderKind | string, model: string): ModelPrice | null {
  const custom = db
    .prepare('SELECT * FROM model_prices WHERE provider_kind = ? AND model = ?')
    .get(kind, model) as PriceRow | undefined;
  if (custom) {
    return {
      providerKind: custom.provider_kind,
      model: custom.model,
      inputPerMTokUsd: custom.input_per_mtok_micros / MICROS_PER_USD,
      outputPerMTokUsd: custom.output_per_mtok_micros / MICROS_PER_USD,
      source: 'custom',
    };
  }
  const list = LIST_PRICES[bareModel(model)];
  return list ? { providerKind: kind, model, inputPerMTokUsd: list[0], outputPerMTokUsd: list[1], source: 'list' } : null;
}

/**
 * Estimated cost of one call in millionths of a dollar.
 *
 * Device-backed providers cost nothing here: a Claude subscription or a local
 * Ollama is paid for elsewhere, and counting it against a budget would stop an
 * agent for money that was never spent through this server.
 */
export function priceCall(
  db: Database,
  kind: ProviderKind,
  model: string,
  usage: { inputTokens: number; outputTokens: number },
): number | null {
  if ((AGENTD_BACKED_PROVIDER_KINDS as readonly string[]).includes(kind)) return 0;
  const price = findModelPrice(db, kind, model);
  if (!price) return null;
  return Math.round(usage.inputTokens * price.inputPerMTokUsd + usage.outputTokens * price.outputPerMTokUsd);
}

export function setModelPrice(
  db: Database,
  input: { providerKind: string; model: string; inputPerMTokUsd: number; outputPerMTokUsd: number },
): ModelPrice {
  db.prepare(
    `INSERT INTO model_prices (provider_kind, model, input_per_mtok_micros, output_per_mtok_micros, updated_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (provider_kind, model) DO UPDATE SET
       input_per_mtok_micros = excluded.input_per_mtok_micros,
       output_per_mtok_micros = excluded.output_per_mtok_micros,
       updated_at = excluded.updated_at`,
  ).run(
    input.providerKind,
    input.model,
    Math.round(input.inputPerMTokUsd * MICROS_PER_USD),
    Math.round(input.outputPerMTokUsd * MICROS_PER_USD),
    new Date().toISOString(),
  );
  return findModelPrice(db, input.providerKind, input.model)!;
}

export function deleteModelPrice(db: Database, providerKind: string, model: string): boolean {
  return db.prepare('DELETE FROM model_prices WHERE provider_kind = ? AND model = ?').run(providerKind, model).changes > 0;
}

export function listModelPrices(db: Database): ModelPrice[] {
  const custom = (db.prepare('SELECT * FROM model_prices ORDER BY provider_kind, model').all() as PriceRow[]).map(
    (row): ModelPrice => ({
      providerKind: row.provider_kind,
      model: row.model,
      inputPerMTokUsd: row.input_per_mtok_micros / MICROS_PER_USD,
      outputPerMTokUsd: row.output_per_mtok_micros / MICROS_PER_USD,
      source: 'custom',
    }),
  );
  const list = Object.entries(LIST_PRICES).map(
    ([model, [input, output]]): ModelPrice => ({ providerKind: '*', model, inputPerMTokUsd: input, outputPerMTokUsd: output, source: 'list' }),
  );
  return [...custom, ...list];
}
