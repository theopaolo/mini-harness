import { callTextModel, listUserModels } from "../llm";
import type { ChatMessage, LlmTextResult } from "../llm";
import type {
  Task,
  ModelDef,
  Row,
  OllamaTagsResponse,
  ChatCompletionResponse,
} from "./types";

const USD_TO_EUR = 0.92;
const OLLAMA_BASE = "http://localhost:11434/v1";

function getCompletionContent(data: ChatCompletionResponse): string {
  const content = data.choices[0]?.message.content;
  if (content === undefined) throw new Error("Missing completion content");
  return content;
}

// ── Tasks ────────────────────────────────────────────────────────────────────

const SUMMARY_TEXT = `
The history of computing spans from ancient tools like the abacus to modern AI.
Charles Babbage designed the Analytical Engine in the 19th century, and Ada Lovelace
wrote the first algorithm. ENIAC, built in 1945, was the first general-purpose electronic
computer. Transistors replaced vacuum tubes in the 1950s, integrated circuits followed,
and microprocessors arrived in the 1970s. The Apple II and IBM PC launched the personal
computer era. The internet reshaped computing in the 1990s, and cloud computing and
mobile devices dominated the 2000s. Today, AI and machine learning push the frontier.
`.trim();

const TASKS: Task[] = [
  {
    id: "summary",
    name: "Résumé de texte",
    prompt: `Summarize the following text in 2-3 sentences:\n\n${SUMMARY_TEXT}`,
    score: (r) => {
      const words = r.trim().split(/\s+/).length;
      if (words < 10) return 1;
      if (words < 20) return 2;
      if (words <= 70) return 5;
      if (words <= 130) return 3;
      return 2;
    },
  },
  {
    id: "code",
    name: "Génération de code",
    prompt:
      "Write a TypeScript function named `runningAverage` that takes an array of numbers and returns the running average at each position. Include the function signature with proper types. Only output the function, no explanation.",
    score: async (r) => {
      if (!r) return 1;
      const match = r.match(/```(?:typescript|ts)?\n([\s\S]+?)```/);
      if (!match) return 1;
      const tmpFile = `/tmp/bench_code_${Date.now()}.ts`;
      await Bun.write(
        tmpFile,
        `${match[1]}\nconsole.log(JSON.stringify(runningAverage([1, 2, 3, 4])));`,
      );
      const proc = Bun.spawnSync(["bun", "run", tmpFile]);
      Bun.spawnSync(["rm", "-f", tmpFile]);
      const output = proc.stdout.toString().trim();
      if (output === "[1,1.5,2,2.5]") return 5;
      if (proc.exitCode === 0) return 3; // ran but wrong output
      return 2; // had code block but crashed
    },
  },
  {
    id: "reasoning",
    name: "Raisonnement logique",
    // Ground truth: trains meet after 2 hours, 120 km from city A
    // time = 300 / (60 + 90) = 2h  |  distance = 60 × 2 = 120 km
    prompt:
      "A train leaves city A at 60 km/h. Another leaves city B, 300 km away, at 90 km/h heading toward city A. They start at the same time. When and where do they meet? Show your reasoning step by step.",
    score: (r) => {
      if (!r) return 0;
      const correct120 = /\b120\b/.test(r);
      const correct2h = /\b2\s*(hours?|h)\b/i.test(r);
      if (correct120 && correct2h) return 5;
      if (correct120 || correct2h) return 3; // one correct answer found
      if (/\d+/.test(r)) return 2; // attempted with numbers but wrong
      return 1;
    },
  },
];

// ── Models ───────────────────────────────────────────────────────────────────

async function listOllamaModels(): Promise<string[]> {
  try {
    const res = await fetch(`${OLLAMA_BASE.replace("/v1", "")}/api/tags`);
    if (!res.ok) return [];
    const data = (await res.json()) as OllamaTagsResponse;
    return (data.models ?? []).map((m: { name: string }) => m.name);
  } catch {
    return [];
  }
}

// ── API callers ──────────────────────────────────────────────────────────────

async function callOllama(
  messages: ChatMessage[],
  model: string,
): Promise<LlmTextResult> {
  const start = performance.now();
  const res = await fetch(`${OLLAMA_BASE}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model, messages, stream: false }),
  });
  const latencyMs = performance.now() - start;
  if (!res.ok) throw new Error(`Ollama ${res.status}: ${await res.text()}`);
  const data = (await res.json()) as ChatCompletionResponse;
  return {
    content: getCompletionContent(data),
    promptTokens: data.usage?.prompt_tokens ?? 0,
    completionTokens: data.usage?.completion_tokens ?? 0,
    latencyMs,
  };
}

// ── Benchmark ────────────────────────────────────────────────────────────────

async function runOne(model: ModelDef, task: Task): Promise<Row> {
  const messages: ChatMessage[] = [{ role: "user", content: task.prompt }];
  try {
    const r =
      model.provider === "openrouter"
        ? await callTextModel(messages, model.id)
        : await callOllama(messages, model.id);

    const costUsd = model.pricingPerToken
      ? Math.max(
          0,
          r.promptTokens * model.pricingPerToken.prompt +
            r.completionTokens * model.pricingPerToken.completion,
        )
      : 0;

    return {
      model: model.label,
      task: task.name,
      latencyMs: r.latencyMs,
      tokensIn: r.promptTokens,
      tokensOut: r.completionTokens,
      costEur: costUsd * USD_TO_EUR,
      qualityScore: await task.score(r.content),
    };
  } catch (e) {
    return {
      model: model.label,
      task: task.name,
      latencyMs: 0,
      tokensIn: 0,
      tokensOut: 0,
      costEur: 0,
      qualityScore: 0,
      error: String(e),
    };
  }
}

// ── Report ───────────────────────────────────────────────────────────────────

const stars = (n: number) => "★".repeat(n) + "☆".repeat(5 - n);

function formatCost(eur: number): string {
  if (eur === 0) return "€0.00";
  if (eur < 0.00001) return `€${eur.toExponential(2)}`;
  return `€${eur.toFixed(5)}`;
}

function buildReport(
  rows: Row[],
  date: string,
  flags: { openrouterOnly: boolean; ollamaOnly: boolean },
): string {
  const scope = flags.openrouterOnly
    ? "OpenRouter only"
    : flags.ollamaOnly
      ? "Ollama only"
      : "OpenRouter + Ollama";
  const lines = [
    `# Benchmark LLM — ${date}`,
    `> **Scope:** ${scope}`,
    "",
    "## How to read this report",
    "",
    "| Column | Description |",
    "|--------|-------------|",
    "| Latence | End-to-end response time (includes network + generation). Lower is faster. |",
    "| Tokens in | Prompt tokens sent to the model. |",
    "| Tokens out | Completion tokens generated. |",
    "| Coût | Estimated cost in EUR for this single call (prompt + completion pricing). `€0.00` = free or local. |",
    "| Score qualité | How correct/well-formed the response is (see scoring below). |",
    "",
    "### Scoring method per task",
    "",
    "| Task | Method | What gets 5★ |",
    "|------|--------|--------------|",
    "| Résumé de texte | Heuristic (word count) | Response between 20–70 words |",
    "| Génération de code | Ground truth — code is executed by Bun | `runningAverage([1,2,3,4])` returns `[1,1.5,2,2.5]` exactly |",
    "| Raisonnement logique | Ground truth — checks correct answers | Response contains both **120 km** and **2 hours** (the exact solution) |",
    "",
    "### Winners",
    "- **Meilleure qualité** — highest score; latency breaks ties (faster = better).",
    "- **Meilleur rapport qualité/coût** — best score-per-euro among paid models. Free/local models are excluded from this ranking since their ratio is infinite.",
    "",
    "> ⚠️ When multiple models tie on score, quality differences are invisible here — a judge model would be needed to rank them further.",
    "",
  ];

  for (const task of TASKS) {
    const taskRows = rows.filter((r) => r.task === task.name && !r.error);
    if (!taskRows.length) continue;

    lines.push(`## Tâche : ${task.name}`);
    lines.push(
      "| Modèle | Latence | Tokens in | Tokens out | Coût | Score qualité |",
    );
    lines.push(
      "|--------|---------|-----------|------------|------|---------------|",
    );

    const sorted = [...taskRows].sort(
      (a, b) => b.qualityScore - a.qualityScore,
    );
    for (const r of sorted) {
      lines.push(
        `| ${r.model} | ${r.latencyMs.toFixed(0)}ms | ${r.tokensIn} | ${r.tokensOut} | ${formatCost(r.costEur)} | ${stars(r.qualityScore)} |`,
      );
    }

    // Best quality: highest score, latency as tiebreaker
    const bestQuality = [...taskRows].sort(
      (a, b) => b.qualityScore - a.qualityScore || a.latencyMs - b.latencyMs,
    )[0];
    if (!bestQuality) continue;

    // Best value: quality/cost among paid models only (free models trivially win on ratio)
    const paidRows = taskRows.filter((r) => r.costEur > 0);
    const bestValue = paidRows.length
      ? paidRows.reduce((best, r) =>
          r.qualityScore / r.costEur > best.qualityScore / best.costEur
            ? r
            : best,
        )
      : null;

    lines.push(`\n**Meilleure qualité :** ${bestQuality.model}`);
    lines.push(
      bestValue
        ? `**Meilleur rapport qualité/coût :** ${bestValue.model}\n`
        : "",
    );
  }

  const blocked = rows.filter((r) =>
    r.error?.includes("No endpoints available"),
  );
  const failed = rows.filter(
    (r) => r.error && !r.error.includes("No endpoints available"),
  );

  if (blocked.length) {
    const blockedModels = [...new Set(blocked.map((r) => r.model))];
    lines.push(`## Modèles bloqués par guardrails (${blockedModels.length})`);
    lines.push(blockedModels.map((m) => `\`${m}\``).join(", "));
    lines.push("");
  }

  if (failed.length) {
    lines.push("## Erreurs");
    for (const r of failed)
      lines.push(`- **${r.model}** (${r.task}): ${r.error}`);
  }

  return lines.join("\n");
}

// ── Main ─────────────────────────────────────────────────────────────────────

const args = new Set(process.argv.slice(2));
const onlyOpenRouter = args.has("--openrouter");
const onlyOllama = args.has("--ollama");

if (onlyOpenRouter && onlyOllama) {
  console.error("Cannot use --openrouter and --ollama together");
  process.exit(1);
}

const models: ModelDef[] = [];

if (!onlyOllama) {
  const userModels = await listUserModels();
  const pricingMap = new Map(
    userModels.map((m) => [
      m.id,
      {
        prompt: parseFloat(m.pricing.prompt),
        completion: parseFloat(m.pricing.completion),
      },
    ]),
  );
  models.push(
    ...userModels.map((m) => ({
      id: m.id,
      label: m.id.split("/")[1] ?? m.id,
      provider: "openrouter" as const,
      pricingPerToken: pricingMap.get(m.id),
    })),
  );
}

if (!onlyOpenRouter) {
  const ollamaIds = await listOllamaModels();
  if (ollamaIds.length === 0)
    console.warn("Warning: Ollama not reachable or no models installed.\n");
  models.push(
    ...ollamaIds.map((id) => ({
      id,
      label: `${id} (local)`,
      provider: "ollama" as const,
    })),
  );
}

const total = models.length * TASKS.length;
console.log(
  `Running ${models.length} models × ${TASKS.length} tasks = ${total} parallel calls...\n`,
);

let done = 0;
const allRuns = models.flatMap((model) =>
  TASKS.map((task) =>
    runOne(model, task).then((r) => {
      done++;
      const icon = r.error ? "✗" : "✓";
      const detail = r.error
        ? r.error.slice(0, 60)
        : `${r.latencyMs.toFixed(0)}ms  ${stars(r.qualityScore)}`;
      console.log(
        `[${done}/${total}] ${icon} ${r.model.padEnd(28)} ${r.task.padEnd(22)} ${detail}`,
      );
      return r;
    }),
  ),
);

const rows = await Promise.all(allRuns);
const date = new Date().toISOString().slice(0, 10);
const report = buildReport(rows, date, {
  openrouterOnly: onlyOpenRouter,
  ollamaOnly: onlyOllama,
});

await Bun.write("model-bench/benchmark.md", report);
console.log(`\nWritten to benchmark.md`);
