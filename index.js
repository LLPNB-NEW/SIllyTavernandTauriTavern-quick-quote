/**
 * 快捷输入引号 Quick Quote — a one-click 中文双引号 “” button for the chat input bar.
 *
 * What it does
 * ------------
 * Injects a “” button into the bottom chat input bar and edits `#send_textarea`
 * through the same event path the app itself uses, so double-click word select,
 * undo history, the slash-command highlighter, the send-button state and the
 * auto-growing textarea all keep working:
 *
 *   - text selected           -> wrap the selection:  说话 → “说话”
 *   - caret inside a “” pair  -> step over the closing quote instead of nesting
 *   - otherwise               -> insert an empty pair and park the caret between
 *
 * The button is a direct child of `#rightSendForm`, placed immediately before the
 * send button, so it sits to the left of it. The app's own bottom-bar rules
 * (`#rightSendForm > div`) give it exactly the size, fade and hover behaviour of
 * the native buttons — no magic numbers here.
 *
 * Design notes
 * ------------
 * - It is inserted with `insertBefore(…, #send_but)` instead of relying on flex
 *   `order`, so the DOM order matches the on-screen order and `Tab` walks the bar
 *   left-to-right.
 * - `mousedown` is cancelled so the button never steals focus from the textarea.
 *   As a safety net the caret is also remembered whenever the textarea is blurred
 *   while it is still the active element, because a blurred textarea reports
 *   `selectionStart === selectionEnd === value.length` and the insertion point
 *   would otherwise jump to the very end of the text.
 * - Undo history survives because the edit normally goes through
 *   `document.execCommand('insertText')`; the direct value edit is the fallback.
 *   Both paths are checked against the expected value, so an edit the WebView
 *   silently refused can never look like a success.
 * - Mounting is idempotent and re-runs on DOM mutations, because the app may
 *   replace the input bar while the extension is loaded.
 *
 * Configuration is read from `extension_settings.tauritavernQuickQuote` in
 * settings.json (with `localStorage['tauritavern.quickQuote']` as a fallback):
 *
 *   {
 *     "enabled": true,             // false = hide the button everywhere
 *     "quote": "\u201c\u201d",     // the pair inserted at the caret
 *     "shortcut": "",              // optional key, e.g. "Ctrl+Alt+Q"; empty = off
 *     "wrapSelection": true,       // wrap selected text instead of replacing it
 *     "glyphScale": 82             // size of the “” glyph, in % of the icon size
 *   }
 *
 * Everything above is also editable in the extension's own panel inside the
 * Extensions drawer, which writes the same keys through `saveSettingsDebounced`.
 */

const BUTTON_ID = 'tt_quick_quote_button';
const PANEL_ID = 'tt_quick_quote_container';
const BUTTON_MARKER = 'quickQuoteButton';
const ACTION_TITLE = '插入中文双引号 “”';
const SETTINGS_KEY = 'tauritavernQuickQuote';
const STORAGE_KEY = 'tauritavern.quickQuote';

/** Size of the glyph, as a percentage of the app's bottom-bar icon size. */
const MIN_GLYPH_SCALE = 50;
const MAX_GLYPH_SCALE = 150;

/** Keys that are never a shortcut on their own. */
const MODIFIER_KEYS = new Set(['Control', 'Alt', 'Shift', 'Meta', 'AltGraph', 'CapsLock', 'Dead']);
const MODIFIER_ORDER = ['Ctrl', 'Alt', 'Shift', 'Meta'];

const DEFAULT_CONFIG = Object.freeze({
    enabled: true,
    quote: '\u201C\u201D',
    shortcut: '',
    wrapSelection: true,
    glyphScale: 82,
});

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

function getStContext() {
    try {
        return globalThis.SillyTavern?.getContext?.() ?? null;
    } catch {
        return null;
    }
}

function sanitiseConfig(raw) {
    const config = { ...DEFAULT_CONFIG };
    if (!raw || typeof raw !== 'object') {
        return config;
    }

    if (typeof raw.enabled === 'boolean') {
        config.enabled = raw.enabled;
    }
    if (typeof raw.wrapSelection === 'boolean') {
        config.wrapSelection = raw.wrapSelection;
    }
    if (typeof raw.shortcut === 'string') {
        config.shortcut = raw.shortcut.trim();
    }
    // A pair needs two characters; a lone quote could not be stepped over.
    if (typeof raw.quote === 'string' && [...raw.quote].length >= 2) {
        config.quote = raw.quote;
    }
    if (Number.isFinite(Number(raw.glyphScale))) {
        config.glyphScale = clampGlyphScale(raw.glyphScale);
    }

    return config;
}

function clampGlyphScale(value) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) {
        return DEFAULT_CONFIG.glyphScale;
    }
    return Math.round(Math.min(MAX_GLYPH_SCALE, Math.max(MIN_GLYPH_SCALE, numeric)));
}

function readConfig() {
    const fromSettings = getStContext()?.extensionSettings?.[SETTINGS_KEY];
    if (fromSettings) {
        return sanitiseConfig(fromSettings);
    }

    try {
        const stored = localStorage.getItem(STORAGE_KEY);
        if (stored) {
            return sanitiseConfig(JSON.parse(stored));
        }
    } catch {
        // localStorage may be unavailable or hold junk; fall back to defaults.
    }

    return sanitiseConfig(null);
}

/**
 * Writes one key of the configuration and flushes it the same way the app does.
 * The in-memory copy is updated too, so the value survives even if the settings
 * object is momentarily unavailable.
 */
function writeConfig(patch) {
    const merged = { ...readConfig(), ...patch };

    try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(merged));
    } catch {
        // localStorage may be unavailable; extension_settings is the real store.
    }

    const context = getStContext();
    if (context?.extensionSettings) {
        context.extensionSettings[SETTINGS_KEY] = merged;
        context.saveSettingsDebounced?.();
    }
}

// ---------------------------------------------------------------------------
// Key matching
// ---------------------------------------------------------------------------

/** Normalises a KeyboardEvent into the canonical "Ctrl+Alt+Q" form. */
function eventToShortcut(event) {
    if (event.isComposing || MODIFIER_KEYS.has(event.key)) {
        return null;
    }

    const parts = [];
    if (event.ctrlKey) {
        parts.push('Ctrl');
    }
    if (event.altKey) {
        parts.push('Alt');
    }
    if (event.shiftKey) {
        parts.push('Shift');
    }
    if (event.metaKey) {
        parts.push('Meta');
    }
    parts.push(event.key.length === 1 ? event.key.toUpperCase() : event.key);

    return parts.join('+');
}

/** Normalises a configured shortcut string into the same canonical form. */
function normaliseShortcut(shortcut) {
    if (!shortcut) {
        return null;
    }

    const parts = String(shortcut).split('+').map(part => part.trim()).filter(Boolean);
    const modifiers = [];
    let key = null;

    for (const part of parts) {
        const lower = part.toLowerCase();
        if (lower === 'ctrl' || lower === 'control') {
            modifiers.push('Ctrl');
        } else if (lower === 'alt') {
            modifiers.push('Alt');
        } else if (lower === 'shift') {
            modifiers.push('Shift');
        } else if (lower === 'meta' || lower === 'cmd' || lower === 'super') {
            modifiers.push('Meta');
        } else {
            key = part.length === 1 ? part.toUpperCase() : part;
        }
    }

    if (!key) {
        return null;
    }
    // A bare character would swallow ordinary typing.
    if (modifiers.length === 0 && key.length === 1) {
        return null;
    }

    const ordered = MODIFIER_ORDER.filter(modifier => modifiers.includes(modifier));
    return [...ordered, key].join('+');
}

// ---------------------------------------------------------------------------
// Textarea editing
// ---------------------------------------------------------------------------

function getTextarea() {
    return document.querySelector('#send_textarea');
}

/** Clamps an index into the current text length. */
function clampIndex(index, length) {
    const numeric = Number(index);
    if (!Number.isFinite(numeric)) {
        return length;
    }
    return Math.min(length, Math.max(0, Math.trunc(numeric)));
}

/**
 * True when the caret sits between an opening and a closing quote, i.e. inside an
 * empty pair that was just inserted.
 */
function caretInsideEmptyQuotePair(value, start, end, open, close) {
    if (start !== end || start <= 0 || start >= value.length) {
        return false;
    }
    return value[start - 1] === open && value[start] === close;
}

/**
 * Replaces [start, end) with `text`, puts the caret at `caret` and notifies the
 * app through the same `input` event the app itself dispatches.
 *
 * @returns {boolean} whether the textarea now holds the expected value
 */
function editTextarea(textarea, start, end, text, caret) {
    const before = textarea.value;
    const expected = before.slice(0, start) + text + before.slice(end);

    textarea.focus();

    // Preferred path: keeps a real undo entry in the WebView.
    if (typeof document.execCommand === 'function') {
        try {
            textarea.setSelectionRange(start, end);
            document.execCommand('insertText', false, text);
        } catch {
            // fall through to the direct edit below
        }
    }

    if (textarea.value !== expected) {
        textarea.value = expected;
    }

    textarea.setSelectionRange(caret, caret);
    textarea.dispatchEvent(new Event('input', { bubbles: true }));

    return textarea.value === expected;
}

/**
 * Applies the quote action at the caret.
 *
 * @param {HTMLTextAreaElement} textarea
 * @param {number|null} rememberedStart caret start remembered while blurred
 * @param {number|null} rememberedEnd caret end remembered while blurred
 * @param {{ quote: string, wrapSelection: boolean }} config
 * @returns {boolean} whether the textarea was modified
 */
function applyQuote(textarea, rememberedStart, rememberedEnd, config) {
    const [open, close] = [...config.quote];
    const value = textarea.value;
    const length = value.length;

    // A focused textarea is authoritative; the remembered caret only helps when
    // the click somehow took the focus away.
    const focused = document.activeElement === textarea;
    const rawStart = clampIndex(focused ? textarea.selectionStart : rememberedStart ?? textarea.selectionStart, length);
    const rawEnd = clampIndex(focused ? textarea.selectionEnd : rememberedEnd ?? textarea.selectionEnd, length);
    // A backwards selection reports start > end, so work on the ordered range.
    const start = Math.min(rawStart, rawEnd);
    const end = Math.max(rawStart, rawEnd);
    const selected = value.slice(start, end);

    if (selected.length > 0) {
        // The selection is wrapped; with `wrapSelection` off it is replaced, so
        // that only a bare pair is inserted at the caret position.
        const text = config.wrapSelection ? `${open}${selected}${close}` : `${open}${close}`;
        const caret = end + open.length + close.length;
        return editTextarea(textarea, start, end, text, caret);
    }

    if (caretInsideEmptyQuotePair(value, start, end, open, close)) {
        // Already between the quotes: step over the closing one like an editor.
        textarea.focus();
        textarea.setSelectionRange(start + 1, start + 1);
        return false;
    }

    return editTextarea(textarea, start, end, `${open}${close}`, start + open.length);
}

/**
 * Remembers the caret whenever the textarea loses focus.
 *
 * A blurred textarea reports its selection as [length, length], so without this
 * the button would append at the end instead of editing at the insertion point.
 */
function trackCaret(store) {
    const textarea = getTextarea();
    if (!textarea) {
        return;
    }

    const remember = () => {
        if (document.activeElement === textarea) {
            store.selection = { start: textarea.selectionStart, end: textarea.selectionEnd };
        }
    };

    textarea.addEventListener('focus', remember);
    textarea.addEventListener('keyup', remember);
    textarea.addEventListener('mouseup', remember);
    textarea.addEventListener('input', remember);
    textarea.addEventListener('blur', remember);
}

// ---------------------------------------------------------------------------
// Button
// ---------------------------------------------------------------------------

/** Applies the configured glyph size to the button through one CSS variable. */
function applyGlyphScale(button, config) {
    button.style.setProperty('--tt-quick-quote-glyph-scale', String(config.glyphScale / 100));
}

function createButton(store, config) {
    const button = document.createElement('div');
    button.id = BUTTON_ID;
    button.dataset[BUTTON_MARKER] = 'true';
    button.className = 'interactable';
    button.title = ACTION_TITLE;
    button.setAttribute('role', 'button');
    button.setAttribute('tabindex', '0');
    button.setAttribute('aria-label', ACTION_TITLE);
    applyGlyphScale(button, config);

    const glyph = document.createElement('span');
    glyph.className = 'tt-quick-quote-glyph';
    glyph.textContent = config.quote;
    button.append(glyph);

    // Keep the focus — and with it the caret — inside the textarea.
    button.addEventListener('mousedown', event => event.preventDefault());
    button.addEventListener('click', event => {
        event.preventDefault();
        const textarea = getTextarea();
        if (!textarea) {
            return;
        }
        // A stray focus change between mousedown and click would move the caret to
        // the end of the text (a blurred textarea collapses its selection), so the
        // live caret is captured here as well; applyQuote prefers it when focused.
        store.selection = { start: textarea.selectionStart, end: textarea.selectionEnd };
        applyQuote(textarea, store.selection.start, store.selection.end, readConfig());
    });
    button.addEventListener('keydown', event => {
        if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            button.click();
        }
    });

    return button;
}

/**
 * Inserts or refreshes the button. Safe to call repeatedly.
 *
 * The button lives in the right-hand group, immediately before the send button,
 * so it sits to the left of it. It is inserted with `insertBefore` on `#send_but`
 * rather than relying on flex `order`, so the DOM order matches what is on screen
 * and keyboard tab order stays left-to-right.
 */
function mountButton(store) {
    const config = readConfig();
    const existing = document.getElementById(BUTTON_ID);

    if (existing?.dataset[BUTTON_MARKER] === 'true') {
        existing.hidden = !config.enabled;
        applyGlyphScale(existing, config);
        // Keep the glyph in sync if `quote` was edited without a restart.
        const glyph = existing.querySelector('.tt-quick-quote-glyph');
        if (glyph && glyph.textContent !== config.quote) {
            glyph.textContent = config.quote;
        }
        return true;
    }
    existing?.remove();

    if (!config.enabled) {
        return true;
    }

    const host = document.getElementById('rightSendForm');
    const sendButton = document.getElementById('send_but');
    if (!host) {
        return false;
    }

    const button = createButton(store, config);
    if (sendButton) {
        host.insertBefore(button, sendButton);
    } else {
        host.append(button);
    }
    return true;
}

function installShortcut(store) {
    window.addEventListener('keydown', event => {
        const config = readConfig();
        const configured = normaliseShortcut(config.shortcut);
        if (!config.enabled || !configured) {
            return;
        }

        const textarea = getTextarea();
        if (!textarea || document.activeElement !== textarea || eventToShortcut(event) !== configured) {
            return;
        }

        applyQuote(textarea, null, null, config);
    }, true);
}

// ---------------------------------------------------------------------------
// Settings panel (Extensions drawer)
// ---------------------------------------------------------------------------

/**
 * Re-applies the stored configuration to everything on screen.
 *
 * `mountButton` already updates an existing button in place (and inserts a missing
 * one), so the panel never needs to rebuild the element that holds the listeners.
 */
function refreshUi(store) {
    mountButton(store);
}

function createPanel(store) {
    const config = readConfig();
    const container = document.createElement('div');
    container.id = PANEL_ID;
    container.className = 'extension_container';
    container.innerHTML = `
        <div class="inline-drawer">
            <div class="inline-drawer-toggle inline-drawer-header">
                <b>快捷输入引号 Quick Quote</b>
                <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
            </div>
            <div class="inline-drawer-content">
                <label class="checkbox_label" title="关掉后输入栏里的“”按钮会隐藏，快捷键也不再生效。">
                    <input type="checkbox" id="tt_quick_quote_enabled">
                    <span>显示“”按钮</span>
                </label>

                <div class="tt-quick-quote-row">
                    <span class="tt-quick-quote-label">按钮大小</span>
                    <input type="range" id="tt_quick_quote_scale"
                        min="${MIN_GLYPH_SCALE}" max="${MAX_GLYPH_SCALE}" step="1"
                        value="${config.glyphScale}"
                        title="调整按钮里“”两个字的大小，输入栏里的按钮会立刻跟着变。">
                    <span id="tt_quick_quote_scale_value" class="tt-quick-quote-value">${config.glyphScale}%</span>
                    <div id="tt_quick_quote_scale_reset" class="menu_button menu_button_icon" title="恢复默认大小">
                        <i class="fa-solid fa-rotate-left"></i>
                    </div>
                </div>

                <div class="tt-quick-quote-row">
                    <span class="tt-quick-quote-label">引号</span>
                    <input type="text" id="tt_quick_quote_pair" class="text_pole tt-quick-quote-pair"
                        maxlength="4" value="${escapeAttribute(config.quote)}"
                        title="插入的引号对，例如 “” 「」 ""。">
                </div>

                <div class="tt-quick-quote-row">
                    <span class="tt-quick-quote-label">快捷键</span>
                    <input type="text" id="tt_quick_quote_shortcut" class="text_pole tt-quick-quote-shortcut"
                        placeholder="留空 = 不用快捷键" value="${escapeAttribute(config.shortcut)}"
                        title="例如 Ctrl+Alt+Q。需要带修饰键，且只在输入框聚焦时生效。">
                </div>

                <label class="checkbox_label" title="勾选时给选中的文字加引号；取消勾选则只插入一对空引号。">
                    <input type="checkbox" id="tt_quick_quote_wrap">
                    <span>选中文字时给它加引号</span>
                </label>

                <small class="tt-quick-quote-hint">
                    按钮在发送键左边。<b>按钮大小</b>只影响“”两个字，输入栏的按钮方框大小仍由 App 的图标尺寸决定，所以调它不会把输入栏撑变形。
                </small>
            </div>
        </div>
    `;

    bindPanel(container, store);
    return container;
}

function escapeAttribute(value) {
    return String(value).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function bindPanel(container, store) {
    const enabled = container.querySelector('#tt_quick_quote_enabled');
    const scale = container.querySelector('#tt_quick_quote_scale');
    const scaleValue = container.querySelector('#tt_quick_quote_scale_value');
    const scaleReset = container.querySelector('#tt_quick_quote_scale_reset');
    const pair = container.querySelector('#tt_quick_quote_pair');
    const shortcut = container.querySelector('#tt_quick_quote_shortcut');
    const wrap = container.querySelector('#tt_quick_quote_wrap');

    // Reflect the stored values (the panel markup above is only a first guess).
    const config = readConfig();
    enabled.checked = config.enabled;
    wrap.checked = config.wrapSelection;
    scale.value = String(config.glyphScale);
    scaleValue.textContent = `${config.glyphScale}%`;

    enabled.addEventListener('input', () => {
        writeConfig({ enabled: enabled.checked });
        refreshUi(store);
    });

    wrap.addEventListener('input', () => {
        writeConfig({ wrapSelection: wrap.checked });
    });

    // `input` fires continuously while dragging, which is what makes the button
    // resize live; the write is debounced by saveSettingsDebounced on the app side.
    scale.addEventListener('input', () => {
        const value = clampGlyphScale(scale.value);
        scaleValue.textContent = `${value}%`;
        writeConfig({ glyphScale: value });
        refreshUi(store);
    });

    scaleReset.addEventListener('click', () => {
        const value = DEFAULT_CONFIG.glyphScale;
        scale.value = String(value);
        scaleValue.textContent = `${value}%`;
        writeConfig({ glyphScale: value });
        refreshUi(store);
    });

    pair.addEventListener('change', () => {
        const value = pair.value.trim();
        if ([...value].length < 2) {
            // Reject silently by snapping back rather than storing an unusable pair.
            pair.value = readConfig().quote;
            return;
        }
        writeConfig({ quote: value });
        refreshUi(store);
    });

    shortcut.addEventListener('change', () => {
        const value = shortcut.value.trim();
        if (value && !normaliseShortcut(value)) {
            // Unusable (for example a bare letter); snap back to the stored value.
            shortcut.value = readConfig().shortcut;
            return;
        }
        writeConfig({ shortcut: value });
    });
}

/**
 * Mounts the settings panel into whichever Extensions column already holds the
 * other extensions, so this panel shows up next to them instead of in an empty
 * column (the app ships two columns and fills them by convention).
 */
function mountPanel(store) {
    if (document.getElementById(PANEL_ID) || !document.body) {
        return Boolean(document.getElementById(PANEL_ID));
    }

    const columns = ['extensions_settings', 'extensions_settings2']
        .map(id => document.getElementById(id))
        .filter(Boolean);
    if (columns.length === 0) {
        return false;
    }

    const host = columns
        .filter(column => column.children.length > 0)
        .sort((a, b) => b.children.length - a.children.length)[0] ?? columns[0];

    host.append(createPanel(store));
    return true;
}

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------

function main() {
    const store = { selection: null };
    let panelMounted = false;

    const start = () => {
        if (!getTextarea()) {
            // The chat input does not exist yet during early boot.
            return false;
        }

        trackCaret(store);
        mountButton(store);
        installShortcut(store);
        panelMounted = mountPanel(store);
        return true;
    };

    // Both the input bar and the Extensions drawer can appear (or be rebuilt)
    // after this module runs, so keep watching until each piece is in place.
    // `start` must run exactly once unless the input bar is not there yet, because
    // it registers the caret and shortcut listeners.
    let started = false;
    const observer = new MutationObserver(() => {
        if (!started && getTextarea()) {
            started = start();
        }
        if (started && !document.getElementById(BUTTON_ID)) {
            mountButton(store);
        }
        // The drawer can be rebuilt too, so re-mount the panel if it vanished.
        if (!panelMounted || !document.getElementById(PANEL_ID)) {
            panelMounted = mountPanel(store);
        }
    });

    if (getTextarea()) {
        started = start();
    }

    observer.observe(document.body, { childList: true, subtree: true });
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', main, { once: true });
} else {
    main();
}
