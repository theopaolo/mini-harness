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
      tool_calls?: OpenAiToolCall[];
    }
  | { role: "tool"; tool_call_id: string; content: string };

export type ModelTurn = {
  stop_reason: StopReason;
  message: Extract<HarnessMessage, { role: "assistant" }>;
  tool_uses: ToolCall[];
};

export type OpenAiToolCall = {
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
  contextLength: number;
  supportedParameters: string[];
  pricing: {
    prompt: string;
    completion: string;
  };
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
