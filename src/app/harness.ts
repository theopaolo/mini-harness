import {
  callToolModel,
  listUserModels,
  type HarnessMessage,
  type ModelTurn,
} from "../llm";
import { routeModels } from "../routing/modelRouter";
import { pickCheapModel } from "../cheapModel";
import { buildSystemPrompt, detectSkill, loadSkillCatalog } from "../skills";
import { withTimeout } from "../timeout";
import { executeTool, type ToolCall } from "../tools";
import { SYSTEM_PROMPT } from "./systemPrompt";

const MAX_TURNS = 15;
const DEBUG_PREVIEW_CHARS = 1200;
const MODEL_CALL_TIMEOUT_MS = 120_000;
const TOOL_CALL_TIMEOUT_MS = 60_000;

type HarnessOptions = {
  model?: string;
  maxTurns?: number;
  debug?: boolean;
  step?: boolean;
  debugMaxChars?: number;
};

export async function runHarness(
  mission: string,
  options: HarnessOptions = {},
): Promise<string> {
  const maxTurns = options.maxTurns ?? MAX_TURNS;
  const debug = createDebugSession(options);
  const forcedModel = options.model ?? Bun.env.HARNESS_MODEL;

  const userModels = forcedModel ? [] : await listUserModels();

  // Un seul modèle bon marché pour les deux appels auxiliaires: classer la mission
  // et router les skills. `userModels` est vide quand un modèle est forcé, et on
  // réutilise alors ce modèle plutôt que d'en chercher un autre dans le dos de
  // l'appelant.
  const cheapModel = pickCheapModel(
    userModels,
    forcedModel ? [forcedModel] : [],
  );

  const route = forcedModel
    ? {
        selectedModel: forcedModel,
        modelCandidates: [forcedModel],
        reason: "modèle forcé par option ou HARNESS_MODEL",
      }
    : await routeModels(mission, userModels, cheapModel);

  const catalog = await loadSkillCatalog();
  const skill = await detectSkill(mission, catalog, cheapModel);
  const systemPrompt = buildSystemPrompt(SYSTEM_PROMPT, skill);
  const modelCandidates = route.modelCandidates;
  let modelIndex = 0;

  if (modelCandidates.length === 0) {
    throw new Error(
      "Aucun modèle utilisable retourné par OpenRouter /models/user",
    );
  }

  console.log(`Modèle: ${route.selectedModel}`);
  console.log(`Route: ${route.reason}`);
  console.log(`Mission: ${mission}\n`);

  const messages: HarnessMessage[] = [
    { role: "system", content: systemPrompt },
    { role: "user", content: mission },
  ];
  await debug.initial(messages);

  for (let turnNumber = 1; turnNumber <= maxTurns; turnNumber++) {
    const currentModel = modelCandidates[modelIndex] ?? route.selectedModel;
    await debug.beforeModelCall(turnNumber, currentModel, messages);

    console.log(
      `[tour ${turnNumber}] llm → ${currentModel} (${messages.length} msgs)…`,
    );
    const llmStart = Date.now();
    const turn = await callModelWithFallback(
      messages,
      modelCandidates,
      modelIndex,
      turnNumber,
    );
    console.log(
      `[tour ${turnNumber}] llm ← ${turn.stop_reason} (${Date.now() - llmStart}ms)`,
    );
    modelIndex = turn.modelIndex;
    messages.push(turn.message);
    await debug.modelResponse(turnNumber, turn, messages.at(-1));

    if (turn.stop_reason === "tool_use") {
      if (turn.tool_uses.length === 0) {
        const message =
          "Arrêt: le modèle a demandé un tool_use, mais aucun appel outil n'était présent.";
        logTurn(turnNumber, "tool_use", message);
        return message;
      }

      const toolResults = await runToolCalls(
        turn.tool_uses,
        turnNumber,
        debug,
        Boolean(options.debug || options.step),
      );

      for (const { toolUse, result } of toolResults) {
        const toolMessage: HarnessMessage = {
          role: "tool",
          tool_call_id: toolUse.id,
          content: result,
        };
        messages.push(toolMessage);
        await debug.afterTool(turnNumber, toolUse, result, toolMessage);
      }

      continue;
    }

    if (turn.stop_reason === "end_turn") {
      const finalAnswer = turn.message.content?.trim() || "(réponse vide)";
      logTurn(turnNumber, "end_turn", finalAnswer);
      return finalAnswer;
    }

    const message = `Arrêt: stop_reason non géré (${turn.stop_reason}).`;
    logTurn(turnNumber, "unknown", message);
    return message;
  }

  const message = `Arrêt propre: maximum de ${maxTurns} tours dépassé.`;
  logTurn(maxTurns, "max_turns", message);
  return message;
}

type ToolOutcome = { toolUse: ToolCall; result: string };

/**
 * Exécute les tool calls d'un tour.
 *
 * En parallèle, les lignes de log de chaque outil sont tamponnées puis vidées d'un
 * coup: sans ça, plusieurs outils écrivent en même temps et le journal devient
 * illisible, ce qui va contre l'intérêt même de cette harness. Chaque outil est
 * étiqueté `nom#rang` pour rester identifiable.
 *
 * En mode debug ou pas-à-pas, on repasse en séquentiel. On demande explicitement à
 * voir le mécanisme se dérouler dans l'ordre, et des blocs de debug concurrents ne
 * racontent plus rien.
 */
async function runToolCalls(
  toolUses: ToolCall[],
  turnNumber: number,
  debug: DebugSession,
  sequential: boolean,
): Promise<ToolOutcome[]> {
  const parallel = !sequential && toolUses.length > 1;

  const runOne = async (
    toolUse: ToolCall,
    slot: number,
  ): Promise<ToolOutcome> => {
    const tag = parallel ? `${toolUse.name}#${slot + 1}` : toolUse.name;
    const buffer: string[] = [];
    const log = (line: string) => {
      if (parallel) buffer.push(line);
      else console.log(line);
    };

    await debug.beforeTool(turnNumber, toolUse);
    log(`[tour ${turnNumber}] tool → ${tag}…`);

    const start = Date.now();
    const result = await withTimeout(
      executeTool(toolUse),
      TOOL_CALL_TIMEOUT_MS,
      `tool ${toolUse.name}`,
    ).catch(
      (error) =>
        `Erreur ${toolUse.name}: ${error instanceof Error ? error.message : String(error)}`,
    );

    log(`[tour ${turnNumber}] tool ← ${tag} (${Date.now() - start}ms)`);
    log(`[tour ${turnNumber}] ${tag} -> ${resultPreview(result)}`);
    if (parallel) console.log(buffer.join("\n"));

    return { toolUse, result };
  };

  if (sequential) {
    const outcomes: ToolOutcome[] = [];
    for (const [slot, toolUse] of toolUses.entries()) {
      outcomes.push(await runOne(toolUse, slot));
    }
    return outcomes;
  }

  return Promise.all(toolUses.map(runOne));
}

type DebugSession = {
  initial: (messages: HarnessMessage[]) => Promise<void>;
  beforeModelCall: (
    turnNumber: number,
    model: string,
    messages: HarnessMessage[],
  ) => Promise<void>;
  modelResponse: (
    turnNumber: number,
    turn: ModelTurn,
    injectedMessage: HarnessMessage | undefined,
  ) => Promise<void>;
  beforeTool: (turnNumber: number, toolUse: ToolCall) => Promise<void>;
  afterTool: (
    turnNumber: number,
    toolUse: ToolCall,
    result: string,
    injectedMessage: HarnessMessage,
  ) => Promise<void>;
};

function createDebugSession(options: HarnessOptions): DebugSession {
  const enabled = options.debug || options.step;
  const maxChars = options.debugMaxChars ?? DEBUG_PREVIEW_CHARS;

  if (!enabled) {
    const noop = async () => {};
    return {
      initial: noop,
      beforeModelCall: noop,
      modelResponse: noop,
      beforeTool: noop,
      afterTool: noop,
    };
  }

  return {
    async initial(messages) {
      printDebugBlock("messages initiaux", [
        `count: ${messages.length}`,
        ...messages.map((message, index) =>
          formatInjectedMessage(index, message, maxChars),
        ),
      ]);
      await maybeStep(options.step, "Entrée pour appeler le modèle");
    },

    async beforeModelCall(turnNumber, model, messages) {
      printDebugBlock(`tour ${turnNumber} - avant appel LLM`, [
        `model: ${model}`,
        `messages envoyés: ${messages.length}`,
        `dernier message:\n${formatInjectedMessage(messages.length - 1, messages.at(-1), maxChars)}`,
      ]);
      await maybeStep(options.step, "Entrée pour envoyer ce contexte au modèle");
    },

    async modelResponse(turnNumber, turn, injectedMessage) {
      const content = turn.message.content?.trim() || "(contenu vide)";
      printDebugBlock(`tour ${turnNumber} - sortie modèle`, [
        `stop_reason: ${turn.stop_reason}`,
        `assistant.content:\n${preview(content, maxChars)}`,
        `tool_uses:\n${formatToolUses(turn.tool_uses, maxChars)}`,
        `réinjecté:\n${formatInjectedMessage("assistant", injectedMessage, maxChars)}`,
      ]);
      await maybeStep(options.step, "Entrée pour exécuter les outils demandés");
    },

    async beforeTool(turnNumber, toolUse) {
      printDebugBlock(`tour ${turnNumber} - appel outil`, [
        `${toolUse.name}(${preview(JSON.stringify(toolUse.input), maxChars)})`,
      ]);
    },

    async afterTool(turnNumber, toolUse, result, injectedMessage) {
      printDebugBlock(`tour ${turnNumber} - observation outil`, [
        `outil: ${toolUse.name}`,
        `résultat:\n${preview(result, maxChars)}`,
        `réinjecté:\n${formatInjectedMessage("tool", injectedMessage, maxChars)}`,
      ]);
      await maybeStep(
        options.step,
        "Entrée pour continuer avec l'observation réinjectée",
      );
    },
  };
}

function printDebugBlock(title: string, lines: string[]): void {
  console.log(`\n[debug] ${title}`);
  console.log("─".repeat(Math.min(72, title.length + 8)));
  for (const line of lines) console.log(line);
}

function formatToolUses(toolUses: ToolCall[], maxChars: number): string {
  if (toolUses.length === 0) return "(aucun)";
  return toolUses
    .map(
      (toolUse, index) =>
        `${index + 1}. id=${toolUse.id}\n   name=${toolUse.name}\n   input=${preview(JSON.stringify(toolUse.input, null, 2), maxChars)}`,
    )
    .join("\n");
}

function formatInjectedMessage(
  index: number | string,
  message: HarnessMessage | undefined,
  maxChars: number,
): string {
  if (!message) return `${index}: (message absent)`;

  if (message.role === "assistant") {
    const content = message.content?.trim() || "(contenu vide)";
    const toolCalls = message.tool_calls?.length
      ? `\ntool_calls=${preview(JSON.stringify(message.tool_calls, null, 2), maxChars)}`
      : "";
    return `${index}: role=assistant\ncontent=${preview(content, maxChars)}${toolCalls}`;
  }

  if (message.role === "tool") {
    return `${index}: role=tool tool_call_id=${message.tool_call_id}\ncontent=${preview(message.content, maxChars)}`;
  }

  return `${index}: role=${message.role}\ncontent=${preview(message.content, maxChars)}`;
}

function preview(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  return `${value.slice(0, maxChars)}\n… (${value.length - maxChars} caractères masqués)`;
}

async function maybeStep(enabled: boolean | undefined, label: string) {
  if (!enabled) return;
  if (!process.stdin.isTTY) {
    console.log(`[debug] ${label} (pas de TTY, pause ignorée)`);
    return;
  }

  const readline = await import("node:readline/promises");
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  await rl.question(`[step] ${label}... `);
  rl.close();
}

async function callModelWithFallback(
  messages: HarnessMessage[],
  modelCandidates: string[],
  startIndex: number,
  turnNumber: number,
): Promise<ModelTurn & { modelIndex: number }> {
  for (let index = startIndex; index < modelCandidates.length; index++) {
    const model = modelCandidates[index];
    if (!model) continue;

    try {
      const turn = await withTimeout(
        callToolModel(messages, model),
        MODEL_CALL_TIMEOUT_MS,
        `model ${model}`,
      );
      if (index !== startIndex) {
        logTurn(turnNumber, "model", `Bascule vers ${model}`);
      }
      return { ...turn, modelIndex: index };
    } catch (error) {
      if (!isRetryableModelError(error)) throw error;

      const nextModel = modelCandidates[index + 1];
      if (!nextModel) throw error;
      logTurn(turnNumber, "model", `${model} indisponible, essai ${nextModel}`);
    }
  }

  throw new Error("Aucun modèle candidat disponible");
}

function logTurn(turnNumber: number, action: string, result: string): void {
  console.log(`[tour ${turnNumber}] ${action} -> ${resultPreview(result)}`);
}

function resultPreview(result: string): string {
  return result.replace(/\s+/g, " ").slice(0, 50);
}

function isRetryableModelError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return (
    message.includes("No endpoints available") ||
    message.includes("model is not available") ||
    message.includes("Provider returned error") ||
    message.includes("timeout:")
  );
}

