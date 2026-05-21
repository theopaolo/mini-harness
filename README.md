# mini-harness

Mini harness ReAct écrite à la main avec Bun et OpenRouter.

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
- `src/llm/openrouter.ts`: appel HTTP OpenRouter, listing des modèles et normalisation des réponses.
- `src/llm/types.ts`: types partagés côté messages, modèles et tours LLM.
- `src/routing/modelRouter.ts`: choix du modèle selon la mission, les capacités OpenRouter et les benchmarks.
- `src/tools/index.ts`: définitions des outils et dispatch vers les implémentations.
- `src/tools/fetchUrl.ts`: implémentation de `fetch_url`.
- `src/tools/runJs.ts`: implémentation de `run_js`.
- `src/tools/saveNote.ts`: implémentation de `save_note`.
- `src/benchmarks/general.ts`: benchmark qualité/coût/latence.
- `src/benchmarks/toolCalling.ts`: benchmark de fiabilité tool calling.
- `notes/rapport.md`: mémoire persistante écrite par `save_note`.

Le benchmark général est lancé avec:

```bash
bun run benchmark
```

## Les trois outils

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
barrière simple adaptée à cette mini harness.

### `save_note(content)`

Ajoute du Markdown à `notes/rapport.md`. Si le fichier existe déjà, une séparation
`---` est ajoutée entre les entrées.

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
LLM -> stop_reason tool_use, outil save_note({ content: "37*42 = 1554" })
outil -> "Note sauvegardée..."
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

## Logs

Chaque appel outil est loggé:

```text
[tour 1] run_js -> 1554
[tour 2] save_note -> Note sauvegardée dans notes/rapport.md (28 caractè
[tour 3] end_turn -> C'est fait, le résultat a été sauvegardé...
```

Le log contient:

- le numéro du tour LLM;
- l'action (`run_js`, `fetch_url`, `save_note`, `end_turn`, etc.);
- les 50 premiers caractères du résultat.

Si le modèle demande plusieurs outils dans le même tour, ils sont tous exécutés
et loggés avec le même numéro de tour.

## Vérifier

```bash
bun run typecheck
```

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
- appel à `save_note` sans écrire réellement de note pendant le benchmark;
- discipline `no_tool`, quand la bonne réponse ne demande aucun outil;
- capacité à répondre après observation du résultat d'un outil.

Le router utilise ensuite ce score comme signal fort pour `tool` et `research`.
