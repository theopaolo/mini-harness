# titi

Harness ReAct écrite à la main avec Bun et OpenRouter.

Le titi est un petit singe d'Amérique du Sud. Petit, curieux, et il ne lâche pas
sa branche: c'est à peu près le cahier des charges.

Pas de LangChain, pas de LlamaIndex, pas de librairie agent. Le but est de voir
ce qu'une harness fait vraiment:

1. envoyer la mission et l'historique au modèle;
2. recevoir soit une réponse finale, soit un ou plusieurs appels outil;
3. exécuter les outils localement;
4. réinjecter les résultats dans l'historique;
5. recommencer jusqu'à `end_turn` ou 15 tours maximum.

## Lancer

```bash
bun install
bun run index.ts "Calcule 37*42 avec run_js puis sauvegarde le résultat dans une note"
```

Mode debug:

```bash
bun run index.ts --debug "Calcule 37*42 avec run_js"
```

Mode pas-à-pas:

```bash
bun run debug "Calcule 37*42 avec run_js"
```

Le mode debug affiche à chaque tour:

- les messages envoyés au modèle;
- la sortie modèle (`stop_reason`, contenu, tool calls);
- chaque résultat outil;
- le message `role: "tool"` réinjecté dans l'historique.

Options utiles:

```bash
bun run index.ts --debug-full "mission"
bun run index.ts --debug --max-turns 3 "mission"
bun run index.ts --debug --model qwen/qwen3-coder-next "mission"
```

Le script utilise `OPEN_ROUTER_API` depuis `.env.local`.

Optionnellement, force un modèle:

```bash
HARNESS_MODEL="~anthropic/claude-sonnet-latest" bun run index.ts "ta mission"
```

Sans `HARNESS_MODEL`, la harness appelle `OpenRouter /models/user` et essaie les
modèles retournés par ta clé, dans l'ordre fourni par OpenRouter. Si un modèle
est exposé par le compte mais bloqué par les réglages de confidentialité
OpenRouter, elle essaie le suivant.

## Les fichiers importants

- `index.ts`: entrée CLI. Transforme les arguments en mission utilisateur.
- `src/index.ts`: export public de la harness.
- `src/app/harness.ts`: boucle ReAct, gestion de `tool_use` et `end_turn`.
- `src/app/reactLoop.explained.ts`: version pédagogique minimale de la boucle ReAct.
- `src/app/systemPrompt.ts`: prompt système de la harness.
- `src/timeout.ts`: `withTimeout`, partagé par la boucle et la détection de skill.
- `src/llm/openrouter.ts`: appel HTTP OpenRouter, listing des modèles et normalisation des réponses.
- `src/llm/types.ts`: types partagés côté messages, modèles et tours LLM.
- `src/routing/modelRouter.ts`: choix du modèle selon la mission, les capacités OpenRouter et les benchmarks.
- `src/routing/benchmarkSource.ts`: scores publics OpenRouter, cache disque et jointure par slug.
- `src/routing/refreshBenchmarks.ts`: `bun run benchmarks:refresh`, rafraîchit le cache et affiche la couverture.
- `src/skills.ts`: chargement du catalogue `skills/*/SKILL.md` et détection du skill.
- `src/tools/index.ts`: définitions des outils et dispatch vers les implémentations.
- `src/tools/fetchUrl.ts`: implémentation de `fetch_url`.
- `src/tools/readFile.ts`: implémentation de `read_file`.
- `src/tools/runJs.ts`: implémentation de `run_js`.
- `src/tools/writeDocument.ts`: implémentation de `write_document`.
- `src/tools/memory.ts`: implémentation de `memory_read`, `memory_append`, `memory_rewrite`.
- `src/benchmarks/general.ts`: benchmark qualité/coût/latence.
- `src/benchmarks/toolCalling.ts`: benchmark de fiabilité tool calling.
- `notes/memory.md`: mémoire de travail, écrite par les outils `memory_*`.
- `documents/`: livrables finaux, écrits par `write_document`.

Le benchmark général est lancé avec:

```bash
bun run benchmark
```

## Les outils

### `fetch_url(url)`

Récupère une URL HTTP(S), lit le texte, extrait le contenu lisible du HTML avec
`parse5` si nécessaire, retire le bruit courant (navigation, cookies, footer),
puis tronque à 5000 caractères.

### `run_js(code)`

Lance un sous-processus Bun:

```ts
Bun.spawn(["bun", "--print", code])
```

Il n'utilise pas `eval()` natif dans la harness. Le modèle doit fournir une
expression ou laisser le résultat utile en dernière expression:

```js
const xs = [1, 2, 3];
xs.reduce((a, b) => a + b, 0)
```

Pour rester dans son rôle de calculateur/transformateur, `run_js` refuse les
opérations réseau, fichier, process, import dynamique, `require`, `eval` et
constructeur `Function`. Ce n'est pas une sandbox de sécurité complète, mais une
barrière simple adaptée à titi.

### `read_file(path)`

Lit un fichier texte sous le cwd, tronqué à 5000 caractères. Refuse les chemins
qui sortent du cwd et les fichiers cachés.

### `write_document(filename, content)`

Écrit un livrable Markdown dans `documents/`. Un timestamp est ajouté au nom
(`rapport.md` devient `rapport_2026-05-21T172757.md`), donc deux appels ne
s'écrasent jamais.

### `memory_read()` / `memory_append(content)` / `memory_rewrite(content)`

Mémoire de travail dans `notes/memory.md`: le modèle accumule ses observations
avec `memory_append`, les relit avec `memory_read`, et peut condenser le tout
avec `memory_rewrite`. À distinguer de `write_document`, qui produit le livrable
final.

## Le coeur de la boucle

La boucle ReAct veut dire:

- Reason: le modèle regarde la mission et l'historique.
- Act: s'il manque une action concrète, il demande un outil.
- Observe: la harness exécute l'outil et remet le résultat dans l'historique.
- Repeat: le modèle relit l'historique enrichi et continue.

Pour voir la version pédagogique en action:

```bash
bun src/app/reactLoop.explained.ts
bun src/app/reactLoop.explained.ts "Calcule 37*42 avec run_js"
```

Ce fichier affiche chaque tour, le message assistant, les tool calls, le résultat
outil et le message `role: "tool"` réinjecté.

Dans `src/app/harness.ts`, le coeur tient dans cette logique:

```ts
for (let turnNumber = 1; turnNumber <= maxTurns; turnNumber++) {
  const turn = await callToolModel(messages, model);
  messages.push(turn.message);

  if (turn.stop_reason === "tool_use") {
    for (const toolUse of turn.tool_uses) {
      const result = await executeTool(toolUse);
      messages.push({
        role: "tool",
        tool_call_id: toolUse.id,
        content: result,
      });
    }
    continue;
  }

  if (turn.stop_reason === "end_turn") {
    return turn.message.content ?? "";
  }
}
```

OpenRouter renvoie une API compatible OpenAI (`finish_reason: "tool_calls"` ou
`"stop"`). La harness normalise cela en deux états plus pédagogiques:

- `tool_use`: le modèle demande un ou plusieurs outils;
- `end_turn`: le modèle rend sa réponse finale.

## Exemple mental

Mission:

```text
Calcule 37*42 avec run_js puis sauvegarde le résultat.
```

Tour 1:

```text
messages = [system, user]
LLM -> stop_reason tool_use, outil run_js({ code: "37 * 42" })
```

La harness exécute du vrai code:

```text
Bun.spawn(["bun", "--print", "37 * 42"])
outil -> "1554"
```

Puis elle ajoute le résultat:

```text
messages = [system, user, assistant(tool_call), tool("1554")]
```

Tour 2:

```text
LLM -> stop_reason tool_use, outil memory_append({ content: "37*42 = 1554" })
outil -> "Note ajoutée à notes/memory.md..."
```

Tour 3:

```text
LLM -> stop_reason end_turn, réponse finale
```

Point important: le modèle ne fait pas le calcul. Il décide qu'un calcul est
nécessaire, puis `run_js` le fait avec du code réel. C'est exactement l'intérêt
de l'outil: remplacer une capacité fragile du LLM par une opération déterministe.

## Routage du modèle

Avant le premier tour, `src/routing/modelRouter.ts` choisit un modèle.

Il utilise trois sources:

- la mission utilisateur;
- `OpenRouter /models/user`, qui indique les modèles accessibles par la clé et leurs capacités (`tools`, `reasoning`, `parallel_tool_calls`, etc.);
- `OpenRouter /benchmarks`, qui donne des scores publics par modèle, mis à jour sans intervention (voir plus bas);
- `model-bench/benchmark.md`, qui donne la qualité, la latence et le coût mesurés sur quelques tâches;
- `model-bench/tool-benchmark.json`, qui mesure la fiabilité réelle du tool calling.

Exemples de routage:

```text
Calcule 37*42...
=> qwen/qwen3-coder-next
```

Modèle rapide et fiable en tool calling: suffisant pour décider d'appeler `run_js`.

```text
Recherche les 3 meilleurs outils...
=> moonshotai/kimi-k2.6
```

Mission plus longue, probablement plusieurs appels outils, contexte et synthèse:
modèle plus robuste avec `parallel_tool_calls`.

```text
Implémente une fonction TypeScript...
=> qwen/qwen3-coder-next
```

Mission code: le routeur favorise les modèles spécialisés code.

Ce routeur reste volontairement simple. Ce n'est pas une vérité absolue, c'est
une politique lisible que tu peux modifier.

### Scores publics automatiques

Il sort des modèles chaque mois. Écrire à la main « ce modèle est bon en code »
vieillit très vite, donc le routeur lit des scores publics par modèle.

`GET /api/v1/benchmarks?source=artificial-analysis` renvoie, par modèle, trois
index sur 100 (Artificial Analysis, via OpenRouter):

| Index                | Utilisé pour                  |
| -------------------- | ----------------------------- |
| `coding_index`       | missions `code`               |
| `agentic_index`      | missions `tool` et `research` |
| `intelligence_index` | `reasoning`, `summary`, `general` |

`agentic_index` est l'analogue public le plus proche de ce qu'une boucle ReAct
demande vraiment, d'où son usage pour les missions outillées.

Deux détails vérifiés, pas supposés:

- `/models/user` ne renvoie **pas** le champ `benchmarks` (le `/models` public,
  si). Il faut donc une deuxième requête.
- la jointure se fait sur `canonical_slug` (`anthropic/claude-opus-5-20260723`),
  pas sur `id`. Sur 125 lignes de scores, le slug daté en apparie 111 contre 33
  pour l'`id`, d'où le repli `canonical_slug` puis `id`.

Ordre de priorité pour la note qualité:

1. `model-bench/benchmark.md` si le modèle y a une ligne — c'est une mesure faite
   à la main sur cette harness, plus pertinente qu'un index générique;
2. l'index public sinon;
3. la valeur par défaut de 3.

Même logique pour le bonus d'affinité: avec un index on l'utilise, sans index on
retombe sur les heuristiques de nom (`isCoderModel`, `isSmallModel`, `kimi`).
Elles ne servent plus que de secours pour les modèles trop récents pour être
classés.

**La couverture est partielle**: environ 42% des modèles outillés d'une clé sont
classés. Pour voir où tu en es:

```bash
bun run benchmarks:refresh
```

```text
Scores : réseau
Fraîcheur annoncée : 2026-07-25T00:01:00.805Z
Modèles classés : 125

Modèles outillés de ta clé : 274, dont 115 classés (42%).
Les 159 autres retombent sur les heuristiques de nom.
```

Les scores sont mis en cache dans `model-bench/openrouter-benchmarks.json`
(gitignoré, régénérable). Ordre de résolution: cache frais → réseau → cache
périmé → rien. Le cran « cache périmé » compte: une mission reste lançable hors
ligne, et le routage ne dépend pas d'une requête qui peut échouer.

La ligne `Route:` indique toujours d'où viennent les scores:

```text
Route: code: kimi-k2.6 (tools, reasoning, parallel tools; benchmark 5/5, 2553ms,
€0.00224; tool 100%; scores réseau au 2026-07-25, coding 61.8/100)
```

Variables d'environnement:

- `HARNESS_BENCHMARK_TTL_HOURS`: durée de vie du cache (défaut 24).
- `HARNESS_NO_LIVE_BENCHMARKS=1`: ignore complètement les scores publics et
  revient aux heuristiques. Utile pour un routage reproductible — sinon la même
  mission peut changer de modèle d'un mois à l'autre.

`model-bench/tool-benchmark.json` garde tout son intérêt: `agentic_index` mesure
une aptitude générique, alors que le tool-benchmark mesure si le modèle appelle
*tes sept schémas d'outils* correctement dans *cette* harness. Ce n'est pas la
même question, et l'index public ne peut pas y répondre.

## Skills

Avant le premier tour, la harness charge le catalogue `skills/*/SKILL.md` et
demande à un petit modèle de routage de choisir le skill le plus pertinent pour
la mission (ou `none`). Le corps du skill choisi est concaténé au prompt système
via `buildSystemPrompt` (voir `src/skills.ts`).

Format d'un skill (frontmatter YAML + corps Markdown):

```md
---
name: code-review
description: "Use when mission need look at, review, or audit source code. Triggers: 'review', 'audit', 'quality'. Do NOT use for: summarize article."
---

# Code Review

## Your Role
...
```

Le nom du fichier compte: seul `skills/<nom>/SKILL.md` est scanné. Un fichier
nommé autrement est silencieusement ignoré.

Skills livrés:

- `code-review`: audit de code (sécurité, robustesse, perfs) — 585 chars.
- `data-analysis`: exploration et synthèse de jeux de données — 1076 chars.
- `tech-report`: génération de rapports techniques structurés — 948 chars.
- `redaction`: rédaction et reformulation — 17265 chars. Nettement plus gros que
  les autres: il est injecté en entier dans le prompt système dès qu'il est
  choisi, ce qui se paie en tokens à chaque tour.

Au démarrage, la console affiche:

```text
── Détection skill ──────────────────────────────
Mission analysée : "Analyse le dossier src/..."
Routeur skill : inclusionai/ling-2.6-flash
Skill chargé : code-review (585 chars injectés)
```

### Le routeur de skills prend le modèle le moins cher

La détection consiste à répondre **un mot** parmi quatre. Utiliser pour ça le
modèle le mieux classé — l'ancien comportement — payait un prix de pointe pour
une classification triviale: mesuré, `claude-opus-5` coûte ~500x le modèle le
moins cher du compte pour exactement le même travail.

| Modèle                       | Coût par détection |
| ---------------------------- | ------------------ |
| `anthropic/claude-opus-5`    | $0.00362           |
| `moonshotai/kimi-k2.6`       | $0.00044           |
| `inclusionai/ling-2.6-flash` | $0.0000072         |

`pickDetectionModel` prend donc le moins cher, et non le « meilleur petit
modèle ». Ce n'est pas une intuition: sur les quatre skills livrés, les modèles
les moins chers classent correctement, et `intelligence_index` ne prédit pas
cette tâche à cette échelle — le moins cher du catalogue (index 14,1) fait 6/6 là
où un modèle à index 5,5 se trompe. Le seul mode d'échec observé est l'excès de
zèle: charger un skill là où `none` était attendu. Ça coûte des tokens, ça ne
fausse pas la réponse.

Deux exclusions volontaires:

- le vivier n'exige pas `tools`. La détection passe par `callTextModel`, sans
  outils, ce qui donne accès à des modèles bien moins chers que ceux retenus pour
  la boucle;
- les variantes `:free` sont écartées malgré un coût nul: leurs quotas les rendent
  imprévisibles, et à $7e-6 l'appel l'économie ne vaut pas le risque. Pour en
  forcer une, passe par `HARNESS_SKILL_DETECT_MODEL`.

La détection est bornée à 20 s. Un modèle qui dépasse ça pour produire un mot est
inadapté, et sans cette borne il bloquerait le démarrage: certains modèles bon
marché mais lents mettent plus de 10 s.

Variables d'environnement utiles:

- `HARNESS_SKILL_DETECT_MODEL`: force le modèle utilisé pour la détection.
- `HARNESS_SKILL_DEBUG=1`: log la réponse brute du routeur de skills.

Ajouter un skill = créer `skills/<nom>/SKILL.md` avec un `name` et une
`description` claire (les déclencheurs guident le routeur). Aucun code à
modifier.

## Logs

Chaque appel outil est loggé:

```text
[tour 1] run_js -> 1554
[tour 2] memory_append -> Note ajoutée à notes/memory.md (14 caractères, to
[tour 3] end_turn -> C'est fait, le résultat a été sauvegardé...
```

Le log contient:

- le numéro du tour LLM;
- l'action (`run_js`, `fetch_url`, `memory_append`, `end_turn`, etc.);
- les 50 premiers caractères du résultat.

Si le modèle demande plusieurs outils dans le même tour, ils sont tous exécutés
et loggés avec le même numéro de tour.

## Vérifier

```bash
bun run typecheck
bun run test
```

Les tests couvrent les parties pures et piégeuses, sans appel réseau:

- `src/skills.test.ts`: chargement du catalogue, frontmatter replié sur plusieurs
  lignes, tolérance de `normalizeChoice` aux réponses bavardes du routeur, et choix
  du modèle de détection le moins cher.
- `src/tools/index.test.ts`: outil inconnu, arguments JSON invalides, garde-fous
  de `run_js`.
- `src/tools/memory.test.ts`: appends concurrents (le harness exécute les tool
  calls d'un même tour en parallèle).
- `src/routing/modelRouter.test.ts`: classification de mission, parsing du
  benchmark (cellules illisibles incluses) et priorité entre scores mesurés,
  scores publics et heuristiques.
- `src/routing/benchmarkSource.test.ts`: jointure par slug et repli cache frais →
  réseau → cache périmé → rien.

## Benchmark tool calling

Le benchmark général `model-bench/benchmark.md` mesure surtout qualité, coût et
latence. Pour une harness ReAct, il faut aussi mesurer la fiabilité réelle des
tool calls.

Lance:

```bash
bun run tool-benchmark
```

Par défaut, le script teste seulement les modèles dont OpenRouter déclare le
paramètre `tools`.

Options utiles:

```bash
bun run tool-benchmark -- --limit 2
bun run tool-benchmark -- --all
bun run tool-benchmark -- --models qwen/qwen3-coder-next,deepseek/deepseek-v4-pro
```

Le script écrit:

- `model-bench/tool-benchmark.json`: lu automatiquement par `src/routing/modelRouter.ts`;
- `model-bench/tool-benchmark.md`: résumé lisible.

Les tâches testées couvrent:

- appel simple à `run_js`;
- plusieurs `run_js` dans le même tour;
- appel à `memory_append` sans écrire réellement de note pendant le benchmark;
- discipline `no_tool`, quand la bonne réponse ne demande aucun outil;
- capacité à répondre après observation du résultat d'un outil.

Le router utilise ensuite ce score comme signal fort pour `tool` et `research`.
