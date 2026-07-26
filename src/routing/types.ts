import type { ModelBenchmarkRow, OpenRouterModelInfo } from "../llm";

export type TaskKind = "tool" | "code" | "research" | "reasoning" | "summary" | "general";

export type BenchmarkTask =
  | "Résumé de texte"
  | "Génération de code"
  | "Raisonnement logique";

export type BenchmarkRow = {
  label: string;
  task: BenchmarkTask;
  latencyMs: number;
  costEur: number;
  qualityScore: number;
};

export type ToolBenchmarkRow = {
  model: string;
  validToolCallRate: number;
  correctToolChoiceRate: number;
  validJsonArgsRate: number;
  parallelToolCallRate: number;
  noToolDisciplineRate: number;
  finalizesAfterToolResultRate: number;
  totalScore: number;
  avgLatencyMs: number;
  error?: string;
};

export type ModelRoute = {
  modelCandidates: string[];
  selectedModel: string;
  taskKind: TaskKind;
  reason: string;
};

export type RankedCandidate = {
  model: OpenRouterModelInfo;
  row: BenchmarkRow | undefined;
  toolRow: ToolBenchmarkRow | undefined;
  /** Scores publics OpenRouter/Artificial Analysis, quand le modèle est classé. */
  publicScores: ModelBenchmarkRow | undefined;
  score: number;
};
