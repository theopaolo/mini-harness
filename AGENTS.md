# AGENTS.md

Documentation de l'agent de titi.

## Rôle

Le harness est un agent ReAct généraliste écrit à la main avec Bun et OpenRouter.
Il reçoit une mission utilisateur en texte libre, choisit un modèle adapté, et
boucle `Reason → Act → Observe` jusqu'à produire une réponse finale.

Les outils disponibles :

- `fetch_url(url)` — récupère et nettoie une page HTTP(S).
- `read_file(path)` — lit un fichier texte du cwd (chemins relatifs, refuse `..` et dotfiles).
- `run_js(code)` — exécute du JavaScript déterministe via `Bun.spawn`.
- `write_document(filename, content)` — écrit un livrable Markdown horodaté dans `documents/`.
- `memory_read()` / `memory_append(content)` / `memory_rewrite(content)` — mémoire de travail dans `notes/memory.md`.

Le détail de la boucle est dans `README.md`.

## Choix du modèle

`src/routing/modelRouter.ts` classe les modèles accessibles par la clé. Les
signaux, du plus au moins prioritaire :

1. `model-bench/tool-benchmark.json` — fiabilité mesurée du tool calling sur les
   schémas d'outils de cette harness. Signal fort pour `tool` et `research`.
2. `model-bench/benchmark.md` — qualité/latence/coût mesurés à la main.
3. `GET /api/v1/benchmarks` — index publics `coding` / `agentic` / `intelligence`
   (0-100), rafraîchis automatiquement et mis en cache 24 h. Couvrent les modèles
   jamais mesurés localement.
4. Heuristiques de nom (`isCoderModel`, `isSmallModel`, `kimi`) — dernier recours
   pour un modèle trop récent pour être classé.

`bun run benchmarks:refresh` rafraîchit le cache et affiche la couverture.
`HARNESS_NO_LIVE_BENCHMARKS=1` désactive les scores publics pour un routage
reproductible. Détails dans `README.md`.

## Skills

Un **skill** est un fichier `skills/<nom>/SKILL.md` qui encode une expertise
spécifique. Le harness ne charge un skill que si la mission le justifie : ça
évite de polluer le system prompt avec des règles non pertinentes.

### Cycle de vie

1. À chaque mission, `loadSkillCatalog()` scanne `skills/*/SKILL.md` et parse le
   frontmatter YAML (`name`, `description`).
2. `detectSkill()` envoie la mission + le catalogue à un modèle rapide via
   `callTextModel`. Le modèle renvoie le nom du skill pertinent, ou `none`.
3. Si un skill est détecté, son corps est appendé au `SYSTEM_PROMPT` de base.
   Sinon le system prompt reste générique.
4. Un log `── Détection skill ──` indique le modèle routeur utilisé et le skill
   chargé (ou `aucun skill détecté`, avec la raison si la détection a échoué).

Le mécanisme est provider-agnostic : l'injection se fait dans un message
standard `role: system`, aucun format propriétaire.

Implémentation : `src/skills.ts`. Intégration : `src/app/harness.ts` (avant la
boucle ReAct).

### Skills disponibles

- **[code-review](skills/code-review/SKILL.md)** — analyse de code source :
  sécurité, robustesse, maintenabilité, performance. Format de sortie strict
  (sévérité, extrait, suggestion).
- **[tech-report](skills/tech-report/SKILL.md)** — rapport technique d'un outil,
  framework ou service. Format en 5 sections (objectif, architecture, cas
  d'usage, limites, verdict).
- **[data-analysis](skills/data-analysis/SKILL.md)** — analyse de données
  chiffrées ou de réponses d'API JSON. Calcule avec `run_js`, identifie
  tendances et anomalies.
- **[redaction](skills/redaction/SKILL.md)** — rédaction et reformulation :
  catalogue de tics d'écriture IA à éviter. Nettement plus gros que les autres
  (~17k caractères), donc coûteux en tokens dès qu'il est chargé.

### Ajouter un skill

1. Créer `skills/<mon-skill>/SKILL.md`.
2. Frontmatter YAML obligatoire :
   ```yaml
   ---
   name: mon-skill
   description: "Utiliser quand … Triggers : … Ne PAS utiliser pour : …"
   ---
   ```
3. Corps markdown libre, mais l'expérience montre que cette structure marche
   bien : `## Ton rôle`, `## Méthode`, `## Format de sortie`, `## Ce que tu ne
   fais PAS`.
4. C'est tout — le détecteur le pickera automatiquement.

### Override de la détection

- `HARNESS_SKILL_DETECT_MODEL=<id>` force un modèle spécifique pour la détection
  (utile pour tester, ou pour imposer une variante `:free`). Par défaut,
  `pickDetectionModel` prend le modèle **le moins cher** accessible par la clé :
  la tâche est de renvoyer un seul mot, et payer le modèle le mieux classé pour ça
  coûte ~500x plus cher sans gain mesuré. Les `:free` sont écartées (quotas
  imprévisibles), et le vivier n'exige pas `tools` puisque la détection passe par
  `callTextModel`. Détails et mesures dans `README.md`.
- Pas de flag CLI pour activer/désactiver un skill : la détection est purement
  basée sur le texte de la mission. C'est le design voulu.
