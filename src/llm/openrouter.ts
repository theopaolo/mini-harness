import { toolDefinitions, type ToolCall } from "../tools";
import type {
  BenchmarkResult,
  BenchmarkSnapshot,
  ChatMessage,
  HarnessMessage,
  LlmTextResult,
  ModelTurn,
  OpenAiCompatibleToolCall,
  OpenRouterModelInfo,
  StopReason,
} from "./types";

const BASE_URL = "https://openrouter.ai/api/v1";

type OpenRouterModelResponseItem = {
  id?: string;
  name?: string;
  canonical_slug?: string | null;
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

type BenchmarksResponse = {
  data?: {
    model_permaslug?: string;
    display_name?: string;
    intelligence_index?: number | null;
    coding_index?: number | null;
    agentic_index?: number | null;
  }[];
  meta?: {
    as_of?: string | null;
  };
};

type ChatCompletionResponse = {
  choices?: {
    finish_reason?: string;
    message?: {
      content?: string | null;
      tool_calls?: OpenAiCompatibleToolCall[];
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

/**
 * Scores publics par modèle (Artificial Analysis via OpenRouter).
 *
 * Requête séparée: /models/user ne renvoie PAS le champ `benchmarks`, contrairement
 * au /models public. C'est vérifié, pas supposé.
 */
export async function listBenchmarks(): Promise<BenchmarkSnapshot> {
  const response = await fetch(
    `${BASE_URL}/benchmarks?source=artificial-analysis`,
    { headers: { Authorization: `Bearer ${getApiKey()}` } },
  );

  if (!response.ok) {
    throw new Error(`OpenRouter ${response.status}: ${await response.text()}`);
  }

  const data = (await response.json()) as BenchmarksResponse;
  const rows = (data.data ?? [])
    .filter(
      (row): row is { model_permaslug: string } & typeof row =>
        typeof row.model_permaslug === "string",
    )
    .map((row) => ({
      modelPermaslug: row.model_permaslug,
      displayName: row.display_name ?? row.model_permaslug,
      intelligenceIndex: finiteOrNull(row.intelligence_index),
      codingIndex: finiteOrNull(row.coding_index),
      agenticIndex: finiteOrNull(row.agentic_index),
    }));

  return { rows, asOf: data.meta?.as_of ?? null };
}

function finiteOrNull(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
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
      canonicalSlug: model.canonical_slug ?? null,
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

function normalizeToolCalls(toolCalls: OpenAiCompatibleToolCall[]): ToolCall[] {
  return toolCalls.map((toolCall) => ({
    id: toolCall.id,
    // Le nom est transmis tel quel, y compris s'il est inconnu: c'est executeTool
    // qui répond au modèle, et le log doit montrer ce qui a vraiment été demandé.
    name: toolCall.function.name,
    ...parseToolArguments(toolCall.function.arguments),
  }));
}

function parseToolArguments(
  raw: string,
): Pick<ToolCall, "input" | "argumentsError"> {
  // Les modèles omettent parfois `arguments` pour un outil sans paramètre.
  if (raw === undefined || raw.trim() === "") return { input: {} };

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {
      input: {},
      argumentsError: `arguments illisibles, JSON invalide (reçu: ${preview(raw)})`,
    };
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return {
      input: {},
      argumentsError: `arguments attendus sous forme d'objet JSON (reçu: ${preview(raw)})`,
    };
  }

  return { input: parsed as Record<string, unknown> };
}

function preview(raw: string): string {
  return raw.length <= 120 ? raw : `${raw.slice(0, 120)}…`;
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

function getApiKey(): string {
  const apiKey = Bun.env.OPEN_ROUTER_API;
  if (!apiKey) throw new Error("OPEN_ROUTER_API environment variable not set");
  return apiKey;
}
