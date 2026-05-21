import { callToolModel, listUserModels, type HarnessMessage } from "../llm";
import { routeModels } from "../routing/modelRouter";
import { executeTool } from "../tools";
import { SYSTEM_PROMPT } from "./systemPrompt";

const MAX_TURNS = 15;
const DEFAULT_MISSION =
  "Fait moi un résumé de la page : https://platform.claude.com/docs/en/agents-and-tools/tool-use/define-tools. Génère une rapport au format markdown";

/**
 * Version pedagogique de la boucle ReAct.
 *
 * Ce fichier n'est pas utilise par le CLI. Il sert a lire le mecanisme sans le
 * bruit du fallback modele, des options et des logs de production.
 *
 * ReAct ici veut dire:
 * - Reason: le modele lit l'historique.
 * - Act: il demande un ou plusieurs tool calls.
 * - Observe: la harness execute les outils et reinjecte leurs resultats.
 * - Repeat: on rappelle le modele avec l'historique enrichi.
 */
export async function runReactLoopExplained(mission: string): Promise<string> {
  const models = await listUserModels();
  const route = await routeModels(mission, models);
  const model = route.selectedModel;

  console.log(`Modèle: ${model}`);
  console.log(`Route: ${route.reason}`);
  console.log(`Mission: ${mission}\n`);

  const messages: HarnessMessage[] = [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: mission },
  ];

  for (let turn = 1; turn <= MAX_TURNS; turn++) {
    console.log(`\n── Tour ${turn} ─────────────────────────────`);
    console.log(`Messages envoyés au modèle: ${messages.length}`);
    console.log(`Dernier message:\n${formatMessage(messages.at(-1))}`);

    // 1. Reason: le modele recoit toute la conversation.
    const response = await callToolModel(messages, model);
    console.log(`\nstop_reason: ${response.stop_reason}`);
    console.log(`assistant.content:\n${response.message.content || "(vide)"}`);
    console.log(`tool_uses:\n${formatToolUses(response.tool_uses)}`);

    // 2. On garde le message assistant, y compris ses tool_calls.
    messages.push(response.message);
    console.log(
      `\nRéinjecté dans messages:\n${formatMessage(response.message)}`,
    );

    // 3. End: aucun outil n'est demande, le modele a fini.
    if (response.stop_reason === "end_turn") {
      return response.message.content?.trim() ?? "";
    }

    // 4. Act: le modele demande des outils. Il peut en demander plusieurs.
    if (response.stop_reason === "tool_use") {
      for (const toolCall of response.tool_uses) {
        console.log(
          `\nAppel outil: ${toolCall.name}(${JSON.stringify(toolCall.input)})`,
        );

        // 5. Observe: le code local execute vraiment l'outil.
        const result = await executeTool(toolCall);
        console.log(`Résultat outil:\n${result}`);

        // 6. Le resultat est reinjecte dans le contexte du prochain tour.
        const toolMessage: HarnessMessage = {
          role: "tool",
          tool_call_id: toolCall.id,
          content: result,
        };
        messages.push(toolMessage);
        console.log(`Réinjecté dans messages:\n${formatMessage(toolMessage)}`);
      }

      continue;
    }

    return `Arret: stop_reason non gere (${response.stop_reason}).`;
  }

  return `Arret propre: maximum de ${MAX_TURNS} tours depasse.`;
}

if (import.meta.main) {
  const mission = process.argv.slice(2).join(" ").trim() || DEFAULT_MISSION;
  const finalAnswer = await runReactLoopExplained(mission);

  console.log("\nRéponse finale");
  console.log("─".repeat(14));
  console.log(finalAnswer);
}

function formatToolUses(toolUses: { name: string; input: unknown }[]): string {
  if (toolUses.length === 0) return "(aucun)";
  return toolUses
    .map(
      (toolUse, index) =>
        `${index + 1}. ${toolUse.name} ${JSON.stringify(toolUse.input, null, 2)}`,
    )
    .join("\n");
}

function formatMessage(message: HarnessMessage | undefined): string {
  if (!message) return "(aucun message)";

  if (message.role === "assistant") {
    return JSON.stringify(
      {
        role: message.role,
        content: message.content,
        tool_calls: message.tool_calls,
      },
      null,
      2,
    );
  }

  if (message.role === "tool") {
    return JSON.stringify(
      {
        role: message.role,
        tool_call_id: message.tool_call_id,
        content: message.content,
      },
      null,
      2,
    );
  }

  return JSON.stringify(message, null, 2);
}
