Le calcul de 37 multiplié par 42 donne 1554.


---

## Calculs effectués

- 37 × 42 = 1554  
- 4 ÷ 2 = 2  
- 3 × 3 = 9  
- 26 % de 1500 = 390  

**Résultat maximal :** 1554  
**Résultats ordonnés (croissant) :** [2, 9, 390, 1554]


---

# Rapport : Définition des outils (Tools) - Claude API Docs

## Source
https://platform.claude.com/docs/en/agents-and-tools/tool-use/define-tools

---

## 1. Choix du modèle

- **Claude Opus (4.7)** : recommandé pour les outils complexes et les requêtes ambiguës. Il gère mieux plusieurs outils et demande des clarifications si nécessaire.
- **Claude Haiku** : adapté aux outils simples, mais peut inférer des paramètres manquants.
- Si l'extended thinking est utilisé avec des outils, consulter le guide dédié.

---

## 2. Spécification des outils clients

Les outils clients (schéma Anthropic ou défini par l'utilisateur) sont passés dans le paramètre `tools` au niveau supérieur de la requête API.

### Paramètres requis

| Paramètre | Description |
|-----------|-------------|
| `name` | Nom de l'outil. Doit correspondre à l'expression régulière `^[a-zA-Z0-9_-]{1,64}$` |
| `description` | Description textuelle détaillée de ce que fait l'outil, quand il doit être utilisé et comment il se comporte |
| `input_schema` | Objet JSON Schema définissant les paramètres attendus par l'outil |
| `input_examples` | *(Optionnel)* Tableau d'exemples d'entrées pour aider Claude à comprendre comment utiliser l'outil |

### Propriétés optionnelles

Le document mentionne également les propriétés suivantes : `cache_control`, `strict`, `defer_loading`, `allowed_callers`. Pour plus de détails, voir la **Tool reference**.

---

## 3. Prompt système pour l'utilisation d'outils

Lorsqu'un appel API est effectué avec le paramètre `tools`, l'API construit automatiquement un prompt système spécial à partir des définitions d'outils, de la configuration et du prompt système utilisateur.

Ce prompt indique au modèle :
- Qu'il a accès à un ensemble d'outils pour répondre à la question de l'utilisateur
- Les instructions de formatage :
  - Les paramètres scalaires et chaînes doivent être spécifiés tels quels
  - Les listes et objets doivent utiliser le format JSON
  - Les espaces pour les valeurs de chaîne ne sont pas supprimés
  - La sortie n'est pas censée être du XML valide et est analysée avec des expressions régulières
- Les fonctions disponibles sont fournies au format JSONSchema

---

## 4. Meilleures pratiques pour les définitions d'outils

Pour obtenir les meilleures performances avec Claude lors de l'utilisation d'outils, il est recommandé de suivre les lignes directrices du document (la section détaillée était tronquée dans la source).

---

## Résumé

La documentation explique comment définir des outils pour l'API Claude en spécifiant un schéma JSON, une description claire et des exemples d'entrée. Le choix du modèle dépend de la complexité des outils (Opus pour les cas complexes, Haiku pour les simples). L'API génère automatiquement un prompt système qui guide Claude dans l'utilisation correcte des outils avec les bonnes conventions de formatage.
