/**
 * Rafraîchit le cache des scores publics et montre la couverture réelle.
 *
 * `bun run benchmarks:refresh`
 *
 * Utile parce que la couverture est partielle: un modèle sorti cette semaine n'est
 * pas encore classé, et c'est exactement là qu'on aimerait un score. Cette commande
 * dit lesquels de tes modèles sont couverts, et lesquels retombent sur les
 * heuristiques de nom.
 */
import { listUserModels } from "../llm";
import { findModelScores, loadBenchmarkIndex } from "./benchmarkSource";

const index = await loadBenchmarkIndex({ refresh: true });

console.log(`Scores : ${index.origin}${index.note ? ` — ${index.note}` : ""}`);
console.log(`Fraîcheur annoncée : ${index.asOf ?? "inconnue"}`);
console.log(`Modèles classés : ${index.bySlug.size}`);

if (index.bySlug.size === 0) process.exit(1);

const models = await listUserModels();
const toolCapable = models.filter((model) =>
  model.supportedParameters.includes("tools"),
);

const scored = toolCapable
  .map((model) => ({ model, scores: findModelScores(index, model) }))
  .filter((entry) => entry.scores);

const percent = Math.round((scored.length / toolCapable.length) * 100);
console.log(
  `\nModèles outillés de ta clé : ${toolCapable.length}, dont ${scored.length} classés (${percent}%).`,
);
console.log(
  `Les ${toolCapable.length - scored.length} autres retombent sur les heuristiques de nom.`,
);

console.log("\nMeilleurs scores agentic (ce qui compte pour une boucle ReAct) :");
for (const entry of scored
  .sort((a, b) => (b.scores?.agenticIndex ?? 0) - (a.scores?.agenticIndex ?? 0))
  .slice(0, 10)) {
  const s = entry.scores!;
  console.log(
    `  ${entry.model.id.padEnd(42)} agentic=${fmt(s.agenticIndex)} coding=${fmt(s.codingIndex)} intel=${fmt(s.intelligenceIndex)}`,
  );
}

function fmt(value: number | null): string {
  return (value === null ? "—" : String(value)).padEnd(6);
}
