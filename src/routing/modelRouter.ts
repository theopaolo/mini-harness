import type { ModelBenchmarkRow, OpenRouterModelInfo } from "../llm";
import {
  EMPTY_BENCHMARK_INDEX,
  findModelScores,
  loadBenchmarkIndex,
  type BenchmarkIndex,
} from "./benchmarkSource";
import {
  classifyMission,
  type MissionClassification,
} from "./missionClassifier";
import type {
  TaskKind,
  BenchmarkTask,
  BenchmarkRow,
  ToolBenchmarkRow,
  ModelRoute,
  RankedCandidate,
} from "./types";

export type { ModelRoute };

const BENCHMARK_PATH = "model-bench/benchmark.md";
const TOOL_BENCHMARK_PATH = "model-bench/tool-benchmark.json";

export async function routeModels(
  mission: string,
  models: OpenRouterModelInfo[],
  cheapModel: string | null,
): Promise<ModelRoute> {
  // La classification et le chargement des scores sont indépendants: un appel
  // réseau plus une lecture disque, autant les mener ensemble.
  const [classification, benchmarkRows, toolBenchmarkRows, scores] =
    await Promise.all([
      classifyMission(mission, cheapModel),
      readBenchmarkRows(),
      readToolBenchmarkRows(),
      Bun.env.HARNESS_NO_LIVE_BENCHMARKS
        ? Promise.resolve(EMPTY_BENCHMARK_INDEX)
        : loadBenchmarkIndex(),
    ]);

  const taskKind = classification.kind;
  const candidates = rankModels(
    mission,
    taskKind,
    models,
    benchmarkRows,
    toolBenchmarkRows,
    scores,
  );

  const winner = candidates[0];
  if (!winner) {
    throw new Error("Aucun modèle compatible avec la harness n'a été trouvé");
  }

  return {
    modelCandidates: candidates.map((candidate) => candidate.model.id),
    selectedModel: winner.model.id,
    taskKind,
    reason: explainRoute(classification, winner, scores),
  };
}

function rankModels(
  mission: string,
  taskKind: TaskKind,
  models: OpenRouterModelInfo[],
  benchmarkRows: BenchmarkRow[],
  toolBenchmarkRows: ToolBenchmarkRow[],
  scores: BenchmarkIndex,
): RankedCandidate[] {
  const usable = models.filter((model) => supports(model, "tools"));
  const base = usable.length > 0 ? usable : models;
  const benchmarkTask = benchmarkTaskFor(taskKind);

  return base
    .map((model) => {
      const row = findBenchmarkRow(model, benchmarkRows, benchmarkTask);
      const toolRow = findToolBenchmarkRow(model, toolBenchmarkRows);
      const publicScores = findModelScores(scores, model);
      return {
        model,
        row,
        toolRow,
        publicScores,
        score: scoreModel(mission, taskKind, model, row, toolRow, publicScores),
      };
    })
    .sort((a, b) => b.score - a.score);
}

function scoreModel(
  mission: string,
  taskKind: TaskKind,
  model: OpenRouterModelInfo,
  row: BenchmarkRow | undefined,
  toolRow: ToolBenchmarkRow | undefined,
  publicScores: ModelBenchmarkRow | undefined,
): number {
  const text = mission.toLowerCase();
  const quality = qualityFor(taskKind, row, publicScores);
  const latencyMs = row?.latencyMs ?? 3000;
  const costEur = row?.costEur ?? estimatedCostEur(model) ?? 0.001;
  const cheapBonus = costEur === 0 ? 2 : 1 / (1 + costEur * 100_000);
  const fastBonus = 1 / (1 + latencyMs / 1000);

  let score = quality * 10 + cheapBonus * 8 + fastBonus * 6;

  if (supports(model, "tools")) score += 10;
  if (supports(model, "parallel_tool_calls")) score += 2;
  if (supports(model, "reasoning")) score += taskKind === "reasoning" ? 6 : 1;
  score += toolBenchmarkBonus(taskKind, toolRow);
  score += taskAffinityBonus(taskKind, model, text, publicScores);

  if (taskKind === "research") {
    score += supports(model, "parallel_tool_calls") ? 6 : 0;
    score += model.contextLength >= 250_000 ? 3 : 0;
  }

  return score;
}

function toolBenchmarkBonus(
  taskKind: TaskKind,
  toolRow: ToolBenchmarkRow | undefined,
): number {
  if (!toolRow) return taskNeedsTools(taskKind) ? 0 : 2;
  if (toolRow.error) return taskNeedsTools(taskKind) ? -80 : -20;

  const score = toolRow.totalScore;
  const latencyBonus = 16 / (1 + toolRow.avgLatencyMs / 1000);
  const belowMinimumPenalty = score < 0.55 ? -35 : 0;

  switch (taskKind) {
    case "tool":
      return score * 70 + latencyBonus + belowMinimumPenalty;
    case "research":
      return (
        score * 45 +
        toolRow.parallelToolCallRate * 10 +
        latencyBonus * 0.4 +
        belowMinimumPenalty
      );
    case "code":
      return (
        score * 25 + toolRow.noToolDisciplineRate * 8 + latencyBonus * 0.25
      );
    case "reasoning":
      return score * 12 + toolRow.noToolDisciplineRate * 10;
    case "summary":
    case "general":
      return toolRow.noToolDisciplineRate * 12 + score * 5;
  }
}

async function readBenchmarkRows(): Promise<BenchmarkRow[]> {
  const file = Bun.file(BENCHMARK_PATH);
  if (!(await file.exists())) return [];
  return parseBenchmarkMarkdown(await file.text());
}

/** Séparé de la lecture disque pour rester testable. */
export function parseBenchmarkMarkdown(markdown: string): BenchmarkRow[] {
  const rows: BenchmarkRow[] = [];
  let currentTask: BenchmarkTask | null = null;

  for (const line of markdown.split("\n")) {
    const taskMatch = line.match(/^## Tâche : (.+)$/);
    if (taskMatch) {
      currentTask = isBenchmarkTask(taskMatch[1]) ? taskMatch[1] : null;
      continue;
    }

    if (!currentTask || !line.startsWith("| ")) continue;
    if (line.includes("Modèle") || line.includes("---")) continue;

    const cells = line
      .split("|")
      .map((cell) => cell.trim())
      .filter(Boolean);
    if (cells.length < 6) continue;
    const [label, latencyCell, , , costCell, scoreCell] = cells;
    if (!label || !latencyCell || !costCell || !scoreCell) continue;

    // Une cellule illisible donnerait NaN, qui contaminerait le score et rendrait
    // le tri (b.score - a.score) arbitraire. On préfère ignorer la ligne: le
    // modèle retombe alors sur les valeurs par défaut de scoreModel.
    const latencyMs = parseNumber(latencyCell.replace("ms", ""));
    const costEur = parseNumber(costCell.replace("€", ""));
    if (latencyMs === null || costEur === null) continue;

    rows.push({
      task: currentTask,
      label,
      latencyMs,
      costEur,
      qualityScore: countStars(scoreCell),
    });
  }

  return rows;
}

async function readToolBenchmarkRows(): Promise<ToolBenchmarkRow[]> {
  const file = Bun.file(TOOL_BENCHMARK_PATH);
  if (!(await file.exists())) return [];

  try {
    const data = (await file.json()) as { rows?: ToolBenchmarkRow[] };
    return Array.isArray(data.rows) ? data.rows : [];
  } catch {
    return [];
  }
}

function benchmarkTaskFor(taskKind: TaskKind): BenchmarkTask {
  switch (taskKind) {
    case "code":
    case "tool":
      return "Génération de code";
    case "reasoning":
      return "Raisonnement logique";
    case "research":
    case "summary":
    case "general":
      return "Résumé de texte";
  }
}

function findBenchmarkRow(
  model: OpenRouterModelInfo,
  rows: BenchmarkRow[],
  task: BenchmarkTask,
): BenchmarkRow | undefined {
  const label = modelLabel(model.id);
  return rows.find((row) => row.task === task && row.label === label);
}

function findToolBenchmarkRow(
  model: OpenRouterModelInfo,
  rows: ToolBenchmarkRow[],
): ToolBenchmarkRow | undefined {
  return rows.find((row) => row.model === model.id);
}

function explainRoute(
  classification: MissionClassification,
  winner: RankedCandidate,
  scores: BenchmarkIndex,
): string {
  const taskKind = classification.kind;
  const how = [
    `classée par ${classification.source}`,
    classification.note,
  ]
    .filter(Boolean)
    .join(", ");
  const caps = [
    supports(winner.model, "tools") ? "tools" : null,
    supports(winner.model, "reasoning") ? "reasoning" : null,
    supports(winner.model, "parallel_tool_calls") ? "parallel tools" : null,
  ].filter(Boolean);
  const bench = winner.row
    ? `${winner.row.qualityScore}/5, ${winner.row.latencyMs}ms, €${winner.row.costEur}`
    : "pas de ligne benchmark";
  const toolBench = winner.toolRow
    ? `tool ${Math.round(winner.toolRow.totalScore * 100)}%`
    : "pas de tool-benchmark";

  return `${taskKind} (${how}): ${modelLabel(winner.model.id)} (${caps.join(", ") || "capacités limitées"}; benchmark ${bench}; ${toolBench}; ${explainScores(taskKind, winner, scores)})`;
}

function explainScores(
  taskKind: TaskKind,
  winner: RankedCandidate,
  scores: BenchmarkIndex,
): string {
  if (scores.origin === "absent") {
    return scores.note ?? "scores publics absents";
  }

  const freshness = [
    `scores ${scores.origin}`,
    scores.asOf ? `au ${scores.asOf.slice(0, 10)}` : null,
    scores.note,
  ]
    .filter(Boolean)
    .join(" ");

  if (!winner.publicScores) return `${freshness}, modèle non classé`;

  const index = primaryIndex(taskKind, winner.publicScores);
  const label = indexLabelFor(taskKind);
  return index === null
    ? `${freshness}, pas d'index ${label}`
    : `${freshness}, ${label} ${index}/100`;
}

function indexLabelFor(taskKind: TaskKind): string {
  switch (taskKind) {
    case "code":
      return "coding";
    case "tool":
    case "research":
      return "agentic";
    case "reasoning":
    case "summary":
    case "general":
      return "intelligence";
  }
}

function parseNumber(cell: string): number | null {
  const raw = cell.trim();
  if (raw === "") return null;
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

function countStars(cell: string): number {
  return [...cell].filter((char) => char === "★").length;
}

function supports(model: OpenRouterModelInfo, parameter: string): boolean {
  return model.supportedParameters.includes(parameter);
}

function taskNeedsTools(taskKind: TaskKind): boolean {
  return taskKind === "tool" || taskKind === "research";
}

function modelLabel(modelId: string): string {
  return modelId.split("/").at(-1)?.replace(/^~/, "") ?? modelId;
}

function isBenchmarkTask(value: string | undefined): value is BenchmarkTask {
  return (
    value === "Résumé de texte" ||
    value === "Génération de code" ||
    value === "Raisonnement logique"
  );
}

function isSmallModel(model: OpenRouterModelInfo): boolean {
  const id = model.id.toLowerCase();
  return id.includes("7b") || id.includes("mini");
}

/**
 * Index public (0-100) pertinent pour la tâche.
 *
 * `agentic_index` sert aux tâches outil et recherche: c'est l'analogue public le
 * plus proche de ce qu'une boucle ReAct demande vraiment.
 */
function primaryIndex(
  taskKind: TaskKind,
  scores: ModelBenchmarkRow,
): number | null {
  switch (taskKind) {
    case "code":
      return scores.codingIndex;
    case "tool":
    case "research":
      return scores.agenticIndex;
    case "reasoning":
    case "summary":
    case "general":
      return scores.intelligenceIndex;
  }
}

/**
 * Note qualité 0-5 du modèle.
 *
 * `benchmark.md` gagne quand la ligne existe: c'est une mesure faite à la main sur
 * cette harness, donc plus pertinente qu'un index générique. Les index publics
 * couvrent les ~300 modèles jamais mesurés, où la valeur par défaut de 3 était
 * jusqu'ici la seule information disponible.
 */
export function qualityFor(
  taskKind: TaskKind,
  row: BenchmarkRow | undefined,
  publicScores: ModelBenchmarkRow | undefined,
): number {
  if (row) return row.qualityScore;
  if (publicScores) {
    const index = primaryIndex(taskKind, publicScores);
    if (index !== null) return (index / 100) * 5;
  }
  return 3;
}

/**
 * Bonus d'affinité tâche/modèle.
 *
 * Avec un index public on l'utilise: il se met à jour tout seul. Sans index on
 * retombe sur les heuristiques de nom, qui restent le seul signal disponible pour
 * un modèle sorti trop récemment pour être classé — mais qui vieillissent mal, donc
 * elles ne servent que de secours.
 */
export function taskAffinityBonus(
  taskKind: TaskKind,
  model: OpenRouterModelInfo,
  text: string,
  publicScores: ModelBenchmarkRow | undefined,
): number {
  const index = publicScores ? primaryIndex(taskKind, publicScores) : null;

  if (index !== null) {
    // Un index de 100 vaut 10 points, l'ordre de grandeur des anciens bonus.
    const bonus = (index / 100) * 10;
    // Le raisonnement profond reste le cas où la capacité déclarée compte autant
    // que le score: un modèle sans mode reasoning y plafonne.
    if (taskKind === "reasoning" && isComplex(text)) {
      return bonus + (supports(model, "reasoning") ? 8 : 0);
    }
    return bonus;
  }

  return heuristicAffinityBonus(taskKind, model, text);
}

/** Ancien barème, conservé pour les modèles absents des classements publics. */
function heuristicAffinityBonus(
  taskKind: TaskKind,
  model: OpenRouterModelInfo,
  text: string,
): number {
  switch (taskKind) {
    case "tool":
      return (isSmallModel(model) ? 8 : 0) + (isCoderModel(model) ? 2 : 0);
    case "code":
      return codeAffinityBonus(model, text);
    case "reasoning":
      if (!isComplex(text)) return 0;
      return (
        (supports(model, "reasoning") ? 8 : 0) +
        (model.id.includes("kimi") ? 3 : 0)
      );
    case "research":
    case "summary":
    case "general":
      return 0;
  }
}

/**
 * Coût approximatif d'un appel, en EUR, depuis la tarification live d'OpenRouter.
 *
 * `pricing` est en USD par token; on suppose un tour typique de cette harness
 * (contexte + outils en entrée, réponse courte en sortie). C'est une estimation
 * grossière, uniquement là pour comparer des modèles entre eux quand `benchmark.md`
 * n'a pas de ligne — pas pour facturer quoi que ce soit.
 */
const ASSUMED_PROMPT_TOKENS = 3000;
const ASSUMED_COMPLETION_TOKENS = 500;
const USD_TO_EUR = 0.92;

function estimatedCostEur(model: OpenRouterModelInfo): number | null {
  const prompt = Number(model.pricing.prompt);
  const completion = Number(model.pricing.completion);
  if (!Number.isFinite(prompt) || !Number.isFinite(completion)) return null;

  const usd =
    prompt * ASSUMED_PROMPT_TOKENS + completion * ASSUMED_COMPLETION_TOKENS;
  return usd * USD_TO_EUR;
}

/**
 * Modèle explicitement spécialisé code, d'après son nom ("code" couvre déjà
 * "coder"). Volontairement sans nom de fournisseur: sinon ce signal se
 * cumulerait avec celui de codeVendorAffinity, pour la même raison.
 */
function isCoderModel(model: OpenRouterModelInfo): boolean {
  return model.id.toLowerCase().includes("code");
}

/** Fournisseur généraliste réputé solide en code, sans modèle "coder" dédié. */
function isCodeStrongVendor(model: OpenRouterModelInfo): boolean {
  return model.id.toLowerCase().includes("deepseek");
}

/**
 * Un seul bonus code par modèle. Les deux signaux se recouvrent (deepseek-coder
 * déclenche les deux), donc ils s'excluent au lieu de s'additionner.
 */
export function codeAffinityBonus(
  model: OpenRouterModelInfo,
  text: string,
): number {
  if (isCoderModel(model)) return 8;
  if (isCodeStrongVendor(model)) return isComplex(text) ? 6 : 4;
  return 0;
}

function isComplex(text: string): boolean {
  return (
    text.length > 240 ||
    matches(text, [
      "complexe",
      "profond",
      "architecture",
      "multi-step",
      "plusieurs étapes",
      "en profondeur",
      "production",
    ])
  );
}

function matches(text: string, needles: string[]): boolean {
  return needles.some((needle) => text.includes(needle));
}
