import { mkdir } from "node:fs/promises";
import {
  callToolModel,
  listUserModels,
  type HarnessMessage,
  type ModelTurn,
  type OpenRouterModelInfo,
} from "../llm";
import { executeTool, type ToolCall, type ToolName } from "../tools";

const JSON_OUTPUT = "model-bench/tool-benchmark.json";
const MARKDOWN_OUTPUT = "model-bench/tool-benchmark.md";

type ToolTaskId =
  | "single_run_js"
  | "parallel_run_js"
  | "save_note"
  | "no_tool"
  | "final_after_observation";

type ToolTask = {
  id: ToolTaskId;
  prompt: string;
  expectedTools: ToolName[];
  expectsNoTool?: boolean;
  validatesFinalAnswer?: boolean;
};

type ToolTaskResult = {
  id: ToolTaskId;
  latencyMs: number;
  stopReason: string;
  toolNames: string[];
  hasExpectedToolCall: boolean;
  hasValidArgs: boolean;
  respectsNoTool: boolean | null;
  finalizesAfterToolResult: boolean | null;
  error?: string;
};

export type ToolBenchmarkRow = {
  model: string;
  name: string;
  supportsToolsDeclared: boolean;
  supportsParallelToolsDeclared: boolean;
  supportsReasoningDeclared: boolean;
  validToolCallRate: number;
  correctToolChoiceRate: number;
  validJsonArgsRate: number;
  parallelToolCallRate: number;
  noToolDisciplineRate: number;
  finalizesAfterToolResultRate: number;
  totalScore: number;
  avgLatencyMs: number;
  tasks: ToolTaskResult[];
  error?: string;
};

type ToolBenchmarkReport = {
  generatedAt: string;
  taskCount: number;
  rows: ToolBenchmarkRow[];
};

const TASKS: ToolTask[] = [
  {
    id: "single_run_js",
    prompt:
      "Utilise obligatoirement l'outil run_js pour calculer 37 * 42. Ne donne pas la réponse finale maintenant.",
    expectedTools: ["run_js"],
  },
  {
    id: "parallel_run_js",
    prompt:
      "Appelle run_js deux fois dans ce même tour: une fois pour 12 * 8 et une fois pour 99 + 3. Ne donne pas la réponse finale maintenant.",
    expectedTools: ["run_js", "run_js"],
  },
  {
    id: "save_note",
    prompt:
      "Appelle obligatoirement save_note avec le contenu exact: TOOL_BENCH_OK. Ne donne pas la réponse finale maintenant.",
    expectedTools: ["save_note"],
  },
  {
    id: "no_tool",
    prompt:
      "Réponds exactement BONJOUR. N'utilise aucun outil pour cette demande.",
    expectedTools: [],
    expectsNoTool: true,
  },
  {
    id: "final_after_observation",
    prompt:
      "Utilise run_js pour calculer 37 * 42, puis après observation de l'outil, réponds seulement avec le nombre.",
    expectedTools: ["run_js"],
    validatesFinalAnswer: true,
  },
];

const args = parseArgs(process.argv.slice(2));
const models = await selectModels(args);
const rows: ToolBenchmarkRow[] = [];

console.log(`Tool benchmark: ${models.length} modèle(s), ${TASKS.length} tâche(s)\n`);

for (const model of models) {
  const row = await benchmarkModel(model);
  rows.push(row);

  const status = row.error ? "ERR" : `${Math.round(row.totalScore * 100)}%`;
  console.log(
    `${status.padStart(4)}  ${model.id.padEnd(34)}  tool=${pct(row.validToolCallRate)}  choice=${pct(row.correctToolChoiceRate)}  final=${pct(row.finalizesAfterToolResultRate)}`,
  );
}

rows.sort((a, b) => b.totalScore - a.totalScore);
const report: ToolBenchmarkReport = {
  generatedAt: new Date().toISOString(),
  taskCount: TASKS.length,
  rows,
};

await mkdir("model-bench", { recursive: true });
await Bun.write(JSON_OUTPUT, JSON.stringify(report, null, 2));
await Bun.write(MARKDOWN_OUTPUT, buildMarkdown(report));

console.log(`\nWritten ${JSON_OUTPUT}`);
console.log(`Written ${MARKDOWN_OUTPUT}`);

async function benchmarkModel(
  model: OpenRouterModelInfo,
): Promise<ToolBenchmarkRow> {
  const taskResults: ToolTaskResult[] = [];

  try {
    for (const task of TASKS) {
      taskResults.push(await runTask(model.id, task));
    }
  } catch (error) {
    return buildRow(model, taskResults, errorMessage(error));
  }

  return buildRow(model, taskResults);
}

async function runTask(model: string, task: ToolTask): Promise<ToolTaskResult> {
  const messages: HarnessMessage[] = [
    {
      role: "system",
      content:
        "Tu es testé sur ta capacité à utiliser des outils. Respecte exactement la consigne utilisateur.",
    },
    { role: "user", content: task.prompt },
  ];

  const start = performance.now();
  const firstTurn = await callToolModel(messages, model);
  const latencyMs = performance.now() - start;
  const toolCalls = firstTurn.tool_uses;
  const toolNames = toolCalls.map((call) => call.name);

  const respectsNoTool = task.expectsNoTool
    ? firstTurn.stop_reason === "end_turn" && toolCalls.length === 0
    : null;
  const hasExpectedToolCall = hasExpectedTools(toolCalls, task.expectedTools);
  const hasValidArgs = validateArgs(task, toolCalls);
  const finalizesAfterToolResult = task.validatesFinalAnswer
    ? await validateFinalAfterObservation(model, messages, firstTurn)
    : null;

  return {
    id: task.id,
    latencyMs,
    stopReason: firstTurn.stop_reason,
    toolNames,
    hasExpectedToolCall,
    hasValidArgs,
    respectsNoTool,
    finalizesAfterToolResult,
  };
}

async function validateFinalAfterObservation(
  model: string,
  messages: HarnessMessage[],
  firstTurn: ModelTurn,
): Promise<boolean> {
  const runJsCall = firstTurn.tool_uses.find((call) => call.name === "run_js");
  if (!runJsCall) return false;

  const toolResult = await executeTool(runJsCall);
  const followUpMessages: HarnessMessage[] = [
    ...messages,
    firstTurn.message,
    {
      role: "tool",
      tool_call_id: runJsCall.id,
      content: toolResult,
    },
  ];
  const secondTurn = await callToolModel(followUpMessages, model);
  const content = secondTurn.message.content ?? "";

  return (
    secondTurn.stop_reason === "end_turn" &&
    secondTurn.tool_uses.length === 0 &&
    content.includes("1554")
  );
}

function buildRow(
  model: OpenRouterModelInfo,
  tasks: ToolTaskResult[],
  error?: string,
): ToolBenchmarkRow {
  const toolTasks = TASKS.filter((task) => !task.expectsNoTool);
  const noToolTasks = TASKS.filter((task) => task.expectsNoTool);
  const finalTasks = TASKS.filter((task) => task.validatesFinalAnswer);
  const parallelTasks = TASKS.filter((task) => task.expectedTools.length > 1);

  const validToolCallRate = rate(
    tasks.filter((task) => !isNoToolTask(task.id)),
    (task) => task.toolNames.length > 0,
    toolTasks.length,
  );
  const correctToolChoiceRate = rate(
    tasks.filter((task) => !isNoToolTask(task.id)),
    (task) => task.hasExpectedToolCall,
    toolTasks.length,
  );
  const validJsonArgsRate = rate(
    tasks.filter((task) => !isNoToolTask(task.id)),
    (task) => task.hasValidArgs,
    toolTasks.length,
  );
  const parallelToolCallRate = rate(
    tasks.filter((task) => task.id === "parallel_run_js"),
    (task) => task.hasExpectedToolCall && task.toolNames.length >= 2,
    parallelTasks.length,
  );
  const noToolDisciplineRate = rate(
    tasks.filter((task) => isNoToolTask(task.id)),
    (task) => task.respectsNoTool === true,
    noToolTasks.length,
  );
  const finalizesAfterToolResultRate = rate(
    tasks.filter((task) => task.finalizesAfterToolResult !== null),
    (task) => task.finalizesAfterToolResult === true,
    finalTasks.length,
  );
  const avgLatencyMs = tasks.length
    ? tasks.reduce((sum, task) => sum + task.latencyMs, 0) / tasks.length
    : 0;

  const totalScore =
    validToolCallRate * 0.22 +
    correctToolChoiceRate * 0.24 +
    validJsonArgsRate * 0.2 +
    finalizesAfterToolResultRate * 0.18 +
    noToolDisciplineRate * 0.11 +
    parallelToolCallRate * 0.05;

  return {
    model: model.id,
    name: model.name,
    supportsToolsDeclared: supports(model, "tools"),
    supportsParallelToolsDeclared: supports(model, "parallel_tool_calls"),
    supportsReasoningDeclared: supports(model, "reasoning"),
    validToolCallRate,
    correctToolChoiceRate,
    validJsonArgsRate,
    parallelToolCallRate,
    noToolDisciplineRate,
    finalizesAfterToolResultRate,
    totalScore: error ? 0 : totalScore,
    avgLatencyMs,
    tasks,
    error,
  };
}

function hasExpectedTools(calls: ToolCall[], expected: ToolName[]): boolean {
  if (expected.length === 0) return calls.length === 0;
  const remaining = [...calls.map((call) => call.name)];

  for (const toolName of expected) {
    const index = remaining.indexOf(toolName);
    if (index === -1) return false;
    remaining.splice(index, 1);
  }

  return true;
}

function validateArgs(task: ToolTask, calls: ToolCall[]): boolean {
  if (task.expectsNoTool) return calls.length === 0;

  switch (task.id) {
    case "single_run_js":
    case "final_after_observation":
      return calls.some(
        (call) =>
          call.name === "run_js" &&
          typeof call.input.code === "string" &&
          call.input.code.includes("37") &&
          call.input.code.includes("42"),
      );
    case "parallel_run_js": {
      const codes = calls
        .filter((call) => call.name === "run_js")
        .map((call) => call.input.code)
        .filter((code): code is string => typeof code === "string");
      return (
        codes.length >= 2 &&
        codes.some((code) => code.includes("12") && code.includes("8")) &&
        codes.some((code) => code.includes("99") && code.includes("3"))
      );
    }
    case "save_note":
      return calls.some(
        (call) =>
          call.name === "save_note" &&
          call.input.content === "TOOL_BENCH_OK",
      );
    case "no_tool":
      return calls.length === 0;
  }
}

async function selectModels(args: {
  all: boolean;
  limit?: number;
  models?: string[];
}): Promise<OpenRouterModelInfo[]> {
  const models = await listUserModels();
  const selected = args.models
    ? models.filter((model) => args.models?.includes(model.id))
    : args.all
      ? models
      : models.filter((model) => supports(model, "tools"));

  return args.limit ? selected.slice(0, args.limit) : selected;
}

function parseArgs(argv: string[]): {
  all: boolean;
  limit?: number;
  models?: string[];
} {
  const all = argv.includes("--all");
  const limitIndex = argv.indexOf("--limit");
  const modelsIndex = argv.indexOf("--models");
  const limit =
    limitIndex === -1 ? undefined : Number(argv[limitIndex + 1] ?? "0");
  const models =
    modelsIndex === -1
      ? undefined
      : (argv[modelsIndex + 1] ?? "")
          .split(",")
          .map((model) => model.trim())
          .filter(Boolean);

  return {
    all,
    limit: limit && Number.isFinite(limit) ? limit : undefined,
    models: models && models.length > 0 ? models : undefined,
  };
}

function buildMarkdown(report: ToolBenchmarkReport): string {
  const lines = [
    `# Tool Benchmark — ${report.generatedAt.slice(0, 10)}`,
    "",
    "| Modèle | Score tools | Tool call | Bon outil | Args valides | No-tool | Final après outil | Parallèle | Latence |",
    "|--------|-------------|-----------|-----------|--------------|---------|-------------------|-----------|---------|",
  ];

  for (const row of report.rows) {
    lines.push(
      `| ${row.model} | ${pct(row.totalScore)} | ${pct(row.validToolCallRate)} | ${pct(row.correctToolChoiceRate)} | ${pct(row.validJsonArgsRate)} | ${pct(row.noToolDisciplineRate)} | ${pct(row.finalizesAfterToolResultRate)} | ${pct(row.parallelToolCallRate)} | ${row.avgLatencyMs.toFixed(0)}ms |`,
    );
  }

  const errors = report.rows.filter((row) => row.error);
  if (errors.length > 0) {
    lines.push("", "## Erreurs");
    for (const row of errors) {
      lines.push(`- ${row.model}: ${row.error}`);
    }
  }

  return `${lines.join("\n")}\n`;
}

function supports(model: OpenRouterModelInfo, parameter: string): boolean {
  return model.supportedParameters.includes(parameter);
}

function isNoToolTask(id: ToolTaskId): boolean {
  return id === "no_tool";
}

function rate(
  tasks: ToolTaskResult[],
  predicate: (task: ToolTaskResult) => boolean,
  expectedCount: number,
): number {
  if (expectedCount === 0) return 0;
  const passed = tasks.filter(predicate).length;
  return passed / expectedCount;
}

function pct(value: number): string {
  return `${Math.round(value * 100)}%`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
