import type { OpenRouterModelInfo } from "../llm";
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
): Promise<ModelRoute> {
  const taskKind = classifyMission(mission);
  const benchmarkRows = await readBenchmarkRows();
  const toolBenchmarkRows = await readToolBenchmarkRows();
  const candidates = rankModels(
    mission,
    taskKind,
    models,
    benchmarkRows,
    toolBenchmarkRows,
  );

  if (candidates.length === 0) {
    throw new Error("Aucun modèle compatible avec la harness n'a été trouvé");
  }
  const winner = candidates[0];
  if (!winner) {
    throw new Error("Aucun modèle compatible avec la harness n'a été trouvé");
  }

  return {
    modelCandidates: candidates.map((candidate) => candidate.model.id),
    selectedModel: winner.model.id,
    taskKind,
    reason: explainRoute(taskKind, winner),
  };
}

function classifyMission(mission: string): TaskKind {
  const text = mission.toLowerCase();

  if (/\bhttps?:\/\//.test(text)) return "research";
  if (matches(text, ["recherche", "compare", "comparatif", "rapport"])) {
    return "research";
  }
  if (matches(text, ["résume", "resume", "summary", "synthèse"])) {
    return "summary";
  }
  if (
    matches(text, [
      "calcule",
      "calcul",
      "addition",
      "multiplie",
      "json",
      "parser",
      "parse",
      "transforme",
      "convertis",
    ])
  ) {
    return "tool";
  }
  if (
    matches(text, [
      "code",
      "typescript",
      "javascript",
      "bug",
      "fonction",
      "implémente",
      "implemente",
      "refactor",
    ])
  ) {
    return "code";
  }
  if (
    matches(text, [
      "raisonne",
      "raisonnement",
      "logique",
      "prouve",
      "démontre",
      "demontre",
      "stratégie",
      "strategie",
      "architecture",
    ])
  ) {
    return "reasoning";
  }

  return "general";
}

function rankModels(
  mission: string,
  taskKind: TaskKind,
  models: OpenRouterModelInfo[],
  benchmarkRows: BenchmarkRow[],
  toolBenchmarkRows: ToolBenchmarkRow[],
): RankedCandidate[] {
  const usable = models.filter((model) => supports(model, "tools"));
  const base = usable.length > 0 ? usable : models;
  const benchmarkTask = benchmarkTaskFor(taskKind);

  return base
    .map((model) => {
      const row = findBenchmarkRow(model, benchmarkRows, benchmarkTask);
      const toolRow = findToolBenchmarkRow(model, toolBenchmarkRows);
      return {
        model,
        row,
        toolRow,
        score: scoreModel(mission, taskKind, model, row, toolRow),
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
): number {
  const text = mission.toLowerCase();
  const quality = row?.qualityScore ?? 3;
  const latencyMs = row?.latencyMs ?? 3000;
  const costEur = row?.costEur ?? 0.001;
  const cheapBonus = costEur === 0 ? 2 : 1 / (1 + costEur * 100_000);
  const fastBonus = 1 / (1 + latencyMs / 1000);

  let score = quality * 10 + cheapBonus * 8 + fastBonus * 6;

  if (supports(model, "tools")) score += 10;
  if (supports(model, "parallel_tool_calls")) score += 2;
  if (supports(model, "reasoning")) score += taskKind === "reasoning" ? 6 : 1;
  score += toolBenchmarkBonus(taskKind, toolRow);

  if (taskKind === "tool") {
    score += isSmallModel(model) ? 8 : 0;
    score += isCoderModel(model) ? 2 : 0;
  }

  if (taskKind === "code") {
    score += isCoderModel(model) ? 8 : 0;
    score += isComplex(text) && model.id.includes("deepseek") ? 4 : 0;
  }

  if (taskKind === "research") {
    score += supports(model, "parallel_tool_calls") ? 6 : 0;
    score += model.contextLength >= 250_000 ? 3 : 0;
  }

  if (taskKind === "reasoning" && isComplex(text)) {
    score += supports(model, "reasoning") ? 8 : 0;
    score += model.id.includes("kimi") ? 3 : 0;
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
      return score * 25 + toolRow.noToolDisciplineRate * 8 + latencyBonus * 0.25;
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

  const markdown = await file.text();
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

    rows.push({
      task: currentTask,
      label,
      latencyMs: parseInt(latencyCell.replace("ms", ""), 10),
      costEur: parseCost(costCell),
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

function explainRoute(taskKind: TaskKind, winner: RankedCandidate): string {
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

  return `${taskKind}: ${modelLabel(winner.model.id)} (${caps.join(", ") || "capacités limitées"}; benchmark ${bench}; ${toolBench})`;
}

function parseCost(cell: string): number {
  const raw = cell.replace("€", "").trim();
  return Number(raw);
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
  return id.includes("7b") || id.includes("mini") || id.includes("haiku");
}

function isCoderModel(model: OpenRouterModelInfo): boolean {
  const id = model.id.toLowerCase();
  return id.includes("coder") || id.includes("code") || id.includes("deepseek");
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
