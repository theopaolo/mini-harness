import { AUX_TIMEOUT_MS } from "../cheapModel";
import { callTextModel, type ChatMessage } from "../llm";
import { withTimeout } from "../timeout";
import type { TaskKind } from "./types";

export const TASK_KINDS = [
  "tool",
  "code",
  "research",
  "reasoning",
  "summary",
  "general",
] as const;

const TASK_KIND_GUIDE = `- tool: calcul, transformation de données, parsing. Une opération déterministe à faire exécuter.
- code: écrire, corriger, relire ou analyser du code source, y compris des fichiers ou dossiers locaux du projet.
- research: aller chercher de l'information à l'extérieur du projet, ou comparer des options entre elles.
- reasoning: démonstration, logique, stratégie, architecture. Réfléchir avant d'agir.
- summary: condenser un contenu déjà fourni dans la mission elle-même.
- general: tout le reste, y compris la conversation.

Deux pièges: analyser des fichiers du projet est \`code\`, pas \`research\`; et
\`summary\` suppose que le contenu est déjà là, pas qu'il faut aller le chercher.`;

export type MissionClassification = {
  kind: TaskKind;
  /** D'où vient la décision: ça change ce qu'on peut lui reprocher. */
  source: "modèle" | "mots-clés" | "règle URL";
  note: string | null;
};

/**
 * Classe la mission avec le modèle le moins cher du compte.
 *
 * Remplace une liste de mots-clés écrite à la main, qui se trompait de façon
 * observable: « Analyse le dossier src/ et trouve les problèmes de sécurité » était
 * classée `general` faute de contenir « code » ou « typescript », alors que le même
 * modèle bon marché répond `code` sans hésiter. Une liste de mots-clés ne peut pas
 * suivre le vocabulaire réel des missions.
 *
 * La liste survit uniquement en secours: hors ligne ou sur échec d'appel, il faut
 * bien router quand même.
 */
export async function classifyMission(
  mission: string,
  cheapModel: string | null,
): Promise<MissionClassification> {
  // Une URL implique structurellement un fetch_url, donc `research` et ses bonus
  // (parallel_tool_calls, grand contexte). Mesuré: le modèle répond volontiers
  // `summary` sur « Résume https://… », ce qui est vrai sur le fond mais fait
  // router à côté. Cette règle est déterministe, autant ne pas la déléguer.
  if (/\bhttps?:\/\//.test(mission)) {
    return { kind: "research", source: "règle URL", note: null };
  }

  if (!cheapModel) {
    return {
      kind: classifyMissionByKeywords(mission),
      source: "mots-clés",
      note: "aucun modèle disponible",
    };
  }

  const messages: ChatMessage[] = [
    {
      role: "system",
      content:
        "Tu classes une mission dans une seule catégorie. " +
        `Catégories possibles :\n${TASK_KIND_GUIDE}\n` +
        "Tu réponds par UN SEUL mot : le nom exact de la catégorie. " +
        "Pas de phrase, pas de ponctuation, pas d'explication.",
    },
    { role: "user", content: `Mission :\n${mission}\n\nCatégorie ?` },
  ];

  try {
    const result = await withTimeout(
      callTextModel(messages, cheapModel),
      AUX_TIMEOUT_MS,
      `classification mission ${cheapModel}`,
    );
    if (Bun.env.HARNESS_CLASSIFY_DEBUG) {
      console.log(
        `[classify-debug] modèle=${cheapModel} brut="${result.content}"`,
      );
    }

    const kind = normalizeTaskKind(result.content);
    if (kind) return { kind, source: "modèle", note: null };

    return {
      kind: classifyMissionByKeywords(mission),
      source: "mots-clés",
      note: "réponse du modèle inexploitable",
    };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return {
      kind: classifyMissionByKeywords(mission),
      source: "mots-clés",
      note: `classification en échec (${reason})`,
    };
  }
}

/** Exporté pour les tests: la tolérance aux réponses bavardes est fragile. */
export function normalizeTaskKind(raw: string): TaskKind | null {
  const lower = raw.trim().toLowerCase();

  const exact = TASK_KINDS.find((kind) => kind === lower);
  if (exact) return exact;

  for (const kind of TASK_KINDS) {
    if (new RegExp(`(?:^|[^a-z])${kind}(?![a-z])`).test(lower)) return kind;
  }
  return null;
}

/**
 * Ancienne classification par mots-clés. Secours uniquement: elle ne voit que le
 * vocabulaire qu'on a pensé à lister, ce qui vieillit à chaque nouvelle formulation.
 */
export function classifyMissionByKeywords(mission: string): TaskKind {
  const text = mission.toLowerCase();

  if (/\bhttps?:\/\//.test(text)) return "research";
  if (matches(text, ["recherche", "compare", "comparatif", "rapport"])) {
    return "research";
  }
  if (matches(text, ["résume", "resume", "summary", "synthèse"])) {
    return "summary";
  }
  if (
    matches(text, [
      "calcule",
      "calcul",
      "addition",
      "multiplie",
      "json",
      "parser",
      "parse",
      "transforme",
      "convertis",
    ])
  ) {
    return "tool";
  }
  if (
    matches(text, [
      "code",
      "typescript",
      "javascript",
      "bug",
      "fonction",
      "implémente",
      "implemente",
      "refactor",
    ])
  ) {
    return "code";
  }
  if (
    matches(text, [
      "raisonne",
      "raisonnement",
      "logique",
      "prouve",
      "démontre",
      "demontre",
      "stratégie",
      "strategie",
      "architecture",
    ])
  ) {
    return "reasoning";
  }

  return "general";
}

function matches(text: string, needles: string[]): boolean {
  return needles.some((needle) => text.includes(needle));
}
