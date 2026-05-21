import { parse, type DefaultTreeAdapterTypes } from "parse5";

const MAX_FETCH_CHARS = 5000;

type HtmlNode = DefaultTreeAdapterTypes.Node;
type HtmlElement = DefaultTreeAdapterTypes.Element;

export const fetchUrlDefinition = {
  type: "function",
  function: {
    name: "fetch_url",
    description:
      "Récupère le contenu textuel d'une URL. Pour le HTML, extrait le contenu lisible avec parse5 et retire le bruit courant. Retourne le texte tronqué à 5000 caractères.",
    parameters: {
      type: "object",
      properties: {
        url: {
          type: "string",
          description: "URL HTTP ou HTTPS à récupérer.",
        },
      },
      required: ["url"],
      additionalProperties: false,
    },
  },
} as const;

export async function fetchUrl(url: string): Promise<string> {
  const parsed = new URL(url);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("seules les URL http(s) sont autorisées");
  }

  const response = await fetch(parsed);
  const raw = await response.text();
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${truncate(raw, 500)}`);
  }

  const contentType = response.headers.get("content-type") ?? "";
  const text = contentType.includes("text/html") ? htmlToText(raw) : raw;
  return truncate(text.trim(), MAX_FETCH_CHARS);
}

function htmlToText(html: string): string {
  const document = parse(html);
  const title = extractTitle(document);
  const contentRoot = findReadableRoot(document);
  const text = normalizeExtractedText(extractText(contentRoot));

  return [title ? `Title: ${title}` : "", text].filter(Boolean).join("\n\n");
}

function truncate(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return text.slice(0, maxChars);
}

const SKIPPED_TAGS = new Set([
  "script",
  "style",
  "noscript",
  "svg",
  "canvas",
  "iframe",
  "template",
  "form",
  "input",
  "button",
  "select",
  "textarea",
  "nav",
  "footer",
  "aside",
]);

const BLOCK_TAGS = new Set([
  "address",
  "article",
  "blockquote",
  "dd",
  "details",
  "dialog",
  "div",
  "dl",
  "dt",
  "fieldset",
  "figcaption",
  "figure",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "header",
  "hr",
  "li",
  "main",
  "ol",
  "p",
  "pre",
  "section",
  "summary",
  "table",
  "tbody",
  "td",
  "tfoot",
  "th",
  "thead",
  "tr",
  "ul",
]);

const NOISE_ATTR_PATTERN =
  /(?:^|[\s_-])(ad|ads|banner|breadcrumb|cookie|cookies|consent|modal|newsletter|pagination|promo|search|sidebar|site-footer|site-header|skip-link|table-of-contents|toc)(?:$|[\s_-])/i;

const NOISE_LINES = new Set([
  "Loading...",
  "Copy page",
  "Cookie settings",
  "Customize Cookie Settings",
  "Accept All Cookies",
  "Reject All Cookies",
]);

function extractTitle(document: HtmlNode): string {
  const title = findFirstElement(document, (element) => element.tagName === "title");
  return title ? normalizeInlineText(extractText(title)) : "";
}

function findReadableRoot(document: HtmlNode): HtmlNode {
  const candidates = findElements(document, isReadableRootCandidate);
  const root = bestTextCandidate(candidates);
  if (root) return root;

  return findFirstElement(document, (element) => element.tagName === "body") ?? document;
}

function isReadableRootCandidate(element: HtmlElement): boolean {
  if (element.tagName === "main" || element.tagName === "article") return true;
  return getAttr(element, "role")?.toLowerCase() === "main";
}

function bestTextCandidate(candidates: HtmlElement[]): HtmlElement | undefined {
  let best: HtmlElement | undefined;
  let bestLength = 0;

  for (const candidate of candidates) {
    const length = normalizeInlineText(extractText(candidate)).length;
    if (length > bestLength) {
      best = candidate;
      bestLength = length;
    }
  }

  return bestLength >= 120 ? best : undefined;
}

function extractText(node: HtmlNode): string {
  const parts: string[] = [];
  collectText(node, parts);
  return parts.join("");
}

function collectText(node: HtmlNode, parts: string[]): void {
  if (isTextNode(node)) {
    appendInlineText(parts, node.value);
    return;
  }

  if (!hasChildNodes(node)) return;

  if (isElement(node)) {
    if (shouldSkipElement(node)) return;

    if (node.tagName === "br") {
      parts.push("\n");
      return;
    }

    if (node.tagName === "li") parts.push("\n- ");
    else if (BLOCK_TAGS.has(node.tagName)) parts.push("\n");
  }

  for (const child of node.childNodes) {
    collectText(child, parts);
  }

  if (isElement(node) && BLOCK_TAGS.has(node.tagName)) {
    parts.push("\n");
  }
}

function shouldSkipElement(element: HtmlElement): boolean {
  if (SKIPPED_TAGS.has(element.tagName)) return true;
  if (hasAttr(element, "hidden")) return true;
  if (getAttr(element, "aria-hidden")?.toLowerCase() === "true") return true;

  const id = getAttr(element, "id") ?? "";
  const className = getAttr(element, "class") ?? "";
  return NOISE_ATTR_PATTERN.test(id) || NOISE_ATTR_PATTERN.test(className);
}

function normalizeExtractedText(text: string): string {
  const lines = text
    .replace(/\u00a0/g, " ")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n[ \t]+/g, "\n")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !NOISE_LINES.has(line));

  return dedupeAdjacent(lines).join("\n");
}

function normalizeInlineText(text: string): string {
  return text.replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim();
}

function dedupeAdjacent(lines: string[]): string[] {
  const deduped: string[] = [];
  for (const line of lines) {
    if (deduped[deduped.length - 1] !== line) deduped.push(line);
  }
  return deduped;
}

function appendInlineText(parts: string[], value: string): void {
  const text = value.replace(/\s+/g, " ").trim();
  if (!text) return;

  const previous = parts[parts.length - 1] ?? "";
  if (previous && !/\s$/.test(previous)) parts.push(" ");
  parts.push(text);
}

function findFirstElement(
  node: HtmlNode,
  predicate: (element: HtmlElement) => boolean,
): HtmlElement | undefined {
  if (isElement(node) && predicate(node)) return node;
  if (!hasChildNodes(node)) return undefined;

  for (const child of node.childNodes) {
    const match = findFirstElement(child, predicate);
    if (match) return match;
  }

  return undefined;
}

function findElements(
  node: HtmlNode,
  predicate: (element: HtmlElement) => boolean,
  matches: HtmlElement[] = [],
): HtmlElement[] {
  if (isElement(node) && predicate(node) && !shouldSkipElement(node)) {
    matches.push(node);
  }

  if (!hasChildNodes(node) || (isElement(node) && shouldSkipElement(node))) {
    return matches;
  }

  for (const child of node.childNodes) {
    findElements(child, predicate, matches);
  }

  return matches;
}

function getAttr(element: HtmlElement, name: string): string | undefined {
  return element.attrs.find((attr) => attr.name === name)?.value;
}

function hasAttr(element: HtmlElement, name: string): boolean {
  return element.attrs.some((attr) => attr.name === name);
}

function isElement(node: HtmlNode): node is HtmlElement {
  return "tagName" in node;
}

function isTextNode(node: HtmlNode): node is DefaultTreeAdapterTypes.TextNode {
  return node.nodeName === "#text";
}

function hasChildNodes(
  node: HtmlNode,
): node is DefaultTreeAdapterTypes.ParentNode {
  return "childNodes" in node;
}
