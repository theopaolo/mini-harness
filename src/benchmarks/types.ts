export type Task = {
  id: string;
  name: string;
  prompt: string;
  score: (r: string) => number | Promise<number>;
};

export type ModelDef = {
  id: string;
  label: string;
  provider: "openrouter" | "ollama";
  pricingPerToken?: { prompt: number; completion: number };
};

export type LlmResult = {
  content: string;
  promptTokens: number;
  completionTokens: number;
  latencyMs: number;
};

export type OllamaTagsResponse = {
  models?: { name: string }[];
};

export type ChatCompletionResponse = {
  choices: {
    message: {
      content: string;
    };
  }[];
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
  };
};

export type Row = {
  model: string;
  task: string;
  latencyMs: number;
  tokensIn: number;
  tokensOut: number;
  costEur: number;
  qualityScore: number;
  error?: string;
};
