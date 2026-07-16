# Ollama Raw Autocomplete (Obsidian plugin)

Copilot-style ghost-text autocomplete for prose, powered by **Ollama's raw
`/api/generate` endpoint** — no chat wrapping, no `/api/chat`.

## How it works

- While you type, the plugin waits for a short pause (default 500ms), then
  takes the last N characters before your cursor and POSTs them to
  `POST {ollamaUrl}/api/generate` with `stream: false`.
- With **Raw mode ON** (default), it sets `"raw": true` in the request, which
  tells Ollama to skip the model's chat/instruct template entirely and treat
  your text as a pure continuation prompt — this is the closest thing to
  classic GPT-3-style completion, and works best with base/completion models
  (e.g. `llama3:text`, not `llama3-instruct`).
- With Raw mode OFF, it still hits `/api/generate` (never `/api/chat`), but
  lets the model's built-in template wrap your text — this tends to behave
  better with instruct-tuned chat models like the default `llama3`.
- The returned text is shown as translucent "ghost text" right after your
  cursor. **Tab** accepts it, **Escape** or continuing to type dismisses it.

## Install (manual, for testing)

1. Build the plugin (already built for you — `main.js` is included).
2. Find your vault's plugin folder: `<YourVault>/.obsidian/plugins/`
3. Create a subfolder there, e.g. `ollama-raw-autocomplete`, and copy in:
   - `main.js`
   - `manifest.json`
   - `styles.css`
4. Restart Obsidian (or `Cmd/Ctrl+R` to reload), then go to
   **Settings → Community plugins**, disable Restricted Mode if needed, and
   toggle **Ollama Raw Autocomplete** on.

## Test it

1. Make sure Ollama is running: `ollama serve` (or just have the app open).
2. Pull a model if you haven't: `ollama pull llama3`.
3. In Obsidian, go to **Settings → Ollama Raw Autocomplete**, set the model
   name to match, and click **Test connection** — you should get a Notice
   with a snippet of generated text.
4. Open any note, put your cursor at the end of a line, type a sentence, stop
   typing for half a second — ghost text should appear. Press **Tab** to
   accept it.

## Tuning

- If suggestions feel irrelevant or too "chatty" (e.g. the model answers as
  if you asked it a question), try toggling **Raw mode** off, or switch to a
  base/completion model rather than an instruct one — instruct models are
  tuned to answer, not continue, so raw completion quality varies by model.
- `Context length` controls how much text before the cursor gets sent — higher
  gives the model more context but is slower per request.
- `Max suggestion tokens` controls how long a suggestion can be; smaller is
  snappier.

## Rebuilding from source

```bash
npm install
npm run build   # production build -> main.js
# or
npm run dev      # watch mode
```
