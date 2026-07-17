import {
	App,
	Plugin,
	PluginSettingTab,
	Setting,
	requestUrl,
	Notice,
	Editor,
	MarkdownView,
} from "obsidian";
import { EditorView, Decoration, WidgetType, keymap } from "@codemirror/view";
import { StateField, StateEffect, Prec } from "@codemirror/state";

// ---------- Settings ----------

interface OllamaAutocompleteSettings {
	ollamaUrl: string;
	model: string;
	triggerDelayMs: number;
	prefixChars: number;
	maxTokens: number;
	maxGhostTextChars: number;
	ghostTextChunkSize: number;
	temperature: number;
	rawMode: boolean; // true = bypass model template entirely (pure text continuation)
	minTriggerChars: number; // don't trigger on very short lines
	enabled: boolean;
}

const DEFAULT_SETTINGS: OllamaAutocompleteSettings = {
	ollamaUrl: "http://localhost:11434",
	model: "llama3",
	triggerDelayMs: 500,
	prefixChars: 2000,
	maxTokens: 40,
	maxGhostTextChars: 240,
	ghostTextChunkSize: 80,
	temperature: 0.4,
	rawMode: true,
	minTriggerChars: 3,
	enabled: true,
};

// ---------- CodeMirror: ghost text suggestion state ----------

interface GhostTextSuggestion {
	pos: number;
	segments: string[];
	index: number;
}

// The effect used to push a new suggestion (or clear one, via null) into the editor state.
const setSuggestion = StateEffect.define<GhostTextSuggestion | null>();

class GhostTextWidget extends WidgetType {
	constructor(readonly text: string) {
		super();
	}
	eq(other: GhostTextWidget) {
		return other.text === this.text;
	}
	toDOM() {
		const span = document.createElement("span");
		span.textContent = this.text;
		span.className = "ollama-autocomplete-ghost";
		return span;
	}
	ignoreEvent() {
		return true;
	}
}

const suggestionField = StateField.define<GhostTextSuggestion | null>({
	create() {
		return null;
	},
	update(value, tr) {
		let next = value;
		// Any document change or selection change not accompanied by a fresh
		// setSuggestion effect invalidates the current suggestion.
		if (tr.docChanged || tr.selection) {
			next = null;
		}
		for (const effect of tr.effects) {
			if (effect.is(setSuggestion)) {
				next = effect.value;
			}
		}
		return next;
	},
	provide: (field) =>
		EditorView.decorations.from(field, (value) => {
			if (!value) return Decoration.none;
			const currentText = value.segments[value.index] ?? "";
			if (!currentText) return Decoration.none;
			return Decoration.set([
				Decoration.widget({ widget: new GhostTextWidget(currentText), side: 1 }).range(value.pos),
			]);
		}),
});

function limitSuggestionText(text: string, maxChars: number): string {
	if (maxChars <= 0 || text.length <= maxChars) return text;
	return text.slice(0, maxChars);
}

function splitSuggestionIntoChunks(text: string, chunkSize: number): string[] {
	if (!text) return [];
	if (chunkSize <= 0 || text.length <= chunkSize) return [text];
	const segments: string[] = [];
	for (let index = 0; index < text.length; index += chunkSize) {
		segments.push(text.slice(index, index + chunkSize));
	}
	return segments;
}

function acceptSuggestion(view: EditorView): boolean {
	const value = view.state.field(suggestionField, false);
	if (!value) return false;
	const currentText = value.segments[value.index] ?? "";
	if (!currentText) return false;

	const nextSegments = value.segments.slice(value.index + 1);
	const nextSuggestion = nextSegments.length
		? { pos: value.pos + currentText.length, segments: nextSegments, index: 0 }
		: null;

	view.dispatch({
		changes: { from: value.pos, insert: currentText },
		selection: { anchor: value.pos + currentText.length },
		effects: setSuggestion.of(nextSuggestion),
	});
	return true;
}

function dismissSuggestion(view: EditorView): boolean {
	const value = view.state.field(suggestionField, false);
	if (!value) return false;
	view.dispatch({ effects: setSuggestion.of(null) });
	return true;
}

// ---------- Plugin ----------

export default class OllamaAutocompletePlugin extends Plugin {
	settings: OllamaAutocompleteSettings;
	private debounceTimer: number | null = null;
	private activeRequestId = 0;
	private statusBarItem: HTMLElement;

	async onload() {
		await this.loadSettings();

		this.statusBarItem = this.addStatusBarItem();
		this.updateStatusBar();

		this.addSettingTab(new OllamaAutocompleteSettingTab(this.app, this));

		this.addCommand({
			id: "toggle-ollama-autocomplete",
			name: "Toggle Ollama autocomplete",
			callback: async () => {
				this.settings.enabled = !this.settings.enabled;
				await this.saveSettings();
				this.updateStatusBar();
				new Notice(`Ollama autocomplete ${this.settings.enabled ? "enabled" : "disabled"}`);
			},
		});

		this.addCommand({
			id: "trigger-ollama-autocomplete",
			name: "Trigger suggestion now",
			editorCallback: (editor: Editor) => {
				this.requestSuggestionForActiveEditor();
			},
		});

		const plugin = this;

		// The CodeMirror 6 extension: just the state field for the ghost-text
		// decoration plus a high-precedence keymap for Tab (accept) / Escape
		// (dismiss). Scheduling new requests is handled separately below via
		// a DOM-level keyup listener, which is simpler and avoids fighting
		// over plugin-instance access inside a ViewPlugin.
		this.registerEditorExtension([
			suggestionField,
			Prec.highest(
				keymap.of([
					{
						key: "Tab",
						run: (view) => {
							const value = view.state.field(suggestionField, false);
							if (value) return acceptSuggestion(view);
							return false;
						},
					},
					{
						key: "Escape",
						run: (view) => dismissSuggestion(view),
					},
				])
			),
		]);

		this.registerDomEvent(document, "keyup", (evt: KeyboardEvent) => {
			if (!this.settings.enabled) return;
			if (["Tab", "Escape", "Shift", "Control", "Alt", "Meta"].includes(evt.key)) return;
			this.scheduleSuggestionFromDom();
		});
	}

	onunload() {
		if (this.debounceTimer) window.clearTimeout(this.debounceTimer);
	}

	updateStatusBar() {
		this.statusBarItem.setText(this.settings.enabled ? "Ollama AC: on" : "Ollama AC: off");
	}

	private scheduleSuggestionFromDom() {
		if (this.debounceTimer) window.clearTimeout(this.debounceTimer);
		this.debounceTimer = window.setTimeout(() => {
			this.requestSuggestionForActiveEditor();
		}, this.settings.triggerDelayMs);
	}

	private getActiveCM(): EditorView | null {
		const view = this.app.workspace.getActiveViewOfType(MarkdownView);
		if (!view) return null;
		// @ts-ignore - undocumented but stable access to the underlying CM6 instance
		const cm: EditorView | undefined = view.editor?.cm;
		return cm ?? null;
	}

	async requestSuggestionForActiveEditor() {
		if (!this.settings.enabled) return;
		const cm = this.getActiveCM();
		if (!cm) return;

		const pos = cm.state.selection.main.head;
		// Only suggest when the cursor is at the end of the current line
		// (avoids weird mid-word ghost text).
		const line = cm.state.doc.lineAt(pos);
		if (pos !== line.to) return;

		const prefixStart = Math.max(0, pos - this.settings.prefixChars);
		const prefix = cm.state.sliceDoc(prefixStart, pos);

		const trimmed = prefix.trimEnd();
		if (trimmed.length < this.settings.minTriggerChars) return;
		// Don't re-request if the text already ends mid-suggestion-accept, etc.

		const requestId = ++this.activeRequestId;

		let completion: string;
		try {
			completion = await this.callOllama(prefix);
		} catch (err) {
			console.error("Ollama autocomplete error:", err);
			return;
		}

		// Bail if the user kept typing while we were waiting.
		if (requestId !== this.activeRequestId) return;
		if (!completion) return;

		const freshCm = this.getActiveCM();
		if (!freshCm) return;
		const freshPos = freshCm.state.selection.main.head;
		if (freshPos !== pos) return; // cursor moved since we asked

		const limitedCompletion = limitSuggestionText(completion, this.settings.maxGhostTextChars);
		const segments = splitSuggestionIntoChunks(limitedCompletion, this.settings.ghostTextChunkSize);
		if (!segments.length) return;

		freshCm.dispatch({
			effects: setSuggestion.of({ pos: freshPos, segments, index: 0 }),
		});
	}

	async callOllama(prefix: string): Promise<string> {
		const body: Record<string, unknown> = {
			model: this.settings.model,
			prompt: prefix,
			stream: false,
			raw: this.settings.rawMode,
			options: {
				temperature: this.settings.temperature,
				num_predict: this.settings.maxTokens,
				stop: ["\n\n"],
			},
		};

		const res = await requestUrl({
			url: `${this.settings.ollamaUrl.replace(/\/$/, "")}/api/generate`,
			method: "POST",
			contentType: "application/json",
			body: JSON.stringify(body),
			throw: false,
		});

		if (res.status < 200 || res.status >= 300) {
			throw new Error(`Ollama returned status ${res.status}: ${res.text}`);
		}

		const data = res.json;
		const text: string = data?.response ?? "";
		// Trim a single leading space/newline the model sometimes adds.
		return text.replace(/^\s+/, (m) => (m.includes("\n") ? "" : " "));
	}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}
}

// ---------- Settings tab ----------

class OllamaAutocompleteSettingTab extends PluginSettingTab {
	plugin: OllamaAutocompletePlugin;

	constructor(app: App, plugin: OllamaAutocompletePlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		containerEl.createEl("h2", { text: "Ollama Raw Autocomplete" });

		new Setting(containerEl)
			.setName("Enabled")
			.setDesc("Turn ghost-text suggestions on or off.")
			.addToggle((t) =>
				t.setValue(this.plugin.settings.enabled).onChange(async (v) => {
					this.plugin.settings.enabled = v;
					await this.plugin.saveSettings();
					this.plugin.updateStatusBar();
				})
			);

		new Setting(containerEl)
			.setName("Ollama URL")
			.setDesc("Base URL of your local Ollama server.")
			.addText((t) =>
				t.setValue(this.plugin.settings.ollamaUrl).onChange(async (v) => {
					this.plugin.settings.ollamaUrl = v;
					await this.plugin.saveSettings();
				})
			);

		new Setting(containerEl)
			.setName("Model")
			.setDesc("Name of the model as shown by `ollama list`.")
			.addText((t) =>
				t.setValue(this.plugin.settings.model).onChange(async (v) => {
					this.plugin.settings.model = v;
					await this.plugin.saveSettings();
				})
			);

		new Setting(containerEl)
			.setName("Raw mode")
			.setDesc(
				"On: bypass the model's chat/instruct template entirely and send your text as a pure continuation prompt (true GPT-3-style autocomplete; works best with base/completion models). " +
					"Off: still uses /api/generate, but applies the model's built-in template, which can work better with instruct-tuned models."
			)
			.addToggle((t) =>
				t.setValue(this.plugin.settings.rawMode).onChange(async (v) => {
					this.plugin.settings.rawMode = v;
					await this.plugin.saveSettings();
				})
			);

		new Setting(containerEl)
			.setName("Trigger delay (ms)")
			.setDesc("How long to wait after you stop typing before requesting a suggestion.")
			.addSlider((s) =>
				s
					.setLimits(150, 2000, 50)
					.setValue(this.plugin.settings.triggerDelayMs)
					.setDynamicTooltip()
					.onChange(async (v) => {
						this.plugin.settings.triggerDelayMs = v;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Context length (characters)")
			.setDesc("How many characters before the cursor to send as context.")
			.addSlider((s) =>
				s
					.setLimits(200, 6000, 100)
					.setValue(this.plugin.settings.prefixChars)
					.setDynamicTooltip()
					.onChange(async (v) => {
						this.plugin.settings.prefixChars = v;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Max suggestion tokens")
			.addSlider((s) =>
				s
					.setLimits(5, 200, 5)
					.setValue(this.plugin.settings.maxTokens)
					.setDynamicTooltip()
					.onChange(async (v) => {
						this.plugin.settings.maxTokens = v;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Max ghost text (chars)")
			.setDesc("Cap how much text is shown in a single suggestion.")
			.addSlider((s) =>
				s
					.setLimits(40, 800, 20)
					.setValue(this.plugin.settings.maxGhostTextChars)
					.setDynamicTooltip()
					.onChange(async (v) => {
						this.plugin.settings.maxGhostTextChars = v;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Ghost text chunk size")
			.setDesc("How many characters are inserted per Tab press.")
			.addSlider((s) =>
				s
					.setLimits(20, 200, 10)
					.setValue(this.plugin.settings.ghostTextChunkSize)
					.setDynamicTooltip()
					.onChange(async (v) => {
						this.plugin.settings.ghostTextChunkSize = v;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Temperature")
			.addSlider((s) =>
				s
					.setLimits(0, 1.5, 0.05)
					.setValue(this.plugin.settings.temperature)
					.setDynamicTooltip()
					.onChange(async (v) => {
						this.plugin.settings.temperature = v;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl).addButton((b) =>
			b.setButtonText("Test connection").onClick(async () => {
				try {
					const completion = await this.plugin.callOllama("The quick brown fox");
					new Notice(`Ollama responded: "${completion.slice(0, 60)}"`);
				} catch (e) {
					new Notice(`Connection failed: ${e}`);
				}
			})
		);
	}
}
