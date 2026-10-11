/**
 * 快捷符号按钮 Quick Symbols — a symbol button for the chat input bar.
 *
 * Ships as a one-click 中文双引号 “” button and generalises to any symbol: the menu
 * offers a list of symbols (`“”`, `「」`, `……`, `——`, …) that the user edits in the
 * settings panel, and the button inserts whichever one is current.
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
const MENU_ID = 'tt_quick_quote_menu';
const PANEL_ID = 'tt_quick_quote_container';
const OPTION_LIST_ID = 'tt_quick_quote_options';
const NEW_OPTION_ID = 'tt_quick_quote_new_option';
const BUTTON_MARKER = 'quickQuoteButton';
const ACTION_TITLE = '插入符号（默认中文双引号 “”）';
const SETTINGS_KEY = 'tauritavernQuickQuote';
const STORAGE_KEY = 'tauritavern.quickQuote';

/** Size of the glyph, as a percentage of the app's bottom-bar icon size. */
const MIN_GLYPH_SCALE = 50;
const MAX_GLYPH_SCALE = 150;

/** Symbols offered by the menu by default, in the order they are shown. */
const DEFAULT_QUOTE_OPTIONS = Object.freeze(['\u201C\u201D', '\u300C\u300D', '\uFF08\uFF09', '\u300A\u300B', '\u3010\u3011', '""', "''"]);

/** Of those, the ones that ship as enclosing pairs rather than standalone units. */
const DEFAULT_PAIR_SYMBOLS = Object.freeze([...DEFAULT_QUOTE_OPTIONS]);

/** Gap between the button and the menu, plus the delays around hover and close. */
const MENU_GAP_PX = 6;
const MENU_CLOSE_DELAY_MS = 160;
const HOVER_OPEN_DELAY_MS = 60;

/** Floor for the menu height, so it stays scrollable rather than collapsing. */
const MIN_MENU_HEIGHT = 44;

/**
 * Longest menu symbol that can be typed into the panel.
 *
 * Nothing here depends on the length: a symbol with two or more characters behaves
 * as a pair (two copies inserted, caret between them) and a single character is
 * inserted once. The cap is only there to keep a pasted paragraph out of the menu.
 */
const MAX_SYMBOL_LENGTH = 16;

/** Keys that are never a shortcut on their own. */
const MODIFIER_KEYS = new Set(['Control', 'Alt', 'Shift', 'Meta', 'AltGraph', 'CapsLock', 'Dead']);
const MODIFIER_ORDER = ['Ctrl', 'Alt', 'Shift', 'Meta'];

/**
 * How the button reaches the quote menu.
 *
 * AUTO guesses from the device: a touch screen has no hover, so there the button
 * opens the menu on a tap instead of inserting straight away. The user can pin
 * either behaviour from the settings panel.
 */
const MENU_MODES = Object.freeze(['auto', 'always', 'never']);

/**
 * What the toggle on each row reads and means.
 *
 * The row has to stay on one line: it holds the "current" dot, the symbol field, this toggle
 * and two icon buttons, and the dot sits last — if the row wraps, the dot drops onto a line
 * of its own, which reads as belonging to nothing. So this wording is deliberately short.
 *
 * The earlier phrases were too clipped to stand alone ("停在中间") and, when spelled out
 * ("输入后光标自动在中间", "光标停在符号中间"), too wide to fit beside the symbol field:
 * the toggle is `white-space: nowrap`, so the text was cut off mid-word and the row wrapped
 * anyway. Two characters name the destination without costing a row.
 *
 * The full explanation is in the tooltip, which has room for a sentence.
 */
const MODE_LABELS = Object.freeze({
    PAIR: '符号内',
    WHOLE: '符号后',
});

/** Tooltips for the row toggle, phrased as the result the user will see. */
const MODE_TITLES = Object.freeze({
    PAIR: '插入后光标停在符号中间：“|” —— 直接打字就在里面，选中文字时会把它包起来。点一下改成跟在后面。',
    WHOLE: '插入后光标跟在符号后面：……| —— 不会跑到符号中间去。点一下改成停在中间。',
    SINGLE: '单个字符没法停在中间，只能跟在后面。',
});

/** A one-character symbol cannot enclose anything, so it is always a unit. */
const UNPAIRABLE_LENGTH = 1;

const DEFAULT_CONFIG = Object.freeze({
    enabled: true,
    quote: '\u201C\u201D',
    shortcut: '',
    wrapSelection: true,
    glyphScale: 82,
    quoteOptions: [...DEFAULT_QUOTE_OPTIONS],
    /** Symbols inserted as enclosing pairs; everything else is inserted as a unit. */
    pairSymbols: [...DEFAULT_PAIR_SYMBOLS],
    menuMode: 'auto',
    animations: true,
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
    if (typeof raw.animations === 'boolean') {
        config.animations = raw.animations;
    }
    if (typeof raw.shortcut === 'string') {
        config.shortcut = raw.shortcut.trim();
    }
    // A single symbol is allowed (an ellipsis, a bullet, a dash); it simply inserts
    // one copy instead of opening a pair.
    if (typeof raw.quote === 'string' && [...raw.quote].length >= 1) {
        config.quote = raw.quote;
    }
    if (Number.isFinite(Number(raw.glyphScale))) {
        config.glyphScale = clampGlyphScale(raw.glyphScale);
    }
    if (MENU_MODES.includes(raw.menuMode)) {
        config.menuMode = raw.menuMode;
    }
    config.quoteOptions = parseSymbolOptions(raw.quoteOptions, config.quote);
    config.pairSymbols = parsePairSymbols(raw.pairSymbols, config.quoteOptions);

    return config;
}

/**
 * Normalises the set of symbols that are inserted as enclosing pairs.
 *
 * A missing value means the settings predate this option, so the shipped brackets
 * are used — otherwise every existing user would silently lose the enclosing quote
 * behaviour. Both the string and array forms are accepted so hand-edited settings
 * files stay easy to write. Entries that are not in the menu, or that are a single
 * character (which cannot enclose anything), are dropped.
 */
function parsePairSymbols(raw, options) {
    const source = raw === undefined || raw === null
        ? [...DEFAULT_PAIR_SYMBOLS]
        : (Array.isArray(raw) ? raw : String(raw).split(','));
    const pairs = new Set();

    for (const entry of source) {
        const text = String(entry ?? '').trim();
        if ([...text].length > UNPAIRABLE_LENGTH && options.includes(text)) {
            pairs.add(text);
        }
    }

    return [...pairs];
}

/**
 * True when the menu should open on a tap rather than on hover.
 *
 * `auto` trusts the device: a touch screen cannot hover, so the button has to
 * offer the menu on its first tap. Touch-capable desktops are included, because
 * tapping there hits the same problem.
 */
function prefersTapForMenu(config) {
    if (config.menuMode === 'always') {
        return true;
    }
    if (config.menuMode === 'never') {
        return false;
    }
    return isTouchDevice();
}

function isTouchDevice() {
    if (typeof navigator === 'undefined') {
        return false;
    }

    const userAgent = typeof navigator.userAgent === 'string' ? navigator.userAgent : '';
    if (/android|iphone|ipad|ipod|mobile/i.test(userAgent)) {
        return true;
    }
    if (Number(navigator.maxTouchPoints || 0) > 0) {
        return true;
    }
    return typeof window !== 'undefined' && Number(window.matchMedia?.('(pointer: coarse)')?.matches) > 0;
}

/**
 * Accepts the stored list of menu symbols.
 *
 * The array form is what the panel writes and what everything reads. A
 * comma-separated string is still accepted so that settings files written by an
 * earlier version keep working; note that a comma cannot then be a symbol itself.
 *
 * The currently selected symbol always stays in the list, so the menu can never
 * lose the entry that the button itself inserts.
 */
function parseSymbolOptions(raw, current) {
    const source = Array.isArray(raw) ? raw : String(raw ?? '').split(',');
    const options = [];

    for (const entry of source) {
        const text = String(entry ?? '').trim();
        // One character is a valid menu entry; duplicates are not.
        if ([...text].length < 1 || options.includes(text)) {
            continue;
        }
        options.push(text);
    }

    if (options.length === 0) {
        return [...DEFAULT_QUOTE_OPTIONS];
    }
    if (current && !options.includes(current)) {
        options.unshift(current);
    }

    return options;
}

/**
 * Resolves how a symbol is inserted into the text and where the caret goes.
 *
 * A pair (`“”`) is used whole and the caret lands between its halves, so typing
 * straight away produces `“text”`. A unit (`……`) is used whole and the caret
 * follows it, so typing continues after it. A single character can only be a unit.
 *
 * @param {string} symbol
 * @param {boolean} asPair whether the symbol is configured to enclose
 * @returns {{ open: string, close: string, paired: boolean }}
 */
function splitSymbol(symbol, asPair) {
    const characters = [...symbol];
    if (characters.length <= UNPAIRABLE_LENGTH || !asPair) {
        return { open: symbol, close: '', paired: false };
    }

    const middle = Math.ceil(characters.length / 2);
    return {
        open: characters.slice(0, middle).join(''),
        close: characters.slice(middle).join(''),
        paired: true,
    };
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
 * True when the caret sits inside an empty occurrence of the symbol, i.e. between
 * the opening and closing halves that a previous insert left behind.
 *
 * The two halves are expected to differ for a typographic pair (`“` / `”`), so the
 * check compares each half separately rather than requiring one repeated character.
 */
function caretInsideEmptyPair(value, start, end, open, close) {
    if (start !== end || open === '') {
        return false;
    }
    if (start <= 0 || start >= value.length) {
        return false;
    }
    return value.slice(start - open.length, start) === open && value.slice(start, start + close.length) === close;
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
 * Applies the current menu symbol at the caret.
 *
 * @param {HTMLTextAreaElement} textarea
 * @param {number|null} rememberedStart caret start remembered while blurred
 * @param {number|null} rememberedEnd caret end remembered while blurred
 * @param {{ quote: string, wrapSelection: boolean }} config
 * @returns {boolean} whether the textarea was modified
 */
function applyQuote(textarea, rememberedStart, rememberedEnd, config) {
    const symbol = config.quote;
    const asPair = config.pairSymbols.includes(symbol);
    const { open, close, paired } = splitSymbol(symbol, asPair);
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

    if (selected.length > 0 && config.wrapSelection && paired) {
        // Wrap the selection in the symbol: `说话` -> `“说话”`, `「」` and so on.
        return editTextarea(textarea, start, end, `${open}${selected}${close}`, end + symbol.length);
    }

    if (selected.length > 0) {
        // Replacing: the symbol goes in whole and the caret follows it.
        return editTextarea(textarea, start, end, symbol, start + symbol.length);
    }

    // No selection: insert the symbol once, with the caret where typing continues —
    // between the halves of a pair, after a standalone unit.
    if (paired && caretInsideEmptyPair(value, start, end, open, close)) {
        // Already between the halves: step over the closing one like an editor.
        textarea.focus();
        textarea.setSelectionRange(start + open.length, start + open.length);
        return false;
    }

    return editTextarea(textarea, start, end, symbol, start + open.length);
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

/**
 * Toggles the open/close animations.
 *
 * The flag lives on <html> rather than on the menu, because the menu element is
 * replaced whenever its contents change — a class on the element would be lost
 * with it, and the stylesheet would have to be rebuilt.
 */
function applyAnimationPreference(config) {
    document.documentElement?.classList.toggle('tt-quick-quote-no-anim', !config.animations);
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

    // Hovering the button offers the other quote pairs; the main click still
    // inserts the current one, so the quick path stays a single click.
    //
    // The open is deferred by a hair: a tap fires `pointerenter` immediately
    // before `click`, so without the delay the menu would flash open and shut on
    // every tap. A real hover easily outlasts the delay, so nothing is lost.
    let hoverOpenTimer = null;
    const cancelHoverOpen = () => {
        if (hoverOpenTimer !== null) {
            clearTimeout(hoverOpenTimer);
            hoverOpenTimer = null;
        }
    };

    button.addEventListener('pointerenter', () => {
        if (prefersTapForMenu(readConfig())) {
            return;
        }
        document.getElementById(MENU_ID)?.cancelClose?.();
        cancelHoverOpen();
        hoverOpenTimer = setTimeout(() => {
            hoverOpenTimer = null;
            openMenu();
        }, HOVER_OPEN_DELAY_MS);
    });

    button.addEventListener('pointerleave', () => {
        cancelHoverOpen();
        if (prefersTapForMenu(readConfig())) {
            return;
        }
        document.getElementById(MENU_ID)?.appendCloseDelay?.();
    });

    // A press means this was a tap or click, not a hover: the click handler owns
    // the outcome, so drop the pending hover-open.
    button.addEventListener('pointerdown', cancelHoverOpen);

    button.addEventListener('focus', openMenu);
    button.addEventListener('blur', cancelHoverOpen);

    button.addEventListener('click', event => {
        event.preventDefault();
        const textarea = getTextarea();
        if (!textarea) {
            return;
        }

        // Touch: the first tap opens the menu instead of inserting, and a second
        // tap inserts the current pair straight away — so a phone user can still
        // get the default quote with two taps and any other pair with one more.
        // The flag distinguishes "this tap opened it" from "it was already open",
        // which matters because a tap also fires `pointerenter`.
        const config = readConfig();
        if (prefersTapForMenu(config)) {
            if (button.dataset.tapOpenedMenu === 'true') {
                delete button.dataset.tapOpenedMenu;
            } else {
                button.dataset.tapOpenedMenu = 'true';
                openMenu();
                // Keep this click away from the document-level "tap outside
                // closes the menu" handler, which would close it immediately.
                event.stopPropagation();
                return;
            }
        }

        // A stray focus change between mousedown and click would move the caret to
        // the end of the text (a blurred textarea collapses its selection), so the
        // live caret is captured here as well; applyQuote prefers it when focused.
        store.selection = { start: textarea.selectionStart, end: textarea.selectionEnd };
        applyQuote(textarea, store.selection.start, store.selection.end, readConfig());
        closeMenu();
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
// Quote picker menu
// ---------------------------------------------------------------------------

function isMenuOpen() {
    return document.getElementById(MENU_ID)?.classList.contains('open') ?? false;
}

/**
 * Keeps the menu inside the window.
 *
 * Placement itself is CSS's job (`position: absolute; left: 50%; bottom: calc(100% + 6px)`
 * against the button's row). The only measurement here guards a very short window: if the
 * menu's top edge would leave the window, its height is capped so it scrolls instead. The
 * comparison is against the literal `0`, both sides viewport-relative, so page scaling
 * cannot distort it — unlike the previous versions, which fed rect values into CSS lengths
 * and inverted under the UI Zoom extension.
 */
function positionMenu(menu) {
    // Two steps, so `getBoundingClientRect()` is never read from a menu that an existing
    // cap could have shortened.
    menu.style.maxHeight = '';
    const overflow = -menu.getBoundingClientRect().top;
    if (overflow > 0) {
        const cap = Math.max(menu.offsetHeight - overflow - MENU_GAP_PX, MIN_MENU_HEIGHT);
        menu.style.maxHeight = `${Math.round(cap)}px`;
    }
}


/**
 * Signature of everything the menu renders.
 *
 * The menu is rebuilt on open when this changes, so the highlighted "current"
 * pair is always the one the button would insert, no matter which code path or
 * settings file changed it last.
 */
function menuSignature() {
    const config = readConfig();
    return `${config.quote}\u0000${config.quoteOptions.join('\u0000')}`;
}

/**
 * Shows the menu, rebuilding it first.
 *
 * The rebuild is unconditional, and that is deliberate. It used to be skipped whenever a
 * signature of `quote` + `quoteOptions` was unchanged, on the assumption that the mounted
 * menu must match those values. It did not: the menu that ended up on screen had been
 * built while the settings were not readable yet, so it contained no options at all —
 * just the padding and border, about 36px wide, which looked exactly like a positioning
 * bug and sent me chasing the layout for a long time. Nothing rebuilt it afterwards
 * because the signature matched the (correct) current settings, and a comparison against
 * a signature cannot detect that the element itself is stale.
 *
 * Rebuilding eight buttons on each open is cheap, and it makes that whole failure mode
 * impossible: what is shown is always built from the settings as they are now.
 */
function openMenu() {
    const menu = document.getElementById(MENU_ID);
    if (!menu) {
        return;
    }

    refreshMenu(menu.store);

    const current = document.getElementById(MENU_ID);

    // Drop any close the previous menu had already scheduled. Without this the menu
    // would open and be shut again a moment later by a timer it inherited: the close
    // delay outlives the hover, and the menu flashed as a thin sliver instead of
    // appearing. `cancelClose` is stored on the element, so it has to be read from the
    // element that is actually mounted now.
    current?.cancelClose?.();
    current?.classList.add('open');

    // The menu's width is deliberately left to CSS.
    //
    // Three attempts were made to size it from JavaScript and all three were wrong:
    // an inline width from `scrollWidth` grew on every open (208 -> 294 -> 337) because
    // `scrollWidth` reports the overflow before `max-width` has constrained it; setting
    // it once still made the menu wider than the space it had; and deriving it from the
    // option count ignored the app's own icon size and zoom.
    //
    // CSS is where this belongs, and the app has already solved the hard part: the zoom
    // extension caps popups with `max-width: calc(100vw / var(--tt-ui-zoom))`, precisely
    // because CSS `zoom` scales px-based content while the frame stays viewport-sized. Its
    // own comment records that a long panel "can spill outside the window" otherwise.
    // This menu is capped the same way in the stylesheet.

    positionMenu(current);
    if (current) {
        const first = current.children[0];
        const style = getComputedStyle(current);
        const sheets = [...(document.styleSheets ?? [])];
        let hasOurRules = false;
        let unreachable = 0;
        for (const sheet of sheets) {
            try {
                for (const rule of sheet.cssRules ?? []) {
                    if (String(rule.selectorText ?? '').includes('tt_quick_quote')) {
                        hasOurRules = true;
                    }
                }
            } catch {
                unreachable += 1;
            }
        }

        // Every rule whose selector actually matches the menu, with the sizing properties.
        // A flex container cannot be narrower than its child (44px child, 36px parent
        // above), so some other rule must be constraining it — this names that rule
        // instead of guessing at it.
        const hits = [];
        for (const sheet of sheets) {
            let rules;
            try {
                rules = sheet.cssRules ?? [];
            } catch {
                continue;
            }
            for (const rule of rules) {
                const selector = rule.selectorText;
                if (!selector || !rule.style) {
                    continue;
                }
                let matches = false;
                try {
                    matches = current.matches(selector);
                } catch {
                    matches = false;
                }
                if (!matches) {
                    continue;
                }
                const sizing = ['width', 'max-width', 'min-width', 'display', 'flex', 'box-sizing', 'zoom', 'contain']
                    .filter(property => rule.style.getPropertyValue(property))
                    .map(property => `${property}:${rule.style.getPropertyValue(property)}${rule.style.getPropertyPriority(property) ? '!' : ''}`);
                if (sizing.length) {
                    hits.push(`${selector} { ${sizing.join('  ')} }`);
                }
            }
        }
        for (const hit of hits.slice(0, 12)) {
        }

        // Direct measurement of the constraint: `offsetWidth` reports 36 while a child
        // reports 44, which a plain flex container cannot do. These three numbers say
        // whether the box is being limited by the parent or by its own computed width.
        const parentBox = current.parentElement?.getBoundingClientRect();
    }
}

/**
 * Whether the pointer is currently on the button or the menu.
 *
 * Used to tell a real dismissal apart from a stray event: several handlers fire for
 * reasons unrelated to the user's intent (a webview `blur`, a close delay that outlives
 * the hover), and closing on those made the menu flicker shut under the cursor.
 */
function pointerHoversMenuOrButton() {
    const candidates = [document.getElementById(BUTTON_ID), document.getElementById(MENU_ID)];
    return candidates.some(element => element?.matches?.(':hover'));
}


function closeMenu() {
    document.getElementById(MENU_ID)?.classList.remove('open');
    // Forget that a tap opened the menu: the next tap must open it again rather
    // than being mistaken for the follow-up tap that inserts.
    const button = document.getElementById(BUTTON_ID);
    if (button) {
        delete button.dataset.tapOpenedMenu;
    }
}

/**
 * Builds the menu row: one button per configured quote pair, with the pair the
 * main button currently inserts marked as active.
 */
function createMenu(store) {
    const menu = document.createElement('div');
    menu.id = MENU_ID;
    menu.setAttribute('role', 'menu');
    menu.setAttribute('aria-label', '选择要插入的符号');

    const openTimer = { id: null };
    const cancelClose = () => {
        if (openTimer.id !== null) {
            clearTimeout(openTimer.id);
            openTimer.id = null;
        }
    };
    // Closing is decided when the timer fires, not when it is scheduled: the pointer may
    // have come back to the button or moved onto the menu in the meantime, and closing
    // then would make the menu flicker shut under the cursor.
    const pointerIsOnUs = () => {
        const button = document.getElementById(BUTTON_ID);
        return [button, menu].some(element => element?.matches?.(':hover'));
    };
    const scheduleClose = () => {
        cancelClose();
        openTimer.id = setTimeout(() => {
            openTimer.id = null;
            if (pointerIsOnUs()) {
                return;
            }
            closeMenu();
        }, MENU_CLOSE_DELAY_MS);
    };

    menu.appendCloseDelay = scheduleClose;
    menu.cancelClose = cancelClose;
    // Kept on the element so a refresh triggered from `openMenu` can rebuild it
    // without the store having to be threaded through every caller.
    menu.store = store;

    const config = readConfig();
    menu.dataset.signature = menuSignature();
    for (const option of config.quoteOptions) {
        const item = document.createElement('div');
        item.className = 'tt-quick-quote-option';
        item.dataset.quote = option;
        item.setAttribute('role', 'menuitem');
        item.setAttribute('tabindex', '0');
        item.title = `插入 ${option}（并把它设为按钮的默认符号）`;
        if (option === config.quote) {
            item.classList.add('active');
        }
        if (option === config.quote) {
            item.setAttribute('aria-current', 'true');
        }

        const label = document.createElement('span');
        label.textContent = option;
        item.append(label);
        item.addEventListener('click', () => selectQuoteOption(store, option, item));
        item.addEventListener('keydown', event => {
            if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                selectQuoteOption(store, option, item);
            }
        });

        menu.append(item);
    }

    // Always interactable, but only visible while the menu is open or hovered.
    menu.addEventListener('pointerenter', cancelClose);
    menu.addEventListener('pointerleave', scheduleClose);
    return menu;
}

/**
 * Inserts one menu option and remembers it as the pair the main button uses next
 * time, so the two always agree about what "the" quote is.
 *
 * The menu is *not* rebuilt here: the picked element must survive long enough for
 * its confirmation animation to play, and the only thing that changed is which
 * option is current — which `markActiveOption` updates in place. The button glyph
 * and the stored settings are refreshed as usual.
 */
function selectQuoteOption(store, option, sourceElement) {
    writeConfig({ quote: option });
    insertCurrentQuote(store);
    markActiveOption(option);
    sourceElement?.classList.add('picked');
    // Only the button and the animation flag are refreshed here; rebuilding the
    // menu now would throw away the element that is still animating. The menu
    // rebuilds itself on the next open, because its signature changed.
    applyAnimationPreference(readConfig());
    mountButton(store);
}

/** Moves the "current pair" highlight without rebuilding the menu. */
function markActiveOption(option) {
    const menu = document.getElementById(MENU_ID);
    if (!menu) {
        return;
    }

    for (const item of menu.children) {
        const isActive = item.dataset.quote === option;
        item.classList.toggle('active', isActive);
        if (isActive) {
            item.setAttribute('aria-current', 'true');
        } else {
            item.removeAttribute('aria-current');
        }
    }
}

/**
 * Inserts the currently configured pair at the caret, then closes the menu.
 *
 * The caret is whatever the caller remembered; that memory lives on the button's
 * store, so a caller without one — the settings panel, which has no caret of its
 * own — leaves the textarea alone and only closes the menu.
 */
function insertCurrentQuote(store) {
    const textarea = getTextarea();
    if (textarea && store) {
        store.selection = { start: textarea.selectionStart, end: textarea.selectionEnd };
        applyQuote(textarea, store.selection.start, store.selection.end, readConfig());
    }
    closeMenu();
}

/**
 * Where the menu lives: inside `#send_form`, the full-width input bar.
 *
 * The mount point decides how wide the menu may become, and that took a long time to
 * notice. It used to live in `#rightSendForm` — the 109px box holding the button — so its
 * available width *was* 109px: `max-width` can only cap a box, never widen it, so eight
 * options were compressed to one and the menu rendered as a ~36px sliver no matter how the
 * width was declared. Measured on the live menu: parent 109px, menu 36px, content 154px.
 *
 * `#send_form` spans the whole input bar (`730px` in the same window), so the row has room.
 * The menu is pinned to that bar's right edge, which is where the button is; anchoring to
 * the button's own row is what made it impossible.
 *
 * The bar must be a positioning context, or `bottom` resolves against the viewport.
 */
function getMenuHost() {
    const host = document.getElementById('send_form')
        ?? document.getElementById('form_sheld')
        ?? document.body;

    if (host === document.body) {
        return host;
    }

    if (getComputedStyle(host).position === 'static') {
        host.style.position = 'relative';
    }

    return host;
}

/** Rebuilds the menu contents, keeping it open (and in place) if it already was. */
function refreshMenu(store) {
    const existing = document.getElementById(MENU_ID);
    if (!existing) {
        return false;
    }

    const wasOpen = isMenuOpen();
    existing.remove();
    getMenuHost().append(createMenu(store));
    if (wasOpen) {
        openMenu();
    }
    return true;
}

function mountMenu(store) {
    if (document.getElementById(MENU_ID) || !document.body) {
        return Boolean(document.getElementById(MENU_ID));
    }

    getMenuHost().append(createMenu(store));
    watchMenuAnchor();
    return true;
}

let windowHandlersInstalled = false;
let menuAnchorObserver = null;

/** Re-runs the placement maths for an open menu; a no-op while it is closed. */
function repositionOpenMenu() {
    const menu = document.getElementById(MENU_ID);
    if (menu && isMenuOpen()) {
        positionMenu(menu);
    }
}

/** Closes the menu when the window loses focus and keeps it glued to the button. */
function installWindowHandlers() {
    if (windowHandlersInstalled) {
        return;
    }
    windowHandlersInstalled = true;

    window.addEventListener('blur', () => {
        // Not while the pointer is still on the button or the menu. A desktop webview
        // fires `blur` for reasons that have nothing to do with this menu — focus moving
        // between elements, or the window not being active when the pointer arrives — and
        // closing then made the menu snap shut the instant it opened, which is what the
        // "shows as a thin sliver" report actually was: three closes were logged for one
        // hover. Closing on every blur is only safe if the pointer has genuinely left.
        if (pointerHoversMenuOrButton()) {
            return;
        }
        document.getElementById(MENU_ID)?.cancelClose?.();
        closeMenu();
    });
    window.addEventListener('resize', repositionOpenMenu);

    // Touch has no hover, so nothing would otherwise close a menu that was opened
    // by a tap. A tap anywhere else dismisses it. (Deliberately no pointer capture
    // on the button: releasing a captured pointer fires `pointerleave`, which would
    // close the menu the instant the finger lifts.)
    document.addEventListener('click', event => {
        if (!isMenuOpen()) {
            return;
        }
        const target = event.target;
        if (target?.closest?.(`#${MENU_ID}`) || target?.closest?.(`#${BUTTON_ID}`)) {
            return;
        }
        closeMenu();
    }, true);
}

/**
 * Keeps the menu glued to the button while the layout moves underneath it.
 *
 * The position is computed from measured rectangles, so anything that shifts the
 * input bar — the textarea growing as the user types, a window resize, the app
 * rearranging its columns — would otherwise leave the menu floating over the
 * button, which is exactly the bug this guards against.
 */
function watchMenuAnchor() {
    if (menuAnchorObserver || typeof ResizeObserver !== 'function') {
        return;
    }

    menuAnchorObserver = new ResizeObserver(repositionOpenMenu);
    const textarea = getTextarea();
    if (textarea) {
        menuAnchorObserver.observe(textarea);
    }
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
    applyAnimationPreference(readConfig());
    mountButton(store);
    refreshMenu(store);
}

function createPanel(store) {
    const config = readConfig();
    const container = document.createElement('div');
    container.id = PANEL_ID;
    container.className = 'extension_container';
    container.innerHTML = `
        <div class="inline-drawer">
            <div class="inline-drawer-toggle inline-drawer-header">
                <b>快捷符号按钮</b>
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
                    <span class="tt-quick-quote-label">符号</span>
                    <input type="text" id="tt_quick_quote_pair" class="text_pole tt-quick-quote-pair"
                        maxlength="16" value="${escapeAttribute(config.quote)}"
                        title="按钮当前插入的符号，例如 “” 「」 …… ——。它就是按钮上显示的那一个。">
                </div>

                <div class="tt-quick-quote-row">
                    <span class="tt-quick-quote-label">快捷键</span>
                    <input type="text" id="tt_quick_quote_shortcut" class="text_pole tt-quick-quote-shortcut"
                        placeholder="留空 = 不用快捷键" value="${escapeAttribute(config.shortcut)}"
                        title="例如 Ctrl+Alt+Q。需要带修饰键，且只在输入框聚焦时生效。">
                </div>

                <div class="tt-quick-quote-row">
                    <span class="tt-quick-quote-label">快捷菜单</span>
                    <select id="tt_quick_quote_menu_mode" class="text_pole tt-quick-quote-mode"
                        title="按钮上方那排符号菜单怎么打开。手机/平板没有悬停，自动模式下改为点一下按钮打开。">
                        <option value="auto">自动（触屏点按打开，鼠标悬停打开）</option>
                        <option value="always">总是用点按打开</option>
                        <option value="never">只用鼠标悬停，点按直接插入</option>
                    </select>
                </div>

                <label class="checkbox_label" title="勾选时给选中的文字套上符号；取消勾选则只插入符号，不包裹选中内容。">
                    <input type="checkbox" id="tt_quick_quote_wrap">
                    <span>选中文字时给它套上符号</span>
                </label>

                <label class="checkbox_label" title="菜单弹出和收起时带一段缩放淡入动画。取消勾选则瞬间出现／消失。">
                    <input type="checkbox" id="tt_quick_quote_animations">
                    <span>菜单弹出动画</span>
                </label>

                <div class="tt-quick-quote-subhead">菜单里的符号</div>
                <div class="tt-quick-quote-hint-line">
                    鼠标停在按钮上（手机上点一下按钮）会弹出这一排。放引号、括号、省略号、破折号都行。
                </div>
                <div id="tt_quick_quote_options" class="tt-quick-quote-options"></div>
                <div class="tt-quick-quote-row">
                    <input type="text" id="tt_quick_quote_new_option" class="text_pole tt-quick-quote-new-option"
                        maxlength="16" placeholder="加上一个符号，例如 ……"
                        title="输入一个符号后按回车，或点右边的「添加」。">
                    <div id="tt_quick_quote_add_option" class="menu_button menu_button_icon" title="添加到菜单末尾">
                        <i class="fa-solid fa-plus"></i>
                        <span>添加</span>
                    </div>
                    <div id="tt_quick_quote_reset_options" class="menu_button menu_button_icon" title="恢复成默认的那几个符号">
                        <i class="fa-solid fa-rotate-left"></i>
                    </div>
                </div>

                <small class="tt-quick-quote-hint">
                    按钮在发送键左边。点菜单里的一个符号就会插入它，并把它记为按钮的默认符号 ——
                    也就是「符号」那一栏和按钮上显示的那一个。<br>
                    每行中间那个按钮管<b>光标插完停哪儿</b>，点一下切换（按钮文字短，所以写成
                    <b>符号内</b>／<b>符号后</b>，鼠标停上去有完整说明）：<br>
                    <b>符号内</b> = 光标停在符号中间，如 <b>“|”</b> —— 直接打字就在里面，
                    选中文字时会把它包起来；<br>
                    <b>符号后</b> = 光标跟在符号后面，如 <b>……|</b> —— 不会跑到符号中间去。<br>
                    <b>按钮大小</b>只影响按钮上的字符，输入栏的按钮方框大小仍由 App 的图标尺寸决定，
                    所以调它不会把输入栏撑变形。
                </small>
            </div>
        </div>
    `;

    // `bindPanel` runs after the panel is in the document, because the editable
    // quote list is looked up by id.
    return container;
}

/**
 * Renders one editable row per quote pair in the menu.
 *
 * The list element is passed in rather than looked up by id: the panel is queried
 * for its own children, which keeps the order of "mount, then bind" out of it.
 *
 * Editing happens in place: the inputs are only rebuilt when the set of pairs
 * changes, so typing in a field is never interrupted by a re-render.
 */
function renderQuoteOptionList(store, list) {
    if (!list) {
        return;
    }

    const config = readConfig();
    list.textContent = '';

    for (const option of config.quoteOptions) {
        const row = document.createElement('div');
        row.className = 'tt-quick-quote-option-row';
        row.dataset.quote = option;

        const dot = document.createElement('span');
        dot.className = 'tt-quick-quote-active-dot';
        dot.title = '按钮当前用的就是这个符号';
        dot.setAttribute('aria-hidden', 'true');

        const input = document.createElement('input');
        input.type = 'text';
        input.className = 'text_pole tt-quick-quote-option-input';
        input.maxLength = MAX_SYMBOL_LENGTH;
        input.value = option;
        input.title = '这个符号。改完按回车或点别处生效。';
        input.addEventListener('change', () => {
            const value = input.value.trim();
            const current = readConfig();
            const options = current.quoteOptions;
            // An empty or duplicate symbol is rejected by putting the old one back.
            if ([...value].length < 1 || options.some(existing => existing === value && existing !== option)) {
                input.value = option;
                return;
            }
            const next = options.map(existing => (existing === option ? value : existing));
            const pairSymbols = current.pairSymbols.map(existing => (existing === option ? value : existing))
                .filter(existing => [...existing].length > UNPAIRABLE_LENGTH);
            const keepsCurrent = current.quote !== option;
            writeConfig({ quoteOptions: next, pairSymbols, ...(keepsCurrent ? {} : { quote: value }) });
            refreshUi(store);
            renderQuoteOptionList(store, list);
        });

        // Where the caret lands after inserting this symbol.
        const asPair = config.pairSymbols.includes(option);
        const canPair = [...option].length > UNPAIRABLE_LENGTH;
        const mode = document.createElement('div');
        mode.className = 'menu_button tt-quick-quote-mode-option';
        // Always prefixed with the symbol so the row reads as one sentence about it. The
        // space matters: without it the symbol runs straight into the wording
        // (`“”光标停在符号中间`), which reads as though the symbol were part of the phrase.
        mode.textContent = `${option} ${asPair ? MODE_LABELS.PAIR : MODE_LABELS.WHOLE}`;
        mode.title = canPair ? (asPair ? MODE_TITLES.PAIR : MODE_TITLES.WHOLE) : MODE_TITLES.SINGLE;
        if (canPair) {
            mode.classList.toggle('active', asPair);
            mode.addEventListener('click', () => {
                const current = readConfig();
                const pairSymbols = asPair
                    ? current.pairSymbols.filter(existing => existing !== option)
                    : [...current.pairSymbols, option];
                writeConfig({ pairSymbols });
                renderQuoteOptionList(store, list);
            });
        } else {
            mode.classList.add('disabled');
        }

        const active = document.createElement('div');
        active.className = 'menu_button menu_button_icon tt-quick-quote-use-option';
        active.title = '把这一项设为按钮当前使用的符号';
        const activeIcon = document.createElement('i');
        activeIcon.className = 'fa-solid fa-check';
        active.append(activeIcon);
        active.addEventListener('click', () => {
            selectQuoteOption(store, input.value.trim(), null);
            syncQuoteOptionList(list);
        });

        const remove = document.createElement('div');
        remove.className = 'menu_button menu_button_icon tt-quick-quote-remove-option';
        remove.title = '从菜单里删掉这一项';
        const removeIcon = document.createElement('i');
        removeIcon.className = 'fa-solid fa-trash-can';
        remove.append(removeIcon);
        remove.addEventListener('click', () => {
            const current = readConfig();
            const next = current.quoteOptions.filter(existing => existing !== option);
            const pairSymbols = current.pairSymbols.filter(existing => existing !== option);
            if (next.length === 0) {
                // Never leave the menu empty; fall back to the shipped symbols.
                writeConfig({ quoteOptions: [...DEFAULT_QUOTE_OPTIONS], pairSymbols: [...DEFAULT_PAIR_SYMBOLS] });
            } else {
                // Removing the symbol the button uses moves it to whatever is left.
                writeConfig({ quoteOptions: next, pairSymbols, ...(current.quote === option ? { quote: next[0] } : {}) });
            }
            refreshUi(store);
            renderQuoteOptionList(store, list);
        });

        row.append(dot, input, mode, active, remove);
        list.append(row);
    }

    syncQuoteOptionList(list);
}

/** Moves the "this is the current symbol" dot without rebuilding the rows. */
function syncQuoteOptionList(list) {
    if (!list) {
        return;
    }

    const current = readConfig().quote;
    for (const row of list.children) {
        row.classList.toggle('active', row.dataset.quote === current);
    }
}

/** Appends the pair typed into the "add" field, if it is usable. */
function addQuoteOption(store, list) {
    const input = document.getElementById(NEW_OPTION_ID);
    const value = input?.value.trim() ?? '';
    const options = readConfig().quoteOptions;

    if ([...value].length < 1 || options.includes(value)) {
        return;
    }

    writeConfig({ quoteOptions: [...options, value] });
    if (input) {
        input.value = '';
    }
    refreshUi(store);
    renderQuoteOptionList(store, list);
}

/**
 * Re-renders the panel's quote list from the stored settings.
 *
 * Exported for the self-check harness in `check.mjs`, which drives this module
 * without a browser: it changes the stored pairs the way editing settings.json
 * would, then needs the panel to catch up. Nothing in the app calls it — the panel
 * renders itself when it is bound.
 */
export function refreshQuoteOptionList() {
    renderQuoteOptionList(null, document.getElementById(OPTION_LIST_ID));
}

/** Renders the panel list when the panel is (re)bound. */
function mountQuoteOptionList(store, list) {
    if (!list) {
        return false;
    }
    renderQuoteOptionList(store, list);
    return true;
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
    const animations = container.querySelector('#tt_quick_quote_animations');
    const menuMode = container.querySelector('#tt_quick_quote_menu_mode');
    const addOption = container.querySelector('#tt_quick_quote_add_option');
    const newOption = container.querySelector('#tt_quick_quote_new_option');
    const resetOptions = container.querySelector('#tt_quick_quote_reset_options');
    const optionList = container.querySelector('#tt_quick_quote_options');

    // Reflect the stored values (the panel markup above is only a first guess).
    const config = readConfig();
    enabled.checked = config.enabled;
    wrap.checked = config.wrapSelection;
    animations.checked = config.animations;
    scale.value = String(config.glyphScale);
    scaleValue.textContent = `${config.glyphScale}%`;
    menuMode.value = config.menuMode;

    // The list is generated from the stored pairs, so it is not part of the markup.
    mountQuoteOptionList(store, optionList);

    animations.addEventListener('input', () => {
        writeConfig({ animations: animations.checked });
        applyAnimationPreference(readConfig());
    });

    menuMode.addEventListener('change', () => {
        if (!MENU_MODES.includes(menuMode.value)) {
            menuMode.value = readConfig().menuMode;
            return;
        }
        writeConfig({ menuMode: menuMode.value });
        refreshUi(store);
    });

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
        if ([...value].length < 1) {
            // Reject silently by snapping back rather than storing an unusable pair.
            pair.value = readConfig().quote;
            return;
        }
        writeConfig({ quote: value });
        refreshUi(store);
        syncQuoteOptionList(optionList);
    });

    addOption.addEventListener('click', () => addQuoteOption(store, optionList));
    newOption.addEventListener('keydown', event => {
        if (event.key === 'Enter') {
            event.preventDefault();
            addQuoteOption(store, optionList);
        }
    });
    resetOptions.addEventListener('click', () => {
        writeConfig({ quoteOptions: [...DEFAULT_QUOTE_OPTIONS], pairSymbols: [...DEFAULT_PAIR_SYMBOLS] });
        refreshUi(store);
        renderQuoteOptionList(store, optionList);
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
 * Mounts the settings panel at the top of the Extensions column that already holds
 * the other extensions.
 *
 * Two things drive the placement:
 *
 * - The app ships two columns and fills them by convention, so an empty column would
 *   leave this panel sitting on its own; the column with the most children is used.
 * - It goes in **first**, not last. Those columns are `display: flex` with
 *   `flex-direction: column` and hold every built-in extension, and below 1000px the
 *   app stacks the two columns full-width — so anything appended to the end lands
 *   far down the drawer and has to be scrolled to. First position keeps the panel
 *   reachable at every window size.
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

    const panel = createPanel(store);
    // In the document before binding: the editable symbol list is generated from the
    // stored settings, so it needs the panel to be reachable by id.
    host.prepend(panel);
    bindPanel(panel, store);
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
        applyAnimationPreference(readConfig());
        mountButton(store);
        mountMenu(store);
        installShortcut(store);
        installWindowHandlers();
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
        // The menu lives outside the input bar, so it is checked separately.
        if (started && !document.getElementById(MENU_ID)) {
            mountMenu(store);
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
