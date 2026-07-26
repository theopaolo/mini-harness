import type { ToolCall } from "../tools";

export type ChatMessage = {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  tool_call_id?: string;
};

export type StopReason = "tool_use" | "end_turn" | "unknown";

export type HarnessMessage =
  | { role: "system" | "user"; content: string }
  | {
      role: "assistant";
      content: string | null;
      tool_calls?: OpenAiCompatibleToolCall[];
    }
  | { role: "tool"; tool_call_id: string; content: string };

export type ModelTurn = {
  stop_reason: StopReason;
  message: Extract<HarnessMessage, { role: "assistant" }>;
  tool_uses: ToolCall[];
};

export type OpenAiCompatibleToolCall = {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
};

export type OpenRouterModelInfo = {
  id: string;
  name: string;
  /**
   * Identifiant daté et stable (ex: "anthropic/claude-opus-5-20260723"). C'est la
   * clé de jointure avec /benchmarks, qui expose ce slug et non `id`.
   */
  canonicalSlug: string | null;
  contextLength: number;
  supportedParameters: string[];
  pricing: {
    prompt: string;
    completion: string;
  };
};

/**
 * Une ligne de GET /api/v1/benchmarks. Les trois index sont sur une échelle 0-100
 * et proviennent d'Artificial Analysis via OpenRouter.
 */
export type ModelBenchmarkRow = {
  modelPermaslug: string;
  displayName: string;
  intelligenceIndex: number | null;
  codingIndex: number | null;
  agenticIndex: number | null;
};

export type BenchmarkSnapshot = {
  rows: ModelBenchmarkRow[];
  /** Date de fraîcheur annoncée par OpenRouter (meta.as_of). */
  asOf: string | null;
};

export type LlmTextResult = {
  content: string;
  promptTokens: number;
  completionTokens: number;
  latencyMs: number;
};

export type BenchmarkResult = {
  model: string;
  tokensPerSecond: number;
  completionTokens: number;
  latencyMs: number;
  error?: string;
};
