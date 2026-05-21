import { toolDefinitions, type ToolName } from "../tools";
import type {
  BenchmarkResult,
  ChatMessage,
  HarnessMessage,
  LlmTextResult,
  ModelTurn,
  OpenAiToolCall,
  OpenRouterModelInfo,
  StopReason,
} from "./types";

const BASE_URL = "https://openrouter.ai/api/v1";

type OpenRouterModelResponseItem = {
  id?: string;
  name?: string;
  context_length?: number;
  supported_parameters?: string[];
  pricing?: {
    prompt?: string;
    completion?: string;
  };
};

type ModelsResponse = {
  data?: OpenRouterModelResponseItem[];
};

type ChatCompletionResponse = {
  choices?: {
    finish_reason?: string;
    message?: {
      content?: string | null;
      tool_calls?: OpenAiToolCall[];
    };
  }[];
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
  };
};

const BENCHMARK_PROMPT: ChatMessage[] = [
  {
    role: "user",
    content:
      "Write a short paragraph about the history of computing. Be concise.",
  },
];

export async function listUserModels(): Promise<OpenRouterModelInfo[]> {
  const response = await fetch(`${BASE_URL}/models/user`, {
    headers: { Authorization: `Bearer ${getApiKey()}` },
  });

  if (!response.ok) {
    throw new Error(`OpenRouter ${response.status}: ${await response.text()}`);
  }

  const data = (await response.json()) as ModelsResponse;
  return parseModels(data);
}

export async function callTextModel(
  messages: ChatMessage[],
  model: string,
): Promise<LlmTextResult> {
  const start = performance.now();
  const response = await fetch(`${BASE_URL}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${getApiKey()}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ model, messages }),
  });
  const latencyMs = performance.now() - start;

  if (!response.ok) {
    throw new Error(`OpenRouter ${response.status}: ${await response.text()}`);
  }

  const data = (await response.json()) as ChatCompletionResponse;
  return {
    content: getCompletionContent(data),
    promptTokens: data.usage?.prompt_tokens ?? 0,
    completionTokens: data.usage?.completion_tokens ?? 0,
    latencyMs,
  };
}

export async function callToolModel(
  messages: HarnessMessage[],
  model: string,
): Promise<ModelTurn> {
  const response = await fetch(`${BASE_URL}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${getApiKey()}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      messages,
      tools: toolDefinitions,
      tool_choice: "auto",
      temperature: 0.2,
    }),
  });

  if (!response.ok) {
    throw new Error(`OpenRouter ${response.status}: ${await response.text()}`);
  }

  const data = (await response.json()) as ChatCompletionResponse;
  const choice = data.choices?.[0];
  if (!choice?.message) {
    throw new Error("Réponse OpenRouter invalide: message manquant");
  }

  const message: Extract<HarnessMessage, { role: "assistant" }> = {
    role: "assistant",
    content: choice.message.content ?? null,
    tool_calls: choice.message.tool_calls,
  };

  const toolUses = normalizeToolCalls(choice.message.tool_calls ?? []);

  return {
    stop_reason: normalizeStopReason(choice.finish_reason, toolUses),
    message,
    tool_uses: toolUses,
  };
}

export async function benchmarkTextModel(
  modelId: string,
): Promise<BenchmarkResult> {
  const start = performance.now();

  try {
    const result = await callTextModel(BENCHMARK_PROMPT, modelId);
    const tokensPerSecond = result.completionTokens / (result.latencyMs / 1000);

    return {
      model: modelId,
      tokensPerSecond,
      completionTokens: result.completionTokens,
      latencyMs: result.latencyMs,
    };
  } catch (error) {
    return {
      model: modelId,
      tokensPerSecond: 0,
      completionTokens: 0,
      latencyMs: performance.now() - start,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function parseModels(data: ModelsResponse): OpenRouterModelInfo[] {
  return (data.data ?? [])
    .filter(
      (model): model is OpenRouterModelResponseItem & { id: string } =>
        typeof model.id === "string",
    )
    .map((model) => ({
      id: model.id,
      name: model.name ?? model.id,
      contextLength: model.context_length ?? 0,
      supportedParameters: model.supported_parameters ?? [],
      pricing: {
        prompt: model.pricing?.prompt ?? "0",
        completion: model.pricing?.completion ?? "0",
      },
    }));
}

function getCompletionContent(data: ChatCompletionResponse): string {
  const content = data.choices?.[0]?.message?.content;
  if (content === undefined || content === null) {
    throw new Error("Missing completion content");
  }
  return content;
}

function normalizeToolCalls(toolCalls: OpenAiToolCall[]) {
  return toolCalls.map((toolCall) => {
    const rawName = toolCall.function.name;

    if (!isToolName(rawName)) {
      return {
        id: toolCall.id,
        name: "run_js" as const,
        input: {
          code: `throw new Error(${JSON.stringify(`outil inconnu: ${rawName}`)})`,
        },
      };
    }

    let input: Record<string, unknown> = {};
    try {
      const parsed = JSON.parse(toolCall.function.arguments);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        input = parsed as Record<string, unknown>;
      }
    } catch {}

    return {
      id: toolCall.id,
      name: rawName,
      input,
    };
  });
}

function normalizeStopReason(
  finishReason: string | undefined,
  toolUses: unknown[],
): StopReason {
  if (toolUses.length > 0 || finishReason === "tool_calls") return "tool_use";
  if (finishReason === "stop" || finishReason === "end_turn") {
    return "end_turn";
  }
  return "unknown";
}

function isToolName(value: string): value is ToolName {
  return (
    value === "fetch_url" ||
    value === "read_file" ||
    value === "run_js" ||
    value === "write_document" ||
    value === "memory_read" ||
    value === "memory_append" ||
    value === "memory_rewrite"
  );
}

function getApiKey(): string {
  const apiKey = Bun.env.OPEN_ROUTER_API;
  if (!apiKey) throw new Error("OPEN_ROUTER_API environment variable not set");
  return apiKey;
}
