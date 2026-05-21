# AGENTS.md

Documentation de l'agent du mini-harness.

## Rôle

Le harness est un agent ReAct généraliste écrit à la main avec Bun et OpenRouter.
Il reçoit une mission utilisateur en texte libre, choisit un modèle adapté, et
boucle `Reason → Act → Observe` jusqu'à produire une réponse finale.

Quatre outils sont disponibles :

- `fetch_url(url)` — récupère et nettoie une page HTTP(S).
- `read_file(path)` — lit un fichier texte du cwd (chemins relatifs, refuse `..` et dotfiles).
- `run_js(code)` — exécute du JavaScript déterministe via `Bun.spawn`.
- `save_note(content)` — append Markdown dans `notes/rapport.md`.

Le détail de la boucle est dans `README.md`.

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
4. Un log `── Détection skill ──` indique le skill chargé (ou `aucun skill
   détecté`).

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
  (utile pour tester ou pour aller plus vite). Par défaut, le harness prend un
  petit modèle du catalogue (`mini`/`haiku`/`8b`) ou à défaut le premier de la
  liste.
- Pas de flag CLI pour activer/désactiver un skill : la détection est purement
  basée sur le texte de la mission. C'est le design voulu.
