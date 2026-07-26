import type { OpenRouterModelInfo } from "./llm";

/**
 * Coût approximatif d'un appel auxiliaire, en USD.
 *
 * Ces appels sont petits et très stables: un peu de contexte en entrée, un mot en
 * sortie. Ces ordres de grandeur suffisent à comparer des modèles entre eux.
 */
const AUX_PROMPT_TOKENS = 700;
const AUX_COMPLETION_TOKENS = 5;

/** Un mot à produire: au-delà, le modèle choisi est inadapté à la tâche. */
export const AUX_TIMEOUT_MS = 20_000;

function auxCost(model: OpenRouterModelInfo): number | null {
  const prompt = Number(model.pricing.prompt);
  const completion = Number(model.pricing.completion);
  if (!Number.isFinite(prompt) || !Number.isFinite(completion)) return null;
  if (prompt < 0 || completion < 0) return null;

  return prompt * AUX_PROMPT_TOKENS + completion * AUX_COMPLETION_TOKENS;
}

/**
 * Choisit le modèle des appels auxiliaires: classification de la mission et routage
 * des skills. Deux tâches dont la réponse tient en un mot.
 *
 * Prendre pour ça le modèle le mieux classé — l'ancien comportement — payait un prix
 * de pointe pour une classification triviale: mesuré, ~500x le prix du modèle le
 * moins cher du compte.
 *
 * On prend donc le moins cher, et pas le « meilleur petit modèle »: mesuré sur les
 * quatre skills livrés, les modèles à quelques centimes du million de tokens
 * classent correctement, sans corrélation utile avec `intelligence_index` à cette
 * échelle (le moins cher, index 14,1, fait 6/6 là où un index 5,5 se trompe).
 *
 * Deux exclusions:
 * - ces appels passent par `callTextModel`, sans outils: le vivier n'a donc pas
 *   besoin de `tools`, ce qui laisse accès à des modèles bien moins chers que ceux
 *   que le routeur retient pour la boucle;
 * - les variantes `:free` sont écartées malgré un coût nul, parce que leurs quotas
 *   les rendent imprévisibles. À 7e-6 USD l'appel, l'économie ne vaut pas le risque.
 *   Pour en forcer une: `HARNESS_CHEAP_MODEL`.
 */
export function pickCheapModel(
  models: OpenRouterModelInfo[],
  fallbackCandidates: string[] = [],
): string | null {
  const override = Bun.env.HARNESS_CHEAP_MODEL;
  if (override) return override;

  const priced = models
    .filter((model) => !model.id.endsWith(":free"))
    .map((model) => ({ id: model.id, cost: auxCost(model) }))
    .filter((entry): entry is { id: string; cost: number } => entry.cost !== null)
    .filter((entry) => entry.cost > 0)
    .sort((a, b) => a.cost - b.cost || a.id.localeCompare(b.id));

  return priced[0]?.id ?? fallbackCandidates[0] ?? null;
}
