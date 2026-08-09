# Locales

If you speak a language that isn't listed below, contributions are very welcome!

Pingflare currently localizes dashboard navigation, forms, state labels,
validation feedback, relative times, and outgoing notification messages. A
formal accessibility-conformance level is not claimed by this document.

## Supported languages

| Locale code | Language           | File                |
|-------------|--------------------|--------------------|
| `en`        | English            | `locales/en.json`  |
| `pt-BR`     | Português (Brasil) | `locales/pt-BR.json` |

## How to add your language

### 1. Copy the English file

```bash
cp locales/en.json locales/<code>.json
```

Use the [BCP 47](https://www.iana.org/assignments/language-subtag-registry/language-subtag-registry) locale code as the filename, e.g. `es.json`, `fr.json`, `de.json`, `zh-TW.json`.

### 2. Translate the values

Keep the **keys** exactly as they are, only the values change.

```json
{
  "common.save": "Guardar",
  "common.cancel": "Cancelar",
  ...
}
```

- **Placeholders** like `{name}` or `{slug}` must be kept as-is, they are replaced at runtime.
- **Ellipsis** (`…`) is a single character, not three dots (`...`). Copy it from the English file.
- If a string has no natural translation (e.g. "Heartbeat", "HTTP"), leaving the English value is fine.
- Keys prefixed with `notify.` are used in outgoing alert/notification messages sent to Slack, Discord, email, etc.

### 3. Register the locale in the frontend

Open `frontend/src/lib/i18n.ts` and add a static import plus an entry in the `translations` map:

```typescript
import myLang from '$locales/<code>.json'

const translations = {
  en,
  'pt-BR': ptBR,
  '<code>': myLang as Record<TranslationKey, string>,
}
```

### 4. Validate

Run the normal frontend checks and compare the locale keys before opening a PR:

```bash
npm run typecheck
node -e "const fs=require('node:fs');const en=JSON.parse(fs.readFileSync('locales/en.json'));const file=JSON.parse(fs.readFileSync('locales/<code>.json'));const missing=Object.keys(en).filter(k=>!(k in file));const extra=Object.keys(file).filter(k=>!(k in en));if(missing.length||extra.length){console.error({missing,extra});process.exit(1)}"
```

### 5. Open a PR

- `locales/<code>.json` — your translation file
- Updated `frontend/src/lib/i18n.ts` registration
- An updated row in the supported languages table at the top of this file

## Tips

- Use a real speaker to review, not machine translation alone — context matters for UI strings.
- If you are unsure about a string, leave a comment in your PR and we'll figure it out together.
- Pluralization edge cases (e.g. "N monitors") are handled separately in the `nMonitors` function at the bottom of `frontend/src/lib/i18n.ts` — mention it in your PR if your language has special plural rules.
