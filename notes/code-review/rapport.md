# Security Review Report: `palette-storage`

## 1. Arbitrary MIME type injection via imported data URLs

**Severity: Major**

**Code involved:** `json-transfer.js` (`dataUrlToBlob`, `normalizeImportedPalette`), `blob.js` (`dataUrlToBlob`)

**Problem:** Both `dataUrlToBlob` implementations extract the MIME type from an untrusted data URL header without any whitelist or validation. During import, a malicious backup file can contain:

```json
{
  "photoBlob": "data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg=="
}
```

This creates a `Blob` with `type: "text/html"`. If the UI ever renders this blob in an executable context (`<iframe src="blob:...">`, `window.open(blobUrl)`, etc.), it will execute attacker-controlled JavaScript. Even if the current UI only uses `<img>`, the storage layer should not preserve executable MIME types because a future refactor can silently introduce XSS.

**Concrete fix:** Validate the extracted MIME type against an explicit image whitelist before creating the Blob:

```javascript
const ALLOWED_PHOTO_MIME_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
  "image/avif",
]);

// In dataUrlToBlob / normalizeImportedPalette:
if (!ALLOWED_PHOTO_MIME_TYPES.has(mimeType)) {
  throw new Error(`Unsupported photo MIME type: ${mimeType}`);
}
```

---

## 2. Unvalidated import schema allows data pollution

**Severity: Major**

**Code involved:** `json-transfer.js` (`normalizeImportedPalette`, `deserializePalettesFromImport`), `records.js` (`normalizeStoredPaletteRecord`)

**Problem:** `normalizeImportedPalette` copies the entire imported object via `const palette = { ...entry }`, strips a few known fields, and passes everything else through. `normalizeStoredPaletteRecord` also spreads `...palette`, preserving any extra properties. This means a malicious import can inject arbitrary keys into IndexedDB records:

```json
{
  "colors": [{ "r": 0, "g": 0, "b": 0 }],
  "photoBlob": "data:image/jpeg;base64,...",
  "evilPayload": { "__proto__": { "isAdmin": true } },
  "toString": "conflict"
}
```

While modern engines prevent prototype pollution via `__proto__` own properties, downstream code that iterates over palette keys or uses dynamic property access can behave unexpectedly. It also bloats storage and breaks data-model assumptions.

**Concrete fix:** Use an explicit allow-list in `normalizeImportedPalette` and `normalizeStoredPaletteRecord`. Only copy known, expected fields:

```javascript
const ALLOWED_PALETTE_FIELDS = new Set([
  'colors', 'timestamp', 'photoBlob', 'captureCropRect',
  'polaroidRenderSettings', 'remoteCatchId', 'moderationStatus', ...
]);

const palette = {};
for (const key of Object.keys(entry)) {
  if (ALLOWED_PALETTE_FIELDS.has(key)) {
    palette[key] = entry[key];
  }
}
```

---

## 3. DoS via unbounded import payload

**Severity: Major**

**Code involved:** `json-transfer.js` (`deserializePalettesFromImport`), `backup.js` (`importAllPalettes`)

**Problem:** There is no size limit, palette count limit, or photo blob size limit on imported data. An attacker can craft a multi-gigabyte JSON file with thousands of palettes or enormous base64 payloads. `JSON.parse` will block the main thread and likely crash the app with an out-of-memory error. The export path also materializes all palettes into memory at once (`db.palettes.toArray()`).

**Concrete fix:** Add guardrails before parsing and processing:

```javascript
// Before JSON.parse:
if (jsonString.length > MAX_IMPORT_JSON_SIZE) {
  throw new Error("Import file too large.");
}

const payload = JSON.parse(jsonString);
if (
  !Array.isArray(payload.palettes) ||
  payload.palettes.length > MAX_PALETTE_COUNT
) {
  throw new Error("Invalid or excessive palette count.");
}

// Validate individual blob sizes after base64 decode:
if (photoBlob.size > MAX_PHOTO_SIZE_BYTES) {
  throw new Error("Photo exceeds maximum size.");
}
```

---

## 4. Fragile data URL parsing in `blob.js`

**Severity: Minor**

**Code involved:** `blob.js` (`dataUrlToBlob`)

**Problem:** The function uses `dataUrl.split(',')` which splits on **every** comma. Destructuring `const [header, content] = ...` silently drops everything after the second comma, corrupting the payload. It also requires a semicolon in the header via `/(.*?);/`, rejecting valid data URLs like `data:text/plain,hello`.

**Concrete fix:** Replace with the more robust implementation already present in `json-transfer.js` (or deduplicate into a single utility), which uses `indexOf(',')` once:

```javascript
const separatorIndex = dataUrl.indexOf(",");
if (separatorIndex <= 4) throw new Error("Invalid data URL format.");
const header = dataUrl.slice(0, separatorIndex);
const content = dataUrl.slice(separatorIndex + 1);
```

---

## 5. Missing error handling around `decodeURIComponent` and `atob`

**Severity: Minor**

**Code involved:** `json-transfer.js` (`dataUrlToBlob`), `blob.js` (`dataUrlToBlob`)

**Problem:** `decodeURIComponent(content)` (in `json-transfer.js`) and `atob(content)` (in `blob.js`) can throw on malformed input. Neither function is wrapped in `try/catch`, so a malicious or corrupted import file will propagate an unhandled exception and abort the entire import transaction.

**Concrete fix:** Wrap decoding in `try/catch` and return a user-friendly error:

```javascript
let bytes;
try {
  bytes = decodeBase64(content);
} catch {
  throw new Error("Invalid base64 content in photo data URL.");
}
```

---

## Summary

| #   | Issue                                       | Severity | File                             |
| --- | ------------------------------------------- | -------- | -------------------------------- |
| 1   | Arbitrary MIME type injection via data URLs | Major    | `json-transfer.js`, `blob.js`    |
| 2   | Unvalidated import schema / data pollution  | Major    | `json-transfer.js`, `records.js` |
| 3   | DoS via unbounded import payload            | Major    | `json-transfer.js`, `backup.js`  |
| 4   | Fragile data URL parsing                    | Minor    | `blob.js`                        |
| 5   | Uncaught decoding exceptions                | Minor    | `json-transfer.js`, `blob.js`    |
