import { simulateFactoryStep } from './factory-core.mjs';

// Game State: items and recipes from SQLite via GET /api/items; discoveries sync with POST /api/items/upsert.
// No localStorage — inventory is session memory only.
/** Base factory width/height before size upgrades */
const FACTORY_GRID_BASE = 8;
/** Default tick interval; Speed +1 multiplies current interval by 0.9 (−10%) */
const FACTORY_LOOP_MS_DEFAULT = 500;
const MIN_FACTORY_LOOP_MS = 33;
/** Max Size +1 presses; each adds one row/col on every side (grid side = BASE + 2×level) */
const MAX_FACTORY_SIZE_LEVEL = 10;

const state = {
    library: [],
    recipes: {},
    activeElements: [],
    draggedItem: null,
    pendingCombination: null,
    /** Pending discovery notices waiting to be opened from floating button. */
    pendingDiscoveryNotices: [],
    /** @type {{ name: string, emoji: string }[]} last AI suggestions (emoji + name) */
    aiSuggestions: [],
    /** Chosen discovery name (must be one of aiSuggestions); no free typing */
    discoverySelectedName: '',
    /** Hex color for discovery name label (optional, e.g. #f87171) */
    discoveryNameColor: '',
    /** 'lab' | 'factory' */
    activeWorkspace: 'lab',
    /** Crafted / factory output counts; separate from the discovery library. */
    playerInventory: {},
    /** Server runtime status for this user's factory. */
    factoryRuntime: {
        running: false,
        remainingMs: 0,
        runStoppedAt: null,
        runUntilAtMs: 0,
        statsPerMinute: []
    },
    factory: {
        /** @type {Record<string, 'transporter' | 'extractor' | 'combiner' | 'storage' | 'sorter' | 'bridge'>} key "col,row" */
        placements: {},
        /** @type {null | 'transporter' | 'extractor' | 'combiner' | 'storage' | 'sorter' | 'bridge'} */
        selectedBuilding: null,
        /**
         * Optional resource deposits on inner cells (item id, e.g. wood, flint).
         * Legacy: direct deposit on a cell. Superseded for new setups by gatheringPoints + ring.
         * @type {Record<string, string>}
         */
        cellResources: {},
        /**
         * Gathering hub per cell: one cell shows the deposit; eight neighbors (incl. diagonals) are extractable.
         * Hub cell is blocked for buildings; value is material item id (e.g. wood).
         * @type {Record<string, string>}
         */
        gatheringPoints: {},
        /** When set, next click on the grid places a gathering hub for this base material. */
        gatheringPlaceMaterialId: /** @type {null | string} */ (null),
        /** Transporter flow: 0 = up, 1 = right, 2 = down, 3 = left (➡ + rotate offset in UI) */
        transporterDirs: {},
        /** Sorter output direction: 0 up, 1 right, 2 down, 3 left */
        sorterDirs: {},
        /** Sorter key -> locked item id after first successful pull */
        sorterItemFilters: {},
        /** Bridge output direction: 0 up, 1 right, 2 down, 3 left */
        bridgeDirs: {},
        /** 0 = BASE×BASE; each +1 adds a border row/col on all four sides (placements shift inward) */
        sizeUpgradeLevel: 0,
        /** Factory simulation loop interval (ms); Speed +1 → round(current × 0.9) */
        loopMs: FACTORY_LOOP_MS_DEFAULT,
        /** Increments each factory loop tick (for future sim / UI) */
        loopTick: 0,
        /** Items on floor/belts: key "col,row" → item id (wood, crafted ids, …) */
        cellItems: {},
        /** performance.now() until which sim tick pulse is drawn on the factory canvas */
        loopPulseUntil: 0,
        /** Combiner output direction: 0 up, 1 right, 2 down, 3 left */
        combinerDirs: {},
        /** Unknown recipe at combiner: key → { a: id, b: id, comboKey } */
        combinerDiscovery: {},
        /** When discovery modal opened from factory combiner, cell key to resolve on save */
        factoryDiscoveryCombinerKey: null,
        /** Smooth belt moves: dest key → { fromKey, startT, durMs } (durMs = factory loop interval) */
        itemSlides: {},
        /** While dragging to place transporters: cells (filtered) for preview overlay */
        beltDragPreview: /** @type {null | { col: number, row: number }[]} */ (null),
        /** Combiner cell key → performance.now() until red "rejected combo" flash ends */
        cellRejectFlashUntil: /** @type {Record<string, number>} */ ({}),
        /** Camera center in world cell-space (cell center coordinates). */
        cameraX: (FACTORY_GRID_BASE - 1) / 2,
        cameraY: (FACTORY_GRID_BASE - 1) / 2,
        /** Camera zoom multiplier (1 = default). */
        cameraZoom: 1
    },
    /** Last icon URL chosen in discovery modal (before saving). */
    discoveryPreviewUrl: '',
    /** Uploaded custom icon as data URL (before saving). */
    discoveryPreviewDataUrl: '',
    /** Item id for which we are generating / saving an icon */
    discoveryIconItemId: '',
    /** Filled when moving to icon step — for image prompt (name was cleared from picker state) */
    discoveryIconItemName: '',
    auth: {
        token: '',
        username: '',
        playerPingTimerId: null,
        factoryRuntimeTimerId: null,
        factoryRuntimeUiTimerId: null,
        enteringFactory: false
    },
    /** comboKey -> true; user cancelled naming earlier */
    deferredDiscoveries: {}
};

/** Base catalog from DB (merged with live combo index for tier calculation). */
let cachedBaseItemsMap = null;
const GLOBAL_DISCOVERIES_PER_PAGE = 50;
/** @type {{ id: string, emoji: string, name: string, nameColor?: string, discoveredAt?: string, ingredientA?: string, ingredientB?: string, ingredientAText?: string, ingredientBText?: string, upvotes?: number, downvotes?: number }[]} */
let globalDiscoveriesRows = [];
let globalDiscoveriesPage = 1;
let globalDiscoveriesSort = 'datetime';
let globalDiscoveriesExpandedId = '';
/** @type {string} */
let discoveryEditTargetId = '';
/** @type {'' | 'a' | 'b'} */
let discoveryEditSlot = '';
let discoveryEditSearchTimer = 0;
let dbViewerTables = [];
let dbViewerSelectedTable = '';
let dbViewerPrimaryKey = [];
let dbViewerHasRowid = false;
let dbViewerColumns = [];
let dbViewerRows = [];
/** @type {Record<string, { id: number, itemId: string, proposalType: 'name'|'image', proposedName?: string, proposedImagePath?: string, createdBy: number, createdAt: string, upvotes: number, downvotes: number, myVote: number }[]>} */
let discoveryProposalsByItem = {};
let discoveryProposalTargetItemId = '';
/** @type {null | { a: any, b: any, key: string, resultId?: string, resultPlaced?: boolean, factoryCombKey?: string, name?: string, emoji?: string }} */
let deferredDiscoveryPromptPending = null;
/** Factory cell key -> performance.now() until yellow deferred flash ends */
const factoryDeferredFlashUntil = {};
const DISCOVERY_NAME_COLOR_CHOICES = [
    '#f8fafc', '#e2e8f0', '#94a3b8', '#f87171', '#fb7185',
    '#f97316', '#f59e0b', '#facc15', '#a3e635', '#4ade80',
    '#34d399', '#2dd4bf', '#22d3ee', '#38bdf8', '#60a5fa',
    '#818cf8', '#a78bfa', '#c084fc', '#e879f9', '#f472b6'
];

/** @returns {{ id: string, emoji: string, name: string } | null} */
function normalizeRecipeResult(val) {
    if (!val || typeof val.id !== 'string') return null;
    if (typeof val.emoji === 'string' && typeof val.name === 'string') {
        return { id: val.id, emoji: val.emoji.trim(), name: val.name.trim() };
    }
    if (typeof val.name === 'string') {
        const { icon, text } = splitLabel(val.name);
        return { id: val.id, emoji: icon, name: text };
    }
    return null;
}

function emojiForItemId(id) {
    const item = state.library.find((e) => e.id === id);
    if (!item) return '';
    if (typeof item.emoji === 'string') return item.emoji;
    const { icon } = splitLabel(item.name);
    return icon;
}

const factoryIconImageCache = new Map();
const clientProcessedIconCache = new Map();
const CLIENT_ICON_BG_TOLERANCE = Math.round(255 * 0.02);
const FACTORY_STATS_BUCKET_SECONDS = 10;

/** @param {string} itemId */
function factoryGetLoadedIconImage(itemId) {
    const id = String(itemId || '').trim();
    if (!id) return null;
    const item = state.library.find((e) => e.id === id);
    if (!item) return null;
    const src = iconSrcForItem(item);
    if (!src) return null;
    let rec = factoryIconImageCache.get(src);
    if (!rec) {
        const img = new Image();
        rec = { img, ready: false, failed: false };
        factoryIconImageCache.set(src, rec);
        img.onload = () => {
            rec.ready = true;
            if (state.activeWorkspace === 'factory') factoryStartRenderLoop();
        };
        img.onerror = () => {
            rec.failed = true;
        };
        img.src = src;
    }
    if (rec.failed || !rec.ready) return null;
    return rec.img;
}

function useLocalProxy() {
    // Always route OpenAI requests through our backend API so browser-side keys are never required.
    return true;
}

/** Backend that serves `/api/items`, `/api/chat`, and image APIs (defaults to same origin as the page). */
function apiOrigin() {
    const raw = typeof window !== 'undefined' && window.ALCHEMIC_API_BASE;
    if (typeof raw === 'string' && raw.trim()) {
        return raw.trim().replace(/\/$/, '');
    }
    return typeof window !== 'undefined' ? window.location.origin : '';
}

function authHeaders(headers) {
    const out = { ...(headers || {}) };
    if (state.auth.token) out.Authorization = `Bearer ${state.auth.token}`;
    return out;
}

async function apiFetch(path, options) {
    const url = `${apiOrigin()}${path}`;
    const opts = { ...(options || {}) };
    opts.headers = authHeaders(opts.headers || {});
    return fetch(url, opts);
}

async function fetchChatCompletions(body) {
    const res = await apiFetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
    });
    if (!res.ok) {
        const t = await res.text();
        throw new Error(t || `${res.status} ${res.statusText}`);
    }
    return res.json();
}

/**
 * Server-side image search; avoids browser CORS.
 * @param {{ query: string, limit?: number, offset?: number }} body
 * @returns {Promise<{ images: string[] }>}
 */
async function fetchImageSearchResults(body) {
    const res = await apiFetch('/api/images/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
    });
    if (!res.ok) {
        const t = await res.text();
        throw new Error(t || `${res.status} ${res.statusText}`);
    }
    return res.json();
}

/**
 * Sync discovered item to SQLite (dev-server). Safe no-op on failure.
 * @param {{ id: string, emoji: string, name: string, name_color?: string, ingredient_a: string, ingredient_b: string }} payload
 */
async function postItemUpsertRemote(payload) {
    try {
        const r = await apiFetch('/api/items/upsert', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });
        if (!r.ok && r.status !== 204) {
            console.warn('postItemUpsertRemote', r.status, await r.text());
        }
    } catch (e) {
        console.warn('postItemUpsertRemote', e);
    }
}

/**
 * Download image to server `images/` and set `icon_path` in DB.
 * @param {string} id
 * @param {string} imageUrl
 * @param {{ strictUserUrl?: boolean, imageDataUrl?: string }} [opts] If strictUserUrl, server enforces user size/type limits.
 * @returns {Promise<{ iconPath: string }>}
 */
async function postSaveItemIconRemote(id, imageUrl, opts) {
    const payload = { id };
    if (typeof imageUrl === 'string' && imageUrl.trim()) payload.imageUrl = imageUrl.trim();
    if (opts && typeof opts.imageDataUrl === 'string' && opts.imageDataUrl.trim()) {
        payload.imageDataUrl = opts.imageDataUrl.trim();
    }
    if (opts && opts.strictUserUrl) payload.strictUserUrl = true;
    const r = await apiFetch('/api/items/icon', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
    });
    const t = await r.text();
    if (!r.ok) throw new Error(t || `${r.status}`);
    return /** @type {{ iconPath: string }} */ (JSON.parse(t));
}

/**
 * Persist a rejected combo pair on the server.
 * @param {string} itemAId
 * @param {string} itemBId
 */
async function postRejectedCraftRemote(itemAId, itemBId) {
    try {
        const r = await apiFetch('/api/rejected-crafts', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ item_a_id: itemAId, item_b_id: itemBId })
        });
        if (!r.ok && r.status !== 204) {
            console.warn('postRejectedCraftRemote', r.status, await r.text());
        }
    } catch (e) {
        console.warn('postRejectedCraftRemote', e);
    }
}

/**
 * Check combine result against server-side database.
 * @param {string} itemAId
 * @param {string} itemBId
 * @returns {Promise<{ exists: boolean, rejected: boolean, message: string, item: null | { id: string, emoji: string, name: string, a?: string, b?: string, nameColor?: string, iconPath?: string, discoveredAt?: string } }>}
 */
async function checkCombineRemote(itemAId, itemBId) {
    const r = await apiFetch('/api/combine/check', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            item_a_id: String(itemAId || '').trim(),
            item_b_id: String(itemBId || '').trim()
        })
    });
    const t = await r.text();
    if (!r.ok) throw new Error(t || `${r.status}`);
    let payload = null;
    try {
        payload = JSON.parse(t);
    } catch {
        payload = null;
    }
    if (!payload || typeof payload !== 'object') {
        throw new Error('Invalid /api/combine/check response');
    }
    const rawItem = payload.item && typeof payload.item === 'object' ? payload.item : null;
    const item =
        rawItem && typeof rawItem.id === 'string' && typeof rawItem.name === 'string' && typeof rawItem.emoji === 'string'
            ? {
                  id: rawItem.id,
                  name: rawItem.name,
                  emoji: rawItem.emoji,
                  a: typeof rawItem.a === 'string' ? rawItem.a : '',
                  b: typeof rawItem.b === 'string' ? rawItem.b : '',
                  nameColor: typeof rawItem.nameColor === 'string' ? rawItem.nameColor : '',
                  iconPath: typeof rawItem.iconPath === 'string' ? rawItem.iconPath : '',
                  discoveredAt: typeof rawItem.discoveredAt === 'string' ? rawItem.discoveredAt : ''
              }
            : null;
    return {
        exists: payload.exists === true && !!item,
        rejected: payload.rejected === true,
        message: typeof payload.message === 'string' ? payload.message : '',
        item
    };
}

/** Merge icon paths from GET /api/items into `state.library` and `cachedBaseItemsMap`. */
async function reloadCatalogFromApi() {
    try {
        const res = await apiFetch('/api/items');
        if (!res.ok) return;
        const payload = await res.json();
        const items = payload && typeof payload.items === 'object' && payload.items !== null ? payload.items : null;
        if (!items) return;
        cachedBaseItemsMap = items;
        for (const it of state.library) {
            const d = items[it.id];
            if (d && typeof d.iconPath === 'string' && d.iconPath.trim()) {
                const iconPath = d.iconPath.trim();
                it.iconPath = iconPath;
                syncActiveElementsIconPath(it.id, iconPath);
            }
        }
        recomputeAllTiers();
        renderLibrary();
    } catch (e) {
        console.warn('reloadCatalogFromApi', e);
    }
}

/** @param {{ iconPath?: string }} item */
function iconSrcForItem(item) {
    if (!item || typeof item.iconPath !== 'string' || !item.iconPath.trim()) return null;
    const rawSrc = `${apiOrigin()}/${item.iconPath.replace(/^\/+/, '')}`;
    return getClientIconDisplaySrc(rawSrc);
}

/** @param {string} rawSrc */
function getClientIconDisplaySrc(rawSrc) {
    const src = String(rawSrc || '').trim();
    if (!src) return src;
    let rec = clientProcessedIconCache.get(src);
    if (!rec) {
        rec = { displaySrc: src, processing: false, done: false };
        clientProcessedIconCache.set(src, rec);
    }
    if (!rec.processing && !rec.done) {
        rec.processing = true;
        void processIconBackgroundOnClient(src)
            .then((nextSrc) => {
                if (!nextSrc || nextSrc === src) return;
                if (rec.displaySrc && rec.displaySrc !== src && String(rec.displaySrc).startsWith('blob:')) {
                    try {
                        URL.revokeObjectURL(rec.displaySrc);
                    } catch {}
                }
                rec.displaySrc = nextSrc;
                // Trigger refresh so existing DOM/canvas starts using processed icon.
                renderCanvas();
                renderLibrary();
                if (state.activeWorkspace === 'factory') factoryStartRenderLoop();
            })
            .catch(() => {})
            .finally(() => {
                rec.processing = false;
                rec.done = true;
            });
    }
    return rec.displaySrc;
}

/**
 * Remove top-left color in browser once, cache as object URL.
 * @param {string} src
 * @returns {Promise<string>}
 */
async function processIconBackgroundOnClient(src) {
    const img = await new Promise((resolve, reject) => {
        const el = new Image();
        el.onload = () => resolve(el);
        el.onerror = () => reject(new Error('icon load failed'));
        el.src = src;
    });
    const w = Math.max(1, Number(img.naturalWidth || img.width || 0) | 0);
    const h = Math.max(1, Number(img.naturalHeight || img.height || 0) | 0);
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) return src;
    ctx.drawImage(img, 0, 0, w, h);
    const imageData = ctx.getImageData(0, 0, w, h);
    const data = imageData.data;
    if (!data || data.length < 4) return src;
    const r0 = data[0];
    const g0 = data[1];
    const b0 = data[2];
    for (let i = 0; i < data.length; i += 4) {
        const r = data[i];
        const g = data[i + 1];
        const b = data[i + 2];
        if (
            Math.abs(r - r0) <= CLIENT_ICON_BG_TOLERANCE &&
            Math.abs(g - g0) <= CLIENT_ICON_BG_TOLERANCE &&
            Math.abs(b - b0) <= CLIENT_ICON_BG_TOLERANCE
        ) {
            data[i + 3] = 0;
        }
    }
    ctx.putImageData(imageData, 0, 0);
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
    if (!blob) return src;
    return URL.createObjectURL(blob);
}

/** @param {string} id @param {string} iconPath */
function syncActiveElementsIconPath(id, iconPath) {
    const targetId = String(id || '').trim();
    const nextIconPath = String(iconPath || '').trim();
    if (!targetId || !nextIconPath) return;
    let changed = false;
    for (const el of state.activeElements) {
        if (String(el.id || '') !== targetId) continue;
        if (String(el.iconPath || '') === nextIconPath) continue;
        el.iconPath = nextIconPath;
        changed = true;
    }
    if (!changed) return;
    // Force DOM node rebuild so workspace switches from emoji to image icon.
    const nodeList = Array.from(workspaceEl.querySelectorAll('.canvas-element'));
    for (const node of nodeList) {
        const uid = String(node && node.dataset ? node.dataset.uid || '' : '');
        if (!uid) continue;
        const item = state.activeElements.find((entry) => String(entry.uid || '') === uid);
        if (item && String(item.id || '') === targetId) node.remove();
    }
    renderCanvas();
}

/** @param {string} iconPath */
function invalidateIconProcessingCache(iconPath) {
    const rel = String(iconPath || '').trim().replace(/^\/+/, '');
    if (!rel) return;
    const rawSrc = `${apiOrigin()}/${rel}`;
    const rec = clientProcessedIconCache.get(rawSrc);
    if (rec && rec.displaySrc && rec.displaySrc !== rawSrc && String(rec.displaySrc).startsWith('blob:')) {
        try {
            URL.revokeObjectURL(rec.displaySrc);
        } catch {}
    }
    clientProcessedIconCache.delete(rawSrc);
    factoryIconImageCache.delete(rawSrc);
}

/** @param {string} id @param {string} iconPath */
function persistIconPathForItem(id, iconPath) {
    invalidateIconProcessingCache(iconPath);
    const li = state.library.findIndex((e) => e.id === id);
    const prevPath = li >= 0 && typeof state.library[li].iconPath === 'string' ? state.library[li].iconPath : '';
    if (prevPath && prevPath !== iconPath) invalidateIconProcessingCache(prevPath);
    if (li >= 0) {
        state.library[li] = { ...state.library[li], iconPath };
    }
    if (cachedBaseItemsMap && cachedBaseItemsMap[id]) {
        cachedBaseItemsMap[id] = { ...cachedBaseItemsMap[id], iconPath };
    }
    syncActiveElementsIconPath(id, iconPath);
}

const DISCOVERY_UPLOAD_LIMIT_PNG_JPG = 20 * 1024;
const DISCOVERY_UPLOAD_LIMIT_GIF = 120 * 1024;

/**
 * @param {File} file
 * @returns {{ ok: true } | { ok: false, message: string }}
 */
function validateDiscoveryUploadFile(file) {
    if (!(file instanceof File)) return { ok: false, message: 'Pick a PNG, JPG, or GIF file first.' };
    const name = String(file.name || '').toLowerCase();
    const type = String(file.type || '').toLowerCase();
    const isGif = type === 'image/gif' || name.endsWith('.gif');
    const isPng = type === 'image/png' || name.endsWith('.png');
    const isJpg = type === 'image/jpeg' || name.endsWith('.jpg') || name.endsWith('.jpeg');
    if (!isGif && !isPng && !isJpg) {
        return { ok: false, message: 'Only PNG, JPG, and GIF are allowed.' };
    }
    if (isGif) {
        if (file.size > DISCOVERY_UPLOAD_LIMIT_GIF) {
            return { ok: false, message: 'GIF must be 120KB or smaller.' };
        }
    } else if (file.size >= DISCOVERY_UPLOAD_LIMIT_PNG_JPG) {
        return { ok: false, message: 'PNG/JPG must be smaller than 20KB.' };
    }
    return { ok: true };
}

/**
 * @param {File} file
 * @returns {Promise<string>}
 */
function fileToDataUrl(file) {
    return new Promise((resolve, reject) => {
        const fr = new FileReader();
        fr.onload = () => resolve(String(fr.result || ''));
        fr.onerror = () => reject(new Error('Could not read file.'));
        fr.readAsDataURL(file);
    });
}

/** Remove emoji / pictograph clusters (ZWJ sequences, skin tones) for display and storage. */
function stripEmojiClusters(s) {
    const t = typeof s === 'string' ? s : '';
    return t
        .replace(
            /(?:\p{Extended_Pictographic}(?:\u200D\p{Extended_Pictographic})*[\uFE0F\u{1F3FB}-\u{1F3FF}]?)/gu,
            ''
        )
        .replace(/\s+/g, ' ')
        .trim();
}

/**
 * Pull JSON object from assistant reply (strips optional ```json fences; uses first {...} span).
 * @param {string} raw
 * @returns {Record<string, unknown> | null}
 */
function extractJsonObjectFromAiReply(raw) {
    let s = String(raw || '').trim();
    if (!s) return null;
    const fenceMatch = s.match(/```(?:json)?\s*\n?/i);
    if (fenceMatch && fenceMatch.index !== undefined) {
        const after = s.slice(fenceMatch.index + fenceMatch[0].length);
        const close = after.indexOf('```');
        if (close !== -1) s = after.slice(0, close).trim();
    }
    const start = s.indexOf('{');
    const end = s.lastIndexOf('}');
    if (start === -1 || end <= start) return null;
    s = s.slice(start, end + 1);
    try {
        return JSON.parse(s);
    } catch {
        try {
            const fixed = s.replace(/,\s*([}\]])/g, '$1');
            return JSON.parse(fixed);
        } catch {
            return null;
        }
    }
}

/**
 * Normalize makesence for UI (green/red) and propositions. Supports yes/no in many forms.
 * @param {unknown} ms
 * @returns {boolean | null} true = yes, false = no, null = unclear / missing
 */
function interpretMakesence(ms) {
    if (typeof ms === 'boolean') return ms;
    if (typeof ms === 'number' && Number.isFinite(ms)) {
        if (ms === 1) return true;
        if (ms === 0) return false;
    }
    let s = String(ms ?? '').trim();
    s = s.replace(/^["']+|["']+$/g, '').trim();
    s = s.replace(/[.!?…。]+$/g, '').trim();
    s = s.toLowerCase();
    if (s === 'yes' || s === 'true' || s === 'y' || s === '1') return true;
    if (s === 'no' || s === 'false' || s === 'n' || s === '0') return false;
    return null;
}

/**
 * When JSON.parse fails or makesence is missing, try to read makesence from raw text.
 * @param {string} raw
 * @returns {boolean | null}
 */
function inferMakesenceFromRaw(raw) {
    const t = String(raw);
    const quoted = /"(?:makesence|makesense|makeSence)"\s*:\s*"([^"]*)"/i;
    const unquoted = /\bmakesence\s*:\s*"([^"]*)"/i;
    const unquoted2 = /\bmakesense\s*:\s*"([^"]*)"/i;
    for (const re of [quoted, unquoted, unquoted2]) {
        const m = t.match(re);
        if (m) {
            const v = interpretMakesence(m[1]);
            if (v !== null) return v;
        }
    }
    let m = t.match(/"(?:makesence|makesense|makeSence)"\s*:\s*(true|false)\b/i);
    if (m) return m[1].toLowerCase() === 'true';
    m =
        t.match(/\bmakesence\s*:\s*(true|false)\b/i) ||
        t.match(/\bmakesense\s*:\s*(true|false)\b/i) ||
        t.match(/\bmakeSence\s*:\s*(true|false)\b/i);
    if (m) return m[1].toLowerCase() === 'true';
    return null;
}

/** @param {string} raw */
function inferExplanationFromRaw(raw) {
    const t = String(raw);
    const m =
        t.match(/"enplaination"\s*:\s*"([^"]*)"/i) ||
        t.match(/"explaination"\s*:\s*"([^"]*)"/i) ||
        t.match(/"explanation"\s*:\s*"([^"]*)"/i) ||
        t.match(/"exmplaination"\s*:\s*"([^"]*)"/i);
    if (!m) return '';
    return stripEmojiClusters(m[1].replace(/\\n/g, '\n'));
}

/**
 * @param {Record<string, unknown>} obj
 * @returns {boolean | null} true = yes, false = no, null = missing/invalid
 */
function parseMakesenceFromJson(obj) {
    if (!obj || typeof obj !== 'object') return null;
    const ms =
        obj.makeSence ?? obj.makesence ?? obj.makesense ?? obj.make_sence ?? obj.makeSense;
    return interpretMakesence(ms);
}

/** @param {Record<string, unknown>} obj */
function explanationFromDiscoveryJson(obj) {
    if (!obj || typeof obj !== 'object') return '';
    const ex =
        obj.explanation ?? obj.exmplaination ?? obj.enplaination ?? obj.explaination;
    return stripEmojiClusters(String(ex ?? '').trim());
}

/** @param {string} raw */
function normalizeSuggestionEmoji(raw) {
    const s = String(raw || '').trim();
    if (!s) return '';
    const m = s.match(
        /(?:\p{Extended_Pictographic}(?:\u200D\p{Extended_Pictographic})*[\uFE0F\u{1F3FB}-\u{1F3FF}]?)/u
    );
    return m ? m[0] : '';
}

/**
 * @param {Record<string, unknown>} obj
 * @returns {{ name: string, emoji: string }[]}
 */
function propositionsFromDiscoveryJson(obj) {
    const ms =
        obj.makeSence ?? obj.makesence ?? obj.makesense ?? obj.make_sence ?? obj.makeSense;
    if (interpretMakesence(ms) === false) return [];
    let props = obj.propositions;
    if (!Array.isArray(props)) props = [];
    const out = [];
    const seen = new Set();
    for (const p of props) {
        let rawName = '';
        let rawEmoji = '';
        if (typeof p === 'string') {
            const raw = String(p || '').trim();
            rawName = stripEmojiClusters(raw);
            rawEmoji = normalizeSuggestionEmoji(raw);
        } else if (p && typeof p === 'object') {
            rawName = String(p.name ?? '').trim();
            rawEmoji = String(p.emoji ?? '').trim();
            if (!rawName && typeof p.label === 'string') {
                const raw = String(p.label || '').trim();
                rawName = stripEmojiClusters(raw);
                if (!rawEmoji) rawEmoji = normalizeSuggestionEmoji(raw);
            }
        } else {
            rawName = String(p ?? '').trim();
        }
        const raw = stripEmojiClusters(rawName);
        const name = raw.split(/\s+/).filter(Boolean)[0] ?? '';
        if (!name) continue;
        const key = name.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        const emoji = normalizeSuggestionEmoji(rawEmoji) || '✨';
        out.push({ name, emoji });
        if (out.length >= 6) break;
    }
    return out;
}

/**
 * @param {string | undefined} content
 * @returns {{ suggestions: { name: string, emoji: string }[], explanation: string, makesenceYes: boolean | null }}
 */
function parseAiDiscoveryReply(content) {
    const raw = String(content || '').trim();
    if (!raw) {
        return { suggestions: [], explanation: '', makesenceYes: null };
    }
    const obj = extractJsonObjectFromAiReply(raw);
    const suggestions = obj && typeof obj === 'object' ? propositionsFromDiscoveryJson(obj) : [];
    let explanation = obj && typeof obj === 'object' ? explanationFromDiscoveryJson(obj) : '';
    let makesenceYes = obj && typeof obj === 'object' ? parseMakesenceFromJson(obj) : null;
    if (makesenceYes === null) {
        const inferred = inferMakesenceFromRaw(raw);
        if (inferred !== null) makesenceYes = inferred;
    }
    if (!String(explanation || '').trim()) {
        const ex = inferExplanationFromRaw(raw);
        if (ex) explanation = ex;
    }
    return { suggestions, explanation, makesenceYes };
}

function promptPartsFromItem(item) {
    if (item && typeof item.emoji === 'string' && typeof item.name === 'string') {
        return { icon: item.emoji, text: item.name };
    }
    return splitLabel(item && typeof item.name === 'string' ? item.name : '');
}

/** Tier from library for a canvas item or library row (canvas copies may omit tier). */
function tierFromLibraryRef(item) {
    if (!item || typeof item.id !== 'string') return 0;
    const lib = state.library.find((e) => e.id === item.id);
    return typeof lib?.tier === 'number' ? lib.tier : 0;
}

/** Tier the new discovery would get: 1 + max(parent tiers). */
function tierForPendingDiscovery(itemA, itemB) {
    return 1 + Math.max(tierFromLibraryRef(itemA), tierFromLibraryRef(itemB));
}

/**
 * Builds the exact system + user messages sent to the model for discovery suggestions.
 * @returns {{ userPrompt: string, systemContent: string, messages: { role: string, content: string }[] }}
 */
function composeAiDiscoveryRequest(itemA, itemB) {
    const la = promptPartsFromItem(itemA);
    const lb = promptPartsFromItem(itemB);
    const itemName1 = la.text.trim() || 'Item A';
    const itemName2 = lb.text.trim() || 'Item B';

    const userPrompt =
        `Give exactly six name ideas for an element-combining game like Little Alchemy\n\n` +
        `Combine "${itemName1}" and "${itemName2}" with a coherent imaginative style.\n\n` +
        `Each proposition must be exactly one word: no spaces, no phrases (use compounds or hyphens if needed, e.g. Sunstone or Red-hot).\n\n` +
        `Each proposition must include a fitting emoji.\n\n` +
        `Reply in JSON only (no markdown fences, no text outside the object):\n` +
        `{\n` +
        `  "explanation": "Short optional note (e.g. theme of the names).",\n` +
        `  "propositions": [\n` +
        `    { "name": "Mud", "emoji": "🟤" },\n` +
        `    { "name": "Clay", "emoji": "🧱" },\n` +
        `    { "name": "Brick", "emoji": "🧱" },\n` +
        `    { "name": "Loam", "emoji": "🌱" },\n` +
        `    { "name": "Silt", "emoji": "🌫️" },\n` +
        `    { "name": "Peat", "emoji": "🪵" }\n` +
        `  ]\n` +
        `}\n\n` +
        `propositions must be exactly six distinct entries; each entry must have "name" (single word) and "emoji" (one fitting emoji).`;

    const systemContent =
        'Reply with a single valid JSON object only. Keys: explanation (string), propositions (array of exactly six objects: { name, emoji }). name must be one word only (no spaces). emoji must be a fitting emoji. No verdict or boolean about validity.';

    return {
        userPrompt,
        systemContent,
        messages: [
            { role: 'system', content: systemContent },
            { role: 'user', content: userPrompt }
        ]
    };
}

/** Single block: system message then user message (what the API receives, in order). */
function formatOutgoingAiPreview(req) {
    return `${req.systemContent}\n\n${req.userPrompt}`;
}

async function fetchAiPropositions(itemA, itemB) {
    const la = promptPartsFromItem(itemA);
    const lb = promptPartsFromItem(itemB);
    const res = await apiFetch('/api/discovery/suggestions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            itemA: { name: la.text.trim(), emoji: la.icon.trim() },
            itemB: { name: lb.text.trim(), emoji: lb.icon.trim() }
        })
    });
    const t = await res.text();
    if (!res.ok) throw new Error(t || `${res.status} ${res.statusText}`);
    let payload = null;
    try {
        payload = JSON.parse(t);
    } catch {
        payload = null;
    }
    if (!payload || typeof payload !== 'object') {
        throw new Error('Invalid discovery suggestions response');
    }
    return {
        suggestions: Array.isArray(payload.suggestions) ? payload.suggestions : [],
        explanation: typeof payload.explanation === 'string' ? payload.explanation : '',
        makesenceYes:
            typeof payload.makesenceYes === 'boolean' || payload.makesenceYes === null
                ? payload.makesenceYes
                : null
    };
}

/** @param {Record<string, number>} deltas item id → amount to add */
function addItemsToPlayerInventory(deltas) {
    if (!deltas || typeof deltas !== 'object') return;
    let any = false;
    for (const [id, q] of Object.entries(deltas)) {
        if (typeof id !== 'string' || !id.trim()) continue;
        const n = Math.floor(Number(q));
        if (!Number.isFinite(n) || n <= 0) continue;
        state.playerInventory[id] = (state.playerInventory[id] || 0) + n;
        any = true;
    }
    if (any) {
        renderPlayerInventory();
    }
}

/** @param {any} raw */
function normalizeInventoryMap(raw) {
    if (!raw || typeof raw !== 'object') return {};
    const out = {};
    for (const [id, q] of Object.entries(raw)) {
        const key = String(id || '').trim();
        const qty = Math.floor(Number(q));
        if (!key || !Number.isFinite(qty) || qty <= 0) continue;
        out[key] = qty;
    }
    return out;
}

/** @param {any} raw */
function applyServerInventorySnapshot(raw) {
    state.playerInventory = normalizeInventoryMap(raw);
    renderPlayerInventory();
}

function isInventoryPanelOpen() {
    const panel = document.getElementById('inventory-panel');
    return !!panel && !panel.classList.contains('hidden');
}

const INVENTORY_GRID_SLOTS = 100;

function renderPlayerInventory() {
    const wrap = document.getElementById('player-inventory');
    const metaEl = document.getElementById('inventory-meta');
    const overflowEl = document.getElementById('player-inventory-overflow');
    if (!wrap) return;
    const entries = Object.entries(state.playerInventory).filter(([, c]) => (c | 0) > 0);
    entries.sort((a, b) => a[0].localeCompare(b[0]));
    const overflow = Math.max(0, entries.length - INVENTORY_GRID_SLOTS);

    wrap.innerHTML = '';
    wrap.className = 'inventory-grid-10 text-slate-300';

    for (let i = 0; i < INVENTORY_GRID_SLOTS; i++) {
        const cell = document.createElement('div');
        cell.className = 'inv-slot inv-slot--empty';
        cell.setAttribute('role', 'gridcell');
        if (i < entries.length) {
            const [id, count] = entries[i];
            cell.classList.remove('inv-slot--empty');
            cell.classList.add('inv-slot--filled');
            const lib = state.library.find((e) => e.id === id);
            const emoji = lib
                ? typeof lib.emoji === 'string'
                    ? lib.emoji
                    : splitLabel(lib.name).icon
                : '·';
            const name = lib
                ? typeof lib.name === 'string'
                    ? splitLabel(lib.name).text
                    : String(lib.name)
                : id;
            cell.title = `${name} ×${count | 0}`;
            const iconSrc = lib ? iconSrcForItem(lib) : null;
            if (iconSrc) {
                const img = document.createElement('img');
                img.className = 'inv-slot-icon-img select-none';
                img.src = iconSrc;
                img.alt = '';
                img.decoding = 'async';
                const cnt = document.createElement('span');
                cnt.className = 'tabular-nums text-slate-400 leading-none mt-0.5';
                cnt.textContent = `×${count | 0}`;
                cell.appendChild(img);
                cell.appendChild(cnt);
            } else {
                cell.innerHTML =
                    `<span class="text-lg leading-none select-none" aria-hidden="true">${emoji}</span>` +
                    `<span class="tabular-nums text-slate-400 leading-none mt-0.5">×${count | 0}</span>`;
            }
        }
        wrap.appendChild(cell);
    }

    if (metaEl) {
        const n = entries.length;
        metaEl.textContent = n === 0 ? 'Empty' : `${n} type${n === 1 ? '' : 's'}`;
    }
    if (overflowEl) {
        if (overflow > 0) {
            overflowEl.textContent = `+${overflow} more (not shown in grid)`;
            overflowEl.classList.remove('hidden');
        } else {
            overflowEl.textContent = '';
            overflowEl.classList.add('hidden');
        }
    }
}

/** Split "🌍 Earth" → { icon: "🌍", text: "Earth" } (first space separates emoji from name) */
function splitLabel(full) {
    const s = typeof full === 'string' ? full.trim() : '';
    const i = s.indexOf(' ');
    if (i === -1) {
        const icon = Array.from(s)[0] || '';
        const text = s.slice(icon.length).trim() || icon;
        return { icon, text };
    }
    return { icon: s.slice(0, i), text: s.slice(i + 1).trim() };
}

function slugFromLabel(full) {
    const { text } = splitLabel(full);
    return text.toLowerCase().replace(/\s/g, '-');
}

function slugFromNameText(nameText) {
    const t = typeof nameText === 'string' ? nameText.trim() : '';
    return t.toLowerCase().replace(/\s/g, '-');
}

function normalizeItemNameColor(raw) {
    const c = String(raw || '').trim().toLowerCase();
    return /^#[0-9a-f]{6}$/.test(c) ? c : '';
}

function safeUsernameForDiscoveryName() {
    const u = String(state.auth.username || '').trim().toLowerCase().replace(/[^a-z0-9_.-]/g, '');
    return u || 'player';
}

function discoveryDateStamp() {
    const d = new Date();
    const pad2 = (n) => String(n).padStart(2, '0');
    const pad3 = (n) => String(n).padStart(3, '0');
    return (
        `${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}_` +
        `${pad2(d.getHours())}${pad2(d.getMinutes())}${pad2(d.getSeconds())}${pad3(d.getMilliseconds())}`
    );
}

/**
 * @param {number} bytes
 * @returns {string}
 */
function formatKbValue(bytes) {
    const n = Math.max(0, Number(bytes) || 0);
    if (!Number.isFinite(n) || n <= 0) return '0';
    const kb = n / 1024;
    if (kb >= 100) return String(Math.round(kb));
    if (kb >= 10) return kb.toFixed(1);
    return kb.toFixed(2);
}

function makeUnnamedDiscoveryName() {
    return `unnamed_${discoveryDateStamp()}_${safeUsernameForDiscoveryName()}`;
}

/** Turn { resultId: { a, b, name } } into sorted combo keys for lookup */
function buildRecipeIndex(recipesByResultId) {
    const index = {};
    for (const [resultId, def] of Object.entries(recipesByResultId)) {
        const key = [def.a, def.b].sort().join('+');
        index[key] = { id: resultId, emoji: def.emoji, name: def.name };
    }
    return index;
}

/**
 * Minimal combination depth from base items: tier 0 = no recipe (starters).
 * Crafted: 1 + max(tier(a), tier(b)). Cycles / missing ids break with tier 0 + console warning.
 */
function computeItemTiers(items) {
    const memo = {};
    const visiting = new Set();

    function tierOf(id) {
        if (Object.prototype.hasOwnProperty.call(memo, id)) {
            return memo[id];
        }
        if (visiting.has(id)) {
            console.warn('Tier: cycle involving', id);
            return (memo[id] = 0);
        }
        const def = items[id];
        if (!def || typeof def.name !== 'string' || typeof def.emoji !== 'string') {
            console.warn('Tier: unknown item id', id);
            return (memo[id] = 0);
        }
        if (typeof def.a !== 'string' || typeof def.b !== 'string') {
            return (memo[id] = 0);
        }
        visiting.add(id);
        const t = 1 + Math.max(tierOf(def.a), tierOf(def.b));
        visiting.delete(id);
        return (memo[id] = t);
    }

    for (const id of Object.keys(items)) {
        tierOf(id);
    }
    return memo;
}

/** Merge base DB items with in-session recipe index (new combos before next full reload). */
function mergedItemsForTiers(itemsMap, recipeIndex) {
    const merged = { ...itemsMap };
    for (const [key, val] of Object.entries(recipeIndex)) {
        const parts = key.split('+');
        const norm = normalizeRecipeResult(val);
        if (parts.length !== 2 || !norm) continue;
        merged[norm.id] = { a: parts[0], b: parts[1], emoji: norm.emoji, name: norm.name };
    }
    return merged;
}

function recomputeAllTiers() {
    if (!cachedBaseItemsMap) return;
    const merged = mergedItemsForTiers(cachedBaseItemsMap, state.recipes);
    const tierMap = computeItemTiers(merged);
    for (const item of state.library) {
        item.tier = tierMap[item.id] ?? 0;
    }
}

function itemsMapToState(items) {
    const library = [];
    const recipesRaw = {};
    for (const [id, def] of Object.entries(items)) {
        if (!def || typeof def.name !== 'string' || typeof def.emoji !== 'string') continue;
        const row = /** @type {{ id: string, emoji: string, name: string, tier: number, iconPath?: string, nameColor?: string }} */ ({
            id,
            emoji: def.emoji,
            name: def.name,
            tier: 0
        });
        const nameColor = normalizeItemNameColor(def.nameColor);
        if (nameColor) row.nameColor = nameColor;
        if (typeof def.iconPath === 'string' && def.iconPath.trim()) {
            row.iconPath = def.iconPath.trim();
        }
        library.push(row);
        if (typeof def.a === 'string' && typeof def.b === 'string') {
            recipesRaw[id] = { a: def.a, b: def.b, emoji: def.emoji, name: def.name };
        }
    }
    return { library, recipesRaw };
}

async function loadGameData() {
    const res = await apiFetch('/api/items');
    if (!res.ok) {
        throw new Error('Failed to load game data');
    }
    const payload = await res.json();
    const items = payload && typeof payload.items === 'object' && payload.items !== null ? payload.items : null;
    if (!items) {
        throw new Error('Invalid /api/items response');
    }
    cachedBaseItemsMap = items;
    const { library, recipesRaw } = itemsMapToState(cachedBaseItemsMap);
    state.library = library;
    state.recipes = buildRecipeIndex(recipesRaw);
}

/**
 * @param {Record<string, { emoji?: string, name?: string, nameColor?: string, discoveredAt?: string, discoveredByUsername?: string, iconPath?: string, iconSizeBytes?: number, a?: string, b?: string, upvotes?: number, downvotes?: number }>} items
 */
function buildGlobalDiscoveriesRows(items) {
    const rows = [];
    for (const [id, def] of Object.entries(items || {})) {
        if (!def || typeof def.name !== 'string' || typeof def.emoji !== 'string') continue;
        const row = { id, name: def.name, emoji: def.emoji };
        const nameColor = normalizeItemNameColor(def.nameColor);
        if (nameColor) row.nameColor = nameColor;
        if (typeof def.a === 'string' && def.a && typeof def.b === 'string' && def.b) {
            row.ingredientA = def.a;
            row.ingredientB = def.b;
            const aDef = items[def.a];
            const bDef = items[def.b];
            row.ingredientAText = aDef && typeof aDef.name === 'string' ? aDef.name : def.a;
            row.ingredientBText = bDef && typeof bDef.name === 'string' ? bDef.name : def.b;
            row.ingredientAEmoji = aDef && typeof aDef.emoji === 'string' ? aDef.emoji : '·';
            row.ingredientBEmoji = bDef && typeof bDef.emoji === 'string' ? bDef.emoji : '·';
        }
        if (typeof def.discoveredAt === 'string' && def.discoveredAt.trim()) {
            row.discoveredAt = def.discoveredAt.trim();
        }
        if (typeof def.discoveredByUsername === 'string' && def.discoveredByUsername.trim()) {
            row.discoveredByUsername = def.discoveredByUsername.trim();
        }
        if (typeof def.iconPath === 'string' && def.iconPath.trim()) {
            row.iconPath = def.iconPath.trim();
        }
        if (Number.isFinite(Number(def.iconSizeBytes)) && Number(def.iconSizeBytes) > 0) {
            row.iconSizeBytes = Math.max(0, Number(def.iconSizeBytes) | 0);
        }
        if (Number.isFinite(Number(def.upvotes))) {
            row.upvotes = Math.max(0, Number(def.upvotes) | 0);
        }
        if (Number.isFinite(Number(def.downvotes))) {
            row.downvotes = Math.max(0, Number(def.downvotes) | 0);
        }
        rows.push(row);
    }
    return rows;
}

/**
 * @param {{ discoveredAt?: string, ingredientA?: string, ingredientB?: string }} row
 * @returns {boolean}
 */
function isRowVoteEligible(row) {
    if (!row || !row.discoveredAt || !row.ingredientA || !row.ingredientB) return false;
    const ts = Date.parse(row.discoveredAt);
    if (!Number.isFinite(ts)) return false;
    return Date.now() - ts <= 5 * 24 * 60 * 60 * 1000;
}

/**
 * @param {string} id
 * @param {'up' | 'down'} vote
 * @returns {Promise<{ upvotes: number, downvotes: number }>}
 */
async function postDiscoveryVote(id, vote) {
    const r = await apiFetch('/api/items/vote', {
        method: 'POST',
        headers: authHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ id, vote })
    });
    const t = await r.text();
    if (!r.ok) throw new Error(t || `${r.status}`);
    const out = JSON.parse(t);
    return {
        upvotes: Math.max(0, Number(out && out.upvotes) | 0),
        downvotes: Math.max(0, Number(out && out.downvotes) | 0)
    };
}

/**
 * @param {string} id
 * @returns {Promise<{ dependents: { id: string, name: string, emoji: string }[] }>}
 */
async function postDiscoveryDeleteCheck(id) {
    const r = await apiFetch('/api/items/delete-check', {
        method: 'POST',
        headers: authHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ id })
    });
    const t = await r.text();
    if (!r.ok) throw new Error(t || `${r.status}`);
    const out = JSON.parse(t);
    return {
        dependents: Array.isArray(out && out.dependents) ? out.dependents : []
    };
}

/**
 * @param {string} id
 * @returns {Promise<void>}
 */
async function postDiscoveryDelete(id) {
    const r = await apiFetch('/api/items/delete', {
        method: 'POST',
        headers: authHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ id })
    });
    const t = await r.text();
    if (!r.ok) throw new Error(t || `${r.status}`);
}

/**
 * @param {string} q
 * @returns {Promise<{ id: string, emoji: string, name: string }[]>}
 */
async function postDiscoverySearchNames(q) {
    const r = await apiFetch('/api/items/search-names', {
        method: 'POST',
        headers: authHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ q: String(q || '').trim(), limit: 50 })
    });
    const t = await r.text();
    if (!r.ok) throw new Error(t || `${r.status}`);
    const out = JSON.parse(t);
    return Array.isArray(out && out.items) ? out.items : [];
}

/**
 * @param {string} id
 * @param {'a' | 'b'} slot
 * @param {string} newIngredientId
 */
async function postDiscoveryUpdateIngredient(id, slot, newIngredientId) {
    const r = await apiFetch('/api/items/update-ingredient', {
        method: 'POST',
        headers: authHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ id, slot, newIngredientId })
    });
    const t = await r.text();
    if (!r.ok) {
        let err = t;
        try {
            const j = JSON.parse(t);
            if (j && typeof j.error === 'string') err = j.error;
        } catch {
            /* keep raw */
        }
        throw new Error(err || `${r.status}`);
    }
    return JSON.parse(t);
}

/**
 * @param {string} id
 * @returns {Promise<boolean>} true if deleted
 */
async function runDiscoveryDeleteFlow(id) {
    const check = await postDiscoveryDeleteCheck(id);
    const deps = Array.isArray(check.dependents) ? check.dependents : [];
    if (deps.length > 0) {
        const preview = deps
            .slice(0, 12)
            .map((d) => `${d.emoji || '·'} ${d.name || d.id} (${d.id})`)
            .join('\n');
        const suffix = deps.length > 12 ? `\n...and ${deps.length - 12} more` : '';
        alert(`Cannot delete "${id}" yet.\nIt is needed to craft:\n${preview}${suffix}`);
        return false;
    }
    const ok = confirm(`Delete discovery "${id}" from database?`);
    if (!ok) return false;
    await postDiscoveryDelete(id);
    await refreshGlobalDiscoveriesFromApi();
    await reloadCatalogFromApi();
    if (state.pendingCombination && state.pendingCombination.resultId === id) {
        state.pendingCombination.resultId = '';
    }
    state.activeElements = state.activeElements.filter((el) => String(el.id || '') !== id);
    renderCanvas();
    return true;
}

function setDiscoveryEditModalOpen(open) {
    if (!discoveryEditModalEl) return;
    discoveryEditModalEl.classList.toggle('hidden', !open);
    if (!open) {
        discoveryEditTargetId = '';
        discoveryEditSlot = '';
        hideDiscoveryEditPicker();
        if (discoveryEditSearchInputEl) discoveryEditSearchInputEl.value = '';
        if (discoveryEditSearchResultsEl) discoveryEditSearchResultsEl.innerHTML = '';
        if (discoveryEditSearchTimer) {
            clearTimeout(discoveryEditSearchTimer);
            discoveryEditSearchTimer = 0;
        }
    }
}

function hideDiscoveryEditPicker() {
    if (discoveryEditPickerEl) discoveryEditPickerEl.classList.add('hidden');
    discoveryEditSlot = '';
    if (discoveryEditSearchInputEl) discoveryEditSearchInputEl.value = '';
    if (discoveryEditSearchResultsEl) discoveryEditSearchResultsEl.innerHTML = '';
}

/**
 * @param {{ id: string, name: string, emoji?: string, ingredientA?: string, ingredientB?: string, ingredientAText?: string, ingredientBText?: string, ingredientAEmoji?: string, ingredientBEmoji?: string }} row
 */
function fillDiscoveryEditIngredientLabels(row) {
    if (!discoveryEditIngAEl || !discoveryEditIngBEl) return;
    if (row.ingredientA && row.ingredientB) {
        discoveryEditIngAEl.textContent = `${row.ingredientAEmoji || '·'} ${row.ingredientAText || row.ingredientA} — ${row.ingredientA}`;
        discoveryEditIngBEl.textContent = `${row.ingredientBEmoji || '·'} ${row.ingredientBText || row.ingredientB} — ${row.ingredientB}`;
        discoveryEditIngAEl.disabled = false;
        discoveryEditIngBEl.disabled = false;
    } else {
        discoveryEditIngAEl.textContent = '— (no craft recipe)';
        discoveryEditIngBEl.textContent = '— (no craft recipe)';
        discoveryEditIngAEl.disabled = true;
        discoveryEditIngBEl.disabled = true;
    }
}

/**
 * @param {{ id: string, name: string, emoji?: string, ingredientA?: string, ingredientB?: string, ingredientAText?: string, ingredientBText?: string, ingredientAEmoji?: string, ingredientBEmoji?: string }} row
 */
function openDiscoveryEditModal(row) {
    discoveryEditTargetId = String(row.id || '').trim();
    discoveryEditSlot = '';
    if (discoveryEditItemNameEl) discoveryEditItemNameEl.textContent = row.name || row.id;
    fillDiscoveryEditIngredientLabels(row);
    hideDiscoveryEditPicker();
    setDiscoveryEditModalOpen(true);
}

async function runDiscoveryEditSearch() {
    if (!discoveryEditSearchInputEl || !discoveryEditSearchResultsEl || !discoveryEditSlot) return;
    const q = discoveryEditSearchInputEl.value.trim();
    discoveryEditSearchResultsEl.innerHTML = '';
    if (!q) return;
    try {
        const items = await postDiscoverySearchNames(q);
        if (!items.length) {
            const empty = document.createElement('div');
            empty.className = 'text-xs text-slate-500 px-1 py-1';
            empty.textContent = 'No matches.';
            discoveryEditSearchResultsEl.appendChild(empty);
            return;
        }
        items.forEach((it) => {
            const b = document.createElement('button');
            b.type = 'button';
            b.className =
                'w-full text-left px-2 py-1.5 rounded-md bg-slate-800/80 border border-slate-700 text-sm text-slate-100 hover:bg-slate-700/80 touch-manipulation';
            b.setAttribute('data-discovery-edit-pick-id', it.id);
            b.textContent = `${it.emoji || '·'} ${it.name} (${it.id})`;
            discoveryEditSearchResultsEl.appendChild(b);
        });
    } catch (e) {
        const msg = e && typeof e.message === 'string' ? e.message : String(e);
        const err = document.createElement('div');
        err.className = 'text-xs text-red-400 px-1 py-1';
        err.textContent = msg.slice(0, 200);
        discoveryEditSearchResultsEl.appendChild(err);
    }
}

function scheduleDiscoveryEditSearch() {
    if (discoveryEditSearchTimer) clearTimeout(discoveryEditSearchTimer);
    discoveryEditSearchTimer = window.setTimeout(() => {
        discoveryEditSearchTimer = 0;
        void runDiscoveryEditSearch();
    }, 220);
}

/** @returns {Promise<string[]>} */
async function fetchDbTables() {
    const r = await apiFetch('/api/db/tables', { method: 'GET' });
    const t = await r.text();
    if (!r.ok) throw new Error(t || `${r.status}`);
    const out = JSON.parse(t);
    return Array.isArray(out && out.tables) ? out.tables.map((x) => String(x || '')).filter(Boolean) : [];
}

/**
 * @param {string} table
 * @returns {Promise<{ table: string, columns: string[], primaryKey: string[], rows: Record<string, any>[], hasRowid: boolean, total: number, limit: number, offset: number }>}
 */
async function fetchDbTableRows(table) {
    const r = await apiFetch('/api/db/table', {
        method: 'POST',
        headers: authHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ table, limit: 200, offset: 0 })
    });
    const t = await r.text();
    if (!r.ok) throw new Error(t || `${r.status}`);
    const out = JSON.parse(t);
    return {
        table: String(out && out.table ? out.table : ''),
        columns: Array.isArray(out && out.columns) ? out.columns.map((x) => String(x || '')) : [],
        primaryKey: Array.isArray(out && out.primaryKey) ? out.primaryKey.map((x) => String(x || '')) : [],
        rows: Array.isArray(out && out.rows) ? out.rows : [],
        hasRowid: out && out.hasRowid === true,
        total: Number(out && out.total ? out.total : 0) | 0,
        limit: Number(out && out.limit ? out.limit : 0) | 0,
        offset: Number(out && out.offset ? out.offset : 0) | 0
    };
}

/**
 * @param {string} table
 * @param {{ rowid?: number, pk?: Record<string, any> }} identity
 * @returns {Promise<void>}
 */
async function postDbDeleteRow(table, identity) {
    const payload = { table };
    if (identity && typeof identity.rowid === 'number') payload.rowid = identity.rowid;
    if (identity && identity.pk && typeof identity.pk === 'object') payload.pk = identity.pk;
    const r = await apiFetch('/api/db/delete-row', {
        method: 'POST',
        headers: authHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify(payload)
    });
    const t = await r.text();
    if (!r.ok) throw new Error(t || `${r.status}`);
}

/**
 * @returns {Promise<{ username: string, topDiscoveries: { id: string, emoji: string, name: string, iconPath?: string, upvotes: number, downvotes: number, totalVotes: number }[] }>}
 */
async function fetchProfileData() {
    const r = await apiFetch('/api/profile', { method: 'GET' });
    const t = await r.text();
    if (!r.ok) throw new Error(t || `${r.status}`);
    const out = JSON.parse(t);
    return {
        username: String(out && out.username ? out.username : ''),
        topDiscoveries: Array.isArray(out && out.topDiscoveries) ? out.topDiscoveries : []
    };
}

/**
 * @param {string} itemId
 * @returns {Promise<{ id: number, itemId: string, proposalType: 'name'|'image', proposedName?: string, proposedImagePath?: string, createdBy: number, createdAt: string, upvotes: number, downvotes: number, myVote: number }[]>}
 */
async function fetchDiscoveryProposals(itemId) {
    const u = new URL(`${apiOrigin()}/api/discovery-proposals`);
    u.searchParams.set('itemId', String(itemId || ''));
    const r = await fetch(u.toString(), {
        headers: authHeaders({})
    });
    const t = await r.text();
    if (!r.ok) throw new Error(t || `${r.status}`);
    const out = JSON.parse(t);
    return Array.isArray(out && out.proposals) ? out.proposals : [];
}

/**
 * @param {number} proposalId
 * @param {'up'|'down'} vote
 * @returns {Promise<{ upvotes: number, downvotes: number, myVote: number }>}
 */
async function postDiscoveryProposalVote(proposalId, vote) {
    const r = await apiFetch('/api/discovery-proposals/vote', {
        method: 'POST',
        headers: authHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ proposalId, vote })
    });
    const t = await r.text();
    if (!r.ok) throw new Error(t || `${r.status}`);
    const out = JSON.parse(t);
    return {
        upvotes: Math.max(0, Number(out && out.upvotes) | 0),
        downvotes: Math.max(0, Number(out && out.downvotes) | 0),
        myVote: Number(out && out.myVote ? out.myVote : 0) | 0
    };
}

/**
 * @param {string} itemId
 * @param {{ proposalType: 'name'|'image', proposedName?: string, imageUrl?: string, imageDataUrl?: string }} payload
 */
async function postCreateDiscoveryProposal(itemId, payload) {
    const body = { itemId, proposalType: payload.proposalType };
    if (payload.proposalType === 'name') {
        body.proposedName = String(payload.proposedName || '').trim();
    } else {
        if (typeof payload.imageUrl === 'string' && payload.imageUrl.trim()) body.imageUrl = payload.imageUrl.trim();
        if (typeof payload.imageDataUrl === 'string' && payload.imageDataUrl.trim()) {
            body.imageDataUrl = payload.imageDataUrl.trim();
        }
    }
    const r = await apiFetch('/api/discovery-proposals', {
        method: 'POST',
        headers: authHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify(body)
    });
    const t = await r.text();
    if (!r.ok) throw new Error(t || `${r.status}`);
    return JSON.parse(t);
}

/**
 * @param {string} relPath
 * @returns {string}
 */
function proposalImageSrc(relPath) {
    return `${apiOrigin()}/${String(relPath || '').replace(/^\/+/, '')}`;
}

function setDiscoveryVoteOptionsModalOpen(open) {
    if (!discoveryVoteOptionsModalEl) return;
    discoveryVoteOptionsModalEl.classList.toggle('hidden', !open);
}

function setDiscoveryNameProposalModalOpen(open) {
    if (!discoveryNameProposalModalEl) return;
    discoveryNameProposalModalEl.classList.toggle('hidden', !open);
}

function setDiscoveryImageProposalModalOpen(open) {
    if (!discoveryImageProposalModalEl) return;
    discoveryImageProposalModalEl.classList.toggle('hidden', !open);
}

function compareGlobalDiscoveriesRows(a, b) {
    if (globalDiscoveriesSort === 'name') {
        return a.name.localeCompare(b.name) || a.id.localeCompare(b.id);
    }
    const ta = a.discoveredAt ? Date.parse(a.discoveredAt) : Number.NEGATIVE_INFINITY;
    const tb = b.discoveredAt ? Date.parse(b.discoveredAt) : Number.NEGATIVE_INFINITY;
    if (tb !== ta) return tb - ta;
    return a.name.localeCompare(b.name) || a.id.localeCompare(b.id);
}

/**
 * @param {any} row
 * @param {number} depth
 * @returns {HTMLElement}
 */
function buildGlobalDiscoveryRowElement(row, depth) {
    const upvotes = Math.max(0, Number(row.upvotes || 0) | 0);
    const downvotes = Math.max(0, Number(row.downvotes || 0) | 0);
    const comboText =
        row.ingredientAText && row.ingredientBText
            ? `${row.ingredientAEmoji || '·'} ${row.ingredientAText} + ${row.ingredientBEmoji || '·'} ${row.ingredientBText}`
            : 'Starter item';

    const wrap = document.createElement('div');
    wrap.className = 'px-4 py-2.5';
    if (depth > 0) wrap.style.paddingLeft = `${16 + depth * 18}px`;
    wrap.setAttribute('data-discovery-item-id', row.id);

    const top = document.createElement('div');
    top.className = 'flex items-center gap-3';
    top.setAttribute('data-discovery-expand-toggle', row.id);

    const iconWrap = document.createElement('div');
    iconWrap.className =
        'w-8 h-8 rounded-md border border-slate-600 bg-slate-900/70 shrink-0 flex items-center justify-center overflow-hidden';
    const iconSrc = iconSrcForItem(row);
    if (iconSrc) {
        const iconImg = document.createElement('img');
        iconImg.className = 'w-full h-full object-contain';
        iconImg.src = iconSrc;
        iconImg.alt = `${row.name} icon`;
        iconWrap.appendChild(iconImg);
    } else {
        const emojiEl = document.createElement('span');
        emojiEl.className = 'text-xl leading-none select-none';
        emojiEl.setAttribute('aria-hidden', 'true');
        emojiEl.textContent = row.emoji || '·';
        iconWrap.appendChild(emojiEl);
    }
    top.appendChild(iconWrap);

    const textWrap = document.createElement('div');
    textWrap.className = 'min-w-0 flex-1';
    const nameEl = document.createElement('div');
    nameEl.className = 'text-sm text-slate-100 truncate';
    if (row.nameColor) nameEl.style.color = row.nameColor;
    nameEl.textContent = row.name;
    const comboEl = document.createElement('div');
    comboEl.className = 'text-[11px] text-slate-400 truncate';
    comboEl.textContent = comboText;
    const metaEl = document.createElement('div');
    metaEl.className = 'text-[11px] text-slate-500 truncate';
    const discoveredBy = row.discoveredByUsername ? row.discoveredByUsername : 'system';
    const metaParts = [`Discovered by: ${discoveredBy}`];
    if (row.discoveredAt) metaParts.push(new Date(row.discoveredAt).toLocaleString());
    if (Number.isFinite(Number(row.iconSizeBytes)) && Number(row.iconSizeBytes) > 0) {
        metaParts.push(`Icon: ${formatKbValue(row.iconSizeBytes)} KB`);
    }
    metaEl.textContent = metaParts.join(' | ');
    textWrap.appendChild(nameEl);
    textWrap.appendChild(comboEl);
    textWrap.appendChild(metaEl);
    top.appendChild(textWrap);

    const right = document.createElement('div');
    right.className = 'ml-2 shrink-0 flex items-center gap-1.5';
    const editBtn = document.createElement('button');
    editBtn.type = 'button';
    editBtn.className = 'vote-pill vote-pill--up';
    editBtn.setAttribute('data-discovery-edit-btn', '1');
    editBtn.setAttribute('data-id', row.id);
    editBtn.textContent = 'Edit';
    right.appendChild(editBtn);
    const upBtn = document.createElement('button');
    upBtn.type = 'button';
    upBtn.className = 'vote-pill vote-pill--up';
    upBtn.setAttribute('data-discovery-vote-btn', '1');
    upBtn.setAttribute('data-vote', 'up');
    upBtn.setAttribute('data-id', row.id);
    upBtn.textContent = `👍 ${upvotes}`;
    right.appendChild(upBtn);

    const downBtn = document.createElement('button');
    downBtn.type = 'button';
    downBtn.className = 'vote-pill vote-pill--down';
    downBtn.setAttribute('data-discovery-vote-btn', '1');
    downBtn.setAttribute('data-vote', 'down');
    downBtn.setAttribute('data-id', row.id);
    downBtn.textContent = `👎 ${downvotes}`;
    right.appendChild(downBtn);

    const proposalBtn = document.createElement('button');
    proposalBtn.type = 'button';
    proposalBtn.className = 'vote-pill vote-pill--up';
    proposalBtn.setAttribute('data-discovery-proposal-open-btn', '1');
    proposalBtn.setAttribute('data-id', row.id);
    proposalBtn.textContent = '🗳️ Vote';
    right.appendChild(proposalBtn);
    top.appendChild(right);
    wrap.appendChild(top);

    const expanded = document.createElement('div');
    expanded.className = 'mt-2 ml-8 border border-slate-700 rounded-lg bg-slate-900/60 p-2 hidden';
    expanded.setAttribute('data-discovery-expanded', row.id);
    const props = discoveryProposalsByItem[row.id] || [];
    if (!props.length) {
        const none = document.createElement('div');
        none.className = 'text-xs text-slate-500';
        none.textContent = 'No active proposals yet. Use Vote... to start one.';
        expanded.appendChild(none);
    } else {
        props.forEach((p) => {
            const line = document.createElement('div');
            line.className = 'mb-2 last:mb-0 rounded border border-slate-700 bg-slate-950/50 p-2';
            const title = document.createElement('div');
            title.className = 'text-xs text-slate-200';
            title.textContent = p.proposalType === 'name' ? `Name: ${p.proposedName || ''}` : 'Image proposal';
            line.appendChild(title);
            if (p.proposalType === 'image' && p.proposedImagePath) {
                const img = document.createElement('img');
                img.className = 'mt-1 w-16 h-16 object-contain rounded border border-slate-600 bg-slate-900';
                img.src = proposalImageSrc(p.proposedImagePath);
                img.alt = 'Proposed icon';
                line.appendChild(img);
            }
            const footer = document.createElement('div');
            footer.className = 'mt-2 flex items-center gap-1.5';
            const up = document.createElement('button');
            up.type = 'button';
            up.className = `vote-pill ${p.myVote === 1 ? 'vote-pill--selected-up' : 'vote-pill--up'}`;
            up.setAttribute('data-discovery-proposal-vote-btn', '1');
            up.setAttribute('data-proposal-vote', 'up');
            up.setAttribute('data-proposal-id', String(p.id));
            up.setAttribute('data-item-id', row.id);
            up.textContent = `👍 ${Math.max(0, Number(p.upvotes || 0) | 0)}`;
            footer.appendChild(up);
            const down = document.createElement('button');
            down.type = 'button';
            down.className = `vote-pill ${p.myVote === -1 ? 'vote-pill--selected-down' : 'vote-pill--down'}`;
            down.setAttribute('data-discovery-proposal-vote-btn', '1');
            down.setAttribute('data-proposal-vote', 'down');
            down.setAttribute('data-proposal-id', String(p.id));
            down.setAttribute('data-item-id', row.id);
            down.textContent = `👎 ${Math.max(0, Number(p.downvotes || 0) | 0)}`;
            footer.appendChild(down);
            line.appendChild(footer);
            expanded.appendChild(line);
        });
    }
    if (globalDiscoveriesExpandedId === row.id) expanded.classList.remove('hidden');
    wrap.appendChild(expanded);
    return wrap;
}

function renderGlobalDiscoveriesPage() {
    if (!globalDiscoveriesListEl) return;
    const ordered = [...globalDiscoveriesRows].sort(compareGlobalDiscoveriesRows);
    const total = ordered.length;
    globalDiscoveriesListEl.innerHTML = '';
    globalDiscoveriesListEl.classList.add('divide-y', 'divide-slate-700/70');
    globalDiscoveriesListEl.style.overflowX = '';
    globalDiscoveriesListEl.style.overflowY = '';
    if (!ordered.length) {
        const empty = document.createElement('div');
        empty.className = 'px-4 py-6 text-sm text-slate-400 text-center';
        empty.textContent = 'No items found.';
        globalDiscoveriesListEl.appendChild(empty);
        if (globalDiscoveriesCountEl) globalDiscoveriesCountEl.textContent = '0 items';
        if (globalDiscoveriesPageEl) globalDiscoveriesPageEl.textContent = 'Page 1 / 1';
        if (globalDiscoveriesPrevBtn) globalDiscoveriesPrevBtn.disabled = true;
        if (globalDiscoveriesNextBtn) globalDiscoveriesNextBtn.disabled = true;
        return;
    }

    const pageCount = Math.max(1, Math.ceil(total / GLOBAL_DISCOVERIES_PER_PAGE));
    globalDiscoveriesPage = Math.max(1, Math.min(pageCount, globalDiscoveriesPage));
    const start = (globalDiscoveriesPage - 1) * GLOBAL_DISCOVERIES_PER_PAGE;
    const pageRows = ordered.slice(start, start + GLOBAL_DISCOVERIES_PER_PAGE);
    pageRows.forEach((row) => globalDiscoveriesListEl.appendChild(buildGlobalDiscoveryRowElement(row, 0)));

    if (globalDiscoveriesCountEl) {
        globalDiscoveriesCountEl.textContent = `${total} item${total === 1 ? '' : 's'}`;
    }
    if (globalDiscoveriesPageEl) {
        globalDiscoveriesPageEl.textContent = `Page ${globalDiscoveriesPage} / ${pageCount}`;
    }
    if (globalDiscoveriesPrevBtn) globalDiscoveriesPrevBtn.disabled = globalDiscoveriesPage <= 1;
    if (globalDiscoveriesNextBtn) globalDiscoveriesNextBtn.disabled = globalDiscoveriesPage >= pageCount;
}

async function refreshGlobalDiscoveriesFromApi() {
    const res = await apiFetch('/api/items');
    if (!res.ok) throw new Error('Failed to load discoveries');
    const payload = await res.json();
    const items = payload && typeof payload.items === 'object' && payload.items ? payload.items : null;
    if (!items) throw new Error('Invalid /api/items response');
    globalDiscoveriesRows = buildGlobalDiscoveriesRows(items);
    renderGlobalDiscoveriesPage();
}

/**
 * @param {string} itemId
 */
async function refreshDiscoveryProposalsForItem(itemId) {
    const id = String(itemId || '').trim();
    if (!id) return;
    const rows = await fetchDiscoveryProposals(id);
    discoveryProposalsByItem[id] = rows;
}

function setGlobalDiscoveriesModalOpen(open) {
    if (!globalDiscoveriesModalEl) return;
    globalDiscoveriesModalEl.classList.toggle('hidden', !open);
}

function setDbViewerModalOpen(open) {
    if (!dbViewerModalEl) return;
    dbViewerModalEl.classList.toggle('hidden', !open);
    // Defensive cleanup: never leave root nodes inert (can block dragging in lab).
    const roots = Array.from(document.body.children);
    for (const el of roots) el.removeAttribute('inert');
}

function setDbViewerStatus(msg) {
    if (dbViewerStatusEl) dbViewerStatusEl.textContent = String(msg || '');
}

function setProfileModalOpen(open) {
    if (!profileModalEl) return;
    profileModalEl.classList.toggle('hidden', !open);
}

function setProfileStatus(msg) {
    if (profileStatusEl) profileStatusEl.textContent = String(msg || '');
}

/**
 * @param {{ id: string, emoji: string, name: string, iconPath?: string, upvotes: number, downvotes: number, totalVotes: number }[]} rows
 */
function renderProfileTopGrid(rows) {
    if (!profileTopGridEl) return;
    profileTopGridEl.innerHTML = '';
    const list = Array.isArray(rows) ? rows.slice(0, 20) : [];
    if (!list.length) {
        const empty = document.createElement('div');
        empty.className = 'col-span-full text-xs text-slate-500 p-2';
        empty.textContent = 'No discoveries yet.';
        profileTopGridEl.appendChild(empty);
        return;
    }
    list.forEach((row) => {
        const card = document.createElement('div');
        card.className = 'rounded-lg border border-slate-700 bg-slate-900/70 p-1.5 text-center min-w-0';
        const iconWrap = document.createElement('div');
        iconWrap.className = 'h-8 w-8 mx-auto mb-1 flex items-center justify-center';
        const src =
            row && typeof row.iconPath === 'string' && row.iconPath.trim()
                ? `${apiOrigin()}/${row.iconPath.replace(/^\/+/, '')}`
                : '';
        if (src) {
            const img = document.createElement('img');
            img.src = src;
            img.alt = '';
            img.className = 'max-h-8 max-w-8 object-contain';
            iconWrap.appendChild(img);
        } else {
            iconWrap.classList.add('text-xl');
            iconWrap.textContent = row && row.emoji ? String(row.emoji) : '✨';
        }
        const nameEl = document.createElement('div');
        nameEl.className = 'text-[10px] text-slate-200 truncate';
        nameEl.textContent = row && row.name ? String(row.name) : String(row && row.id ? row.id : '');
        const votesEl = document.createElement('div');
        votesEl.className = 'text-[10px] text-slate-400';
        const total = Number(row && row.totalVotes ? row.totalVotes : 0) | 0;
        votesEl.textContent = `Votes: ${total}`;
        card.appendChild(iconWrap);
        card.appendChild(nameEl);
        card.appendChild(votesEl);
        profileTopGridEl.appendChild(card);
    });
}

async function openProfileModal() {
    setProfileModalOpen(true);
    setProfileStatus('Loading profile...');
    if (profileUsernameEl) profileUsernameEl.textContent = '';
    renderProfileTopGrid([]);
    const out = await fetchProfileData();
    if (profileUsernameEl) profileUsernameEl.textContent = `@${out.username || 'player'}`;
    renderProfileTopGrid(out.topDiscoveries);
    setProfileStatus('Top 20 discoveries by vote count.');
}

function renderDbViewerTableSelect() {
    if (!dbViewerTableSelectEl) return;
    dbViewerTableSelectEl.innerHTML = '';
    dbViewerTables.forEach((name) => {
        const opt = document.createElement('option');
        opt.value = name;
        opt.textContent = name;
        dbViewerTableSelectEl.appendChild(opt);
    });
    if (dbViewerSelectedTable) dbViewerTableSelectEl.value = dbViewerSelectedTable;
}

async function refreshDbViewerRows() {
    if (!dbViewerSelectedTable) return;
    setDbViewerStatus(`Loading ${dbViewerSelectedTable}...`);
    const out = await fetchDbTableRows(dbViewerSelectedTable);
    dbViewerColumns = out.columns;
    dbViewerRows = out.rows;
    dbViewerPrimaryKey = out.primaryKey;
    dbViewerHasRowid = out.hasRowid;
    if (dbViewerMetaEl) {
        const pkLabel = dbViewerPrimaryKey.length ? `PK: ${dbViewerPrimaryKey.join(', ')}` : 'PK: none';
        dbViewerMetaEl.textContent = `${out.total} row(s). ${pkLabel}${dbViewerHasRowid ? ' | rowid available' : ''}`;
    }
    renderDbViewerRows();
    setDbViewerStatus('');
}

function renderDbViewerRows() {
    if (!dbViewerHeadEl || !dbViewerBodyEl) return;
    dbViewerHeadEl.innerHTML = '';
    dbViewerBodyEl.innerHTML = '';
    const cols = [];
    if (dbViewerHasRowid) cols.push('__rowid');
    cols.push(...dbViewerColumns);
    const trHead = document.createElement('tr');
    trHead.className = 'border-b border-slate-700/80';
    const thActions = document.createElement('th');
    thActions.className = 'text-left px-2 py-2 text-slate-300 font-semibold';
    thActions.textContent = 'Actions';
    trHead.appendChild(thActions);
    for (const c of cols) {
        const th = document.createElement('th');
        th.className = 'text-left px-2 py-2 text-slate-300 font-semibold whitespace-nowrap';
        th.textContent = c;
        trHead.appendChild(th);
    }
    dbViewerHeadEl.appendChild(trHead);
    dbViewerRows.forEach((row) => {
        const tr = document.createElement('tr');
        tr.className = 'hover:bg-slate-900/40 align-top';
        const tdAction = document.createElement('td');
        tdAction.className = 'px-2 py-1.5';
        const del = document.createElement('button');
        del.type = 'button';
        del.className = 'px-2 py-1 rounded bg-red-800/90 border border-red-600 text-red-100 text-[11px] font-semibold';
        del.textContent = 'Delete';
        del.addEventListener('click', async () => {
            const identity = {};
            if (dbViewerPrimaryKey.length) {
                const pk = {};
                for (const k of dbViewerPrimaryKey) pk[k] = row[k];
                identity.pk = pk;
            } else if (dbViewerHasRowid) {
                identity.rowid = Number(row.__rowid);
            }
            const keyPreview = dbViewerPrimaryKey.length
                ? dbViewerPrimaryKey.map((k) => `${k}=${String(row[k])}`).join(', ')
                : `rowid=${String(row.__rowid)}`;
            if (!confirm(`Delete row from ${dbViewerSelectedTable}?\\n${keyPreview}`)) return;
            del.disabled = true;
            try {
                await postDbDeleteRow(dbViewerSelectedTable, identity);
                await refreshDbViewerRows();
                try {
                    await reloadCatalogFromApi();
                    await refreshGlobalDiscoveriesFromApi();
                } catch {
                    /* best effort */
                }
            } catch (e) {
                setDbViewerStatus(String(e && e.message ? e.message : e).slice(0, 240));
                del.disabled = false;
            }
        });
        tdAction.appendChild(del);
        tr.appendChild(tdAction);
        for (const c of cols) {
            const td = document.createElement('td');
            td.className = 'px-2 py-1.5 text-slate-200 whitespace-nowrap';
            const v = row[c];
            td.textContent = v == null ? 'NULL' : typeof v === 'object' ? JSON.stringify(v) : String(v);
            tr.appendChild(td);
        }
        dbViewerBodyEl.appendChild(tr);
    });
}

async function openDbViewerModal() {
    setDbViewerModalOpen(true);
    setDbViewerStatus('Loading tables...');
    dbViewerTables = await fetchDbTables();
    if (!dbViewerTables.length) {
        dbViewerSelectedTable = '';
        renderDbViewerTableSelect();
        if (dbViewerMetaEl) dbViewerMetaEl.textContent = 'No tables';
        if (dbViewerHeadEl) dbViewerHeadEl.innerHTML = '';
        if (dbViewerBodyEl) dbViewerBodyEl.innerHTML = '';
        setDbViewerStatus('');
        return;
    }
    if (!dbViewerSelectedTable || !dbViewerTables.includes(dbViewerSelectedTable)) {
        dbViewerSelectedTable = dbViewerTables[0];
    }
    renderDbViewerTableSelect();
    await refreshDbViewerRows();
}

const libraryEl = document.getElementById('library');
const workspaceEl = document.getElementById('workspace');
const factoryWorkspaceEl = document.getElementById('factory-workspace');
const factoryCanvasWrapEl = document.getElementById('factory-canvas-wrap');
const factoryCanvasEl = /** @type {HTMLCanvasElement | null} */ (document.getElementById('factory-canvas'));
const tabLabBtn = document.getElementById('tab-lab');
const tabFactoryBtn = document.getElementById('tab-factory');
const panelLabEl = document.getElementById('panel-lab');
const panelFactoryEl = document.getElementById('panel-factory');
const sidebarHintLab = document.getElementById('sidebar-hint-lab');
const sidebarHintFactory = document.getElementById('sidebar-hint-factory');
const factoryClearBuildingsBtn = document.getElementById('factory-clear-buildings');
const factoryUpgradeSizeBtn = document.getElementById('factory-upgrade-size');
const factoryUpgradeSpeedBtn = document.getElementById('factory-upgrade-speed');
const factoryUpgradeSizeReadout = document.getElementById('factory-upgrade-size-readout');
const factoryUpgradeSpeedReadout = document.getElementById('factory-upgrade-speed-readout');
const authOverlayEl = document.getElementById('auth-overlay');
const authUsernameInput = /** @type {HTMLInputElement | null} */ (document.getElementById('auth-username'));
const authPasswordInput = /** @type {HTMLInputElement | null} */ (document.getElementById('auth-password'));
const authStatusEl = document.getElementById('auth-status');
const authLoginBtn = document.getElementById('auth-login-btn');
const authRegisterBtn = document.getElementById('auth-register-btn');
const authLogoutBtn = document.getElementById('auth-logout-btn');
const authUserPillEl = document.getElementById('auth-user-pill');
const factoryRuntimeStatusEl = document.getElementById('factory-runtime-status');
const factoryRuntimeStatsModalEl = document.getElementById('factory-runtime-stats-modal');
const closeFactoryRuntimeStatsBtn = document.getElementById('close-factory-runtime-stats');
const factoryRuntimeStatsListEl = document.getElementById('factory-runtime-stats-list');
const openGlobalDiscoveriesBtn = document.getElementById('open-global-discoveries');
const openDbViewerBtn = document.getElementById('open-db-viewer');
const openProfileBtn = document.getElementById('open-profile');
const floatingDiscoveryAlertWrapEl = document.getElementById('floating-discovery-alert');
const openLatestDiscoveryBtn = document.getElementById('open-latest-discovery');
const floatingDiscoveryAlertCountEl = document.getElementById('floating-discovery-alert-count');
const deferredDiscoveryPromptWrapEl = document.getElementById('floating-deferred-discovery-prompt');
const openDeferredDiscoveryBtn = document.getElementById('open-deferred-discovery');
const globalDiscoveriesModalEl = document.getElementById('global-discoveries-modal');
const closeGlobalDiscoveriesBtn = document.getElementById('close-global-discoveries');
const globalDiscoveriesCountEl = document.getElementById('global-discoveries-count');
const globalDiscoveriesPageEl = document.getElementById('global-discoveries-page');
const globalDiscoveriesListEl = document.getElementById('global-discoveries-list');
const globalDiscoveriesSortEl = /** @type {HTMLSelectElement | null} */ (document.getElementById('global-discoveries-sort'));
const globalDiscoveriesPrevBtn = document.getElementById('global-discoveries-prev');
const globalDiscoveriesNextBtn = document.getElementById('global-discoveries-next');
const discoveryEditModalEl = document.getElementById('discovery-edit-modal');
const discoveryEditCloseBtn = document.getElementById('discovery-edit-close');
const discoveryEditItemNameEl = document.getElementById('discovery-edit-item-name');
const discoveryEditIngAEl = document.getElementById('discovery-edit-ing-a');
const discoveryEditIngBEl = document.getElementById('discovery-edit-ing-b');
const discoveryEditPickerEl = document.getElementById('discovery-edit-picker');
const discoveryEditPickerLabelEl = document.getElementById('discovery-edit-picker-label');
const discoveryEditSearchInputEl = /** @type {HTMLInputElement | null} */ (document.getElementById('discovery-edit-search-input'));
const discoveryEditSearchResultsEl = document.getElementById('discovery-edit-search-results');
const discoveryEditDeleteBtn = document.getElementById('discovery-edit-delete');
const dbViewerModalEl = document.getElementById('db-viewer-modal');
const closeDbViewerBtn = document.getElementById('close-db-viewer');
const dbViewerTableSelectEl = /** @type {HTMLSelectElement | null} */ (document.getElementById('db-viewer-table-select'));
const dbViewerRefreshBtn = document.getElementById('db-viewer-refresh');
const dbViewerMetaEl = document.getElementById('db-viewer-meta');
const dbViewerStatusEl = document.getElementById('db-viewer-status');
const dbViewerHeadEl = document.getElementById('db-viewer-head');
const dbViewerBodyEl = document.getElementById('db-viewer-body');
const profileModalEl = document.getElementById('profile-modal');
const closeProfileBtn = document.getElementById('close-profile');
const profileUsernameEl = document.getElementById('profile-username');
const profileStatusEl = document.getElementById('profile-status');
const profileTopGridEl = document.getElementById('profile-top-grid');
const discoveryVoteOptionsModalEl = document.getElementById('discovery-vote-options-modal');
const closeDiscoveryVoteOptionsBtn = document.getElementById('close-discovery-vote-options');
const openDiscoveryNameProposalBtn = document.getElementById('open-discovery-name-proposal');
const openDiscoveryImageProposalBtn = document.getElementById('open-discovery-image-proposal');
const discoveryNameProposalModalEl = document.getElementById('discovery-name-proposal-modal');
const closeDiscoveryNameProposalBtn = document.getElementById('close-discovery-name-proposal');
const discoveryProposedNameInputEl = /** @type {HTMLInputElement | null} */ (document.getElementById('discovery-proposed-name-input'));
const discoveryNameProposalStatusEl = document.getElementById('discovery-name-proposal-status');
const submitDiscoveryNameProposalBtn = document.getElementById('submit-discovery-name-proposal');
const discoveryImageProposalModalEl = document.getElementById('discovery-image-proposal-modal');
const closeDiscoveryImageProposalBtn = document.getElementById('close-discovery-image-proposal');
const discoveryProposedImageUrlInputEl = /** @type {HTMLInputElement | null} */ (
    document.getElementById('discovery-proposed-image-url')
);
const submitDiscoveryImageUrlProposalBtn = document.getElementById('submit-discovery-image-url-proposal');
const openDiscoveryImageUploadProposalBtn = document.getElementById('open-discovery-image-upload-proposal');
const discoveryProposedImageFileInputEl = /** @type {HTMLInputElement | null} */ (
    document.getElementById('discovery-proposed-image-file')
);
const discoveryImageProposalStatusEl = document.getElementById('discovery-image-proposal-status');
const discoveryImageProposalPreviewEl = /** @type {HTMLImageElement | null} */ (
    document.getElementById('discovery-image-proposal-preview')
);

/** @type {null | ReturnType<typeof setInterval>} */
let factoryLoopTimerId = null;
/** Last simulation tick timestamp (performance.now), for slide duration smoothing. */
let factoryLastSimTickAt = 0;

function setAuthStatus(msg) {
    if (authStatusEl) authStatusEl.textContent = String(msg || '');
}

function setAuthBusy(on) {
    if (authLoginBtn) authLoginBtn.disabled = on;
    if (authRegisterBtn) authRegisterBtn.disabled = on;
}

function setAuthVisible(visible) {
    if (!authOverlayEl) return;
    authOverlayEl.classList.toggle('hidden', !visible);
}

function storeSessionToken(token) {
    try {
        localStorage.setItem('alchemic-auth-token', token || '');
    } catch {
        /* ignore */
    }
}

function readStoredSessionToken() {
    try {
        return String(localStorage.getItem('alchemic-auth-token') || '');
    } catch {
        return '';
    }
}

function applyLoggedInUi() {
    if (authLogoutBtn) authLogoutBtn.classList.toggle('hidden', !state.auth.token);
    if (authUserPillEl) {
        const has = !!state.auth.token;
        authUserPillEl.classList.toggle('hidden', !has);
        authUserPillEl.textContent = has ? `@${state.auth.username || 'player'}` : '';
    }
    if (factoryRuntimeStatusEl) {
        factoryRuntimeStatusEl.classList.toggle('hidden', !state.auth.token);
    }
    renderFactoryRuntimeStatus();
}

/** @param {number} ms */
function formatMmSs(ms) {
    const total = Math.max(0, Math.floor(Number(ms || 0) / 1000));
    const m = Math.floor(total / 60);
    const s = total % 60;
    return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

/** @param {any} runtime */
function applyFactoryRuntime(runtime) {
    const r = runtime && typeof runtime === 'object' ? runtime : {};
    const runUntilAtMs = Date.parse(String(r.runUntilAt || ''));
    const statsPerMinuteRaw = Array.isArray(r.statsPerMinute) ? r.statsPerMinute : [];
    const statsPerMinute = statsPerMinuteRaw
        .map((row) => {
            const minute = Math.max(1, Number(row && row.minute) | 0);
            const itemsRaw = Array.isArray(row && row.items) ? row.items : [];
            const items = itemsRaw
                .map((it) => ({ itemId: String(it && it.itemId ? it.itemId : '').trim(), qty: Number(it && it.qty ? it.qty : 0) | 0 }))
                .filter((it) => it.itemId && it.qty > 0);
            return { minute, items };
        })
        .filter((row) => row.items.length > 0);
    state.factoryRuntime = {
        running: r.running === true,
        remainingMs: Math.max(0, Number(r.remainingMs || 0)),
        runStoppedAt: typeof r.runStoppedAt === 'string' && r.runStoppedAt.trim() ? r.runStoppedAt : null,
        runUntilAtMs: Number.isFinite(runUntilAtMs) ? runUntilAtMs : 0,
        statsPerMinute
    };
    state.auth.factoryRuntimeSyncedAt = Date.now();
    renderFactoryRuntimeStatus();
}

function renderFactoryRuntimeStatus() {
    if (!factoryRuntimeStatusEl) return;
    if (!state.auth.token) {
        factoryRuntimeStatusEl.textContent = '';
        return;
    }
    const rt = state.factoryRuntime || {};
    if (rt.running && Number(rt.runUntilAtMs || 0) > 0) {
        const rem = Math.max(0, Number(rt.runUntilAtMs) - Date.now());
        rt.remainingMs = rem;
        if (rem <= 0) {
            rt.running = false;
            rt.runStoppedAt = new Date().toISOString();
            rt.runUntilAtMs = 0;
        }
    }
    if (rt.running) {
        factoryRuntimeStatusEl.textContent = `Factory run: ${formatMmSs(rt.remainingMs)} left`;
        factoryRuntimeStatusEl.classList.remove('cursor-pointer');
        return;
    }
    if (rt.runStoppedAt) {
        factoryRuntimeStatusEl.textContent = 'Factory run stopped';
        factoryRuntimeStatusEl.classList.add('cursor-pointer');
        return;
    }
    factoryRuntimeStatusEl.classList.remove('cursor-pointer');
    factoryRuntimeStatusEl.textContent = 'Factory idle';
}

function setFactoryRuntimeStatsModalOpen(open) {
    if (!factoryRuntimeStatsModalEl) return;
    factoryRuntimeStatsModalEl.classList.toggle('hidden', !open);
}

function renderFactoryRuntimeStatsModal() {
    if (!factoryRuntimeStatsListEl) return;
    const rows = Array.isArray(state.factoryRuntime.statsPerMinute) ? state.factoryRuntime.statsPerMinute : [];
    factoryRuntimeStatsListEl.innerHTML = '';
    if (!rows.length) {
        const p = document.createElement('p');
        p.className = 'text-xs text-slate-400';
        p.textContent = 'No production data for last stopped run.';
        factoryRuntimeStatsListEl.appendChild(p);
        return;
    }
    for (const row of rows) {
        const line = document.createElement('div');
        line.className = 'text-xs text-slate-200 border border-slate-700 rounded-lg p-2 bg-slate-900/50';
        const itemsText = row.items
            .map((it) => {
                const lib = state.library.find((e) => e.id === it.itemId);
                const label = lib ? `${emojiForItemId(it.itemId)} ${splitLabel(lib.name).text}` : it.itemId;
                return `${label} x${it.qty}`;
            })
            .join(', ');
        const bucketIdx = Math.max(1, Number(row.minute) | 0) - 1;
        const startSec = bucketIdx * FACTORY_STATS_BUCKET_SECONDS;
        const endSec = startSec + FACTORY_STATS_BUCKET_SECONDS;
        line.textContent = `${startSec}-${endSec}s: ${itemsText}`;
        factoryRuntimeStatsListEl.appendChild(line);
    }
}

async function pullFactoryRuntimeStatus() {
    // Keep runtime endpoint polling disabled, but fetch fresh runtime on demand
    // from the main factory state endpoint so stats modal shows server-truth.
    if (!state.auth.token) return;
    try {
        await pullFactoryStateFromServer();
    } catch {
        /* ignore transient fetch failures */
    }
}

async function startFactoryRunOnServer() {
    if (!state.auth.token) return;
    try {
        const r = await apiFetch('/api/factory/run/start', { method: 'POST' });
        if (!r.ok) return;
        const payload = await r.json();
        if (payload && payload.runtime) applyFactoryRuntime(payload.runtime);
    } catch {
        /* ignore */
    }
}

function startFactoryRuntimeSyncLoop() {
    if (!state.auth.token) return;
    if (state.auth.factoryRuntimeUiTimerId == null) {
        state.auth.factoryRuntimeUiTimerId = setInterval(() => {
            renderFactoryRuntimeStatus();
        }, 1000);
    }
}

function stopFactoryRuntimeSyncLoop() {
    if (state.auth.factoryRuntimeTimerId != null) {
        clearInterval(state.auth.factoryRuntimeTimerId);
        state.auth.factoryRuntimeTimerId = null;
    }
    if (state.auth.factoryRuntimeUiTimerId != null) {
        clearInterval(state.auth.factoryRuntimeUiTimerId);
        state.auth.factoryRuntimeUiTimerId = null;
    }
}

async function postPlayerPing() {
    if (!state.auth.token) return;
    try {
        await apiFetch('/api/player/ping', { method: 'POST' });
    } catch {
        /* ignore transient network failures */
    }
}

function startPlayerPingLoop() {
    if (!state.auth.token) return;
    if (state.auth.playerPingTimerId != null) return;
    state.auth.playerPingTimerId = setInterval(() => {
        void postPlayerPing();
    }, 20000);
    void postPlayerPing();
}

function stopPlayerPingLoop() {
    if (state.auth.playerPingTimerId == null) return;
    clearInterval(state.auth.playerPingTimerId);
    state.auth.playerPingTimerId = null;
}

function normalizeFactoryFromServer(factory) {
    if (!factory || typeof factory !== 'object') return;
    state.factory.placements = factory.placements && typeof factory.placements === 'object' ? factory.placements : {};
    state.factory.cellResources =
        factory.cellResources && typeof factory.cellResources === 'object' ? factory.cellResources : {};
    state.factory.gatheringPoints =
        factory.gatheringPoints && typeof factory.gatheringPoints === 'object' ? factory.gatheringPoints : {};
    state.factory.transporterDirs =
        factory.transporterDirs && typeof factory.transporterDirs === 'object' ? factory.transporterDirs : {};
    state.factory.sorterDirs = factory.sorterDirs && typeof factory.sorterDirs === 'object' ? factory.sorterDirs : {};
    state.factory.sorterItemFilters =
        factory.sorterItemFilters && typeof factory.sorterItemFilters === 'object' ? factory.sorterItemFilters : {};
    state.factory.bridgeDirs = factory.bridgeDirs && typeof factory.bridgeDirs === 'object' ? factory.bridgeDirs : {};
    state.factory.combinerDirs =
        factory.combinerDirs && typeof factory.combinerDirs === 'object' ? factory.combinerDirs : {};
    state.factory.combinerDiscovery =
        factory.combinerDiscovery && typeof factory.combinerDiscovery === 'object'
            ? factory.combinerDiscovery
            : {};
    state.factory.cellItems = factory.cellItems && typeof factory.cellItems === 'object' ? factory.cellItems : {};
    state.factory.itemSlides = {};
    state.factory.cellRejectFlashUntil =
        factory.cellRejectFlashUntil && typeof factory.cellRejectFlashUntil === 'object'
            ? factory.cellRejectFlashUntil
            : {};
    state.factory.sizeUpgradeLevel = Math.max(0, Math.min(MAX_FACTORY_SIZE_LEVEL, Number(factory.sizeUpgradeLevel || 0) | 0));
    state.factory.loopMs = Math.max(MIN_FACTORY_LOOP_MS, Math.round(Number(factory.loopMs || FACTORY_LOOP_MS_DEFAULT)));
    state.factory.loopTick = Number(factory.loopTick || 0) | 0;
    state.factory.cameraX = Number.isFinite(Number(factory.cameraX)) ? Number(factory.cameraX) : state.factory.cameraX;
    state.factory.cameraY = Number.isFinite(Number(factory.cameraY)) ? Number(factory.cameraY) : state.factory.cameraY;
    state.factory.cameraZoom = Number.isFinite(Number(factory.cameraZoom))
        ? Number(factory.cameraZoom)
        : state.factory.cameraZoom;
}

function buildFactoryPayload() {
    return {
        placements: state.factory.placements,
        cellResources: state.factory.cellResources,
        gatheringPoints: state.factory.gatheringPoints,
        transporterDirs: state.factory.transporterDirs,
        sorterDirs: state.factory.sorterDirs,
        sorterItemFilters: state.factory.sorterItemFilters,
        bridgeDirs: state.factory.bridgeDirs,
        sizeUpgradeLevel: state.factory.sizeUpgradeLevel,
        loopMs: state.factory.loopMs,
        loopTick: state.factory.loopTick,
        cellItems: state.factory.cellItems,
        combinerDirs: state.factory.combinerDirs,
        combinerDiscovery: state.factory.combinerDiscovery,
        factoryDiscoveryCombinerKey: state.factory.factoryDiscoveryCombinerKey,
        cellRejectFlashUntil: state.factory.cellRejectFlashUntil,
        cameraX: state.factory.cameraX,
        cameraY: state.factory.cameraY,
        cameraZoom: state.factory.cameraZoom
    };
}

let factoryStateSyncInFlight = false;
let factoryStateSyncQueued = false;

async function flushFactoryStateToServer() {
    if (!state.auth.token) return;
    if (factoryStateSyncInFlight) {
        factoryStateSyncQueued = true;
        return;
    }
    factoryStateSyncInFlight = true;
    try {
        do {
            factoryStateSyncQueued = false;
            const r = await apiFetch('/api/factory/state', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ factory: buildFactoryPayload() })
            });
            if (r.ok) {
                try {
                    const payload = await r.json();
                    if (payload && typeof payload === 'object' && payload.inventory) {
                        applyServerInventorySnapshot(payload.inventory);
                    }
                    if (payload && typeof payload === 'object' && payload.runtime) {
                        applyFactoryRuntime(payload.runtime);
                    }
                } catch {
                    /* ignore non-json responses */
                }
            }
        } while (factoryStateSyncQueued);
    } catch {
        /* ignore transient network failures */
    } finally {
        factoryStateSyncInFlight = false;
    }
}

function notifyFactoryStateMutated() {
    void flushFactoryStateToServer();
}

async function pullFactoryStateFromServer() {
    const r = await apiFetch('/api/factory/state');
    if (!r.ok) throw new Error(await r.text());
    const payload = await r.json();
    normalizeFactoryFromServer(payload && payload.factory ? payload.factory : null);
    if (payload && typeof payload === 'object' && payload.inventory) {
        applyServerInventorySnapshot(payload.inventory);
    }
    if (payload && typeof payload === 'object' && payload.runtime) {
        applyFactoryRuntime(payload.runtime);
    }
}

async function runAuthRequest(path) {
    const username = authUsernameInput ? authUsernameInput.value.trim().toLowerCase() : '';
    const password = authPasswordInput ? authPasswordInput.value : '';
    if (!username || !password) {
        setAuthStatus('Enter login and password.');
        return false;
    }
    setAuthBusy(true);
    setAuthStatus('Please wait...');
    try {
        const r = await fetch(`${apiOrigin()}${path}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username, password })
        });
        if (!r.ok) {
            setAuthStatus((await r.text()) || 'Login failed.');
            return false;
        }
        const payload = await r.json();
        state.auth.token = String(payload.token || '');
        state.auth.username = String(payload.username || username);
        if (payload && typeof payload === 'object' && payload.inventory) {
            applyServerInventorySnapshot(payload.inventory);
        }
        if (payload && typeof payload === 'object' && payload.runtime) {
            applyFactoryRuntime(payload.runtime);
        }
        if (!state.auth.token) {
            setAuthStatus('Invalid auth response.');
            return false;
        }
        storeSessionToken(state.auth.token);
        applyLoggedInUi();
        startPlayerPingLoop();
        startFactoryRuntimeSyncLoop();
        setAuthVisible(false);
        setAuthStatus('');
        return true;
    } catch (err) {
        setAuthStatus(err && err.message ? err.message : 'Network error');
        return false;
    } finally {
        setAuthBusy(false);
    }
}

/** @param {number} col @param {number} row @param {number} dir 0–3 */
function factoryNeighborColRow(col, row, dir) {
    const d = ((dir | 0) + 4) % 4;
    const deltas = [
        [0, -1],
        [1, 0],
        [0, 1],
        [-1, 0]
    ];
    const [dc, dr] = deltas[d];
    return { col: col + dc, row: row + dr };
}

/** @param {number} col @param {number} row */
function factoryInBounds(col, row) {
    return Number.isFinite(col) && Number.isFinite(row);
}

/**
 * Returns direction index (0..3) from one adjacent cell to another, else -1.
 * @param {number} fromCol
 * @param {number} fromRow
 * @param {number} toCol
 * @param {number} toRow
 */
function factoryDirectionFromTo(fromCol, fromRow, toCol, toRow) {
    if (toCol === fromCol && toRow === fromRow - 1) return 0;
    if (toCol === fromCol + 1 && toRow === fromRow) return 1;
    if (toCol === fromCol && toRow === fromRow + 1) return 2;
    if (toCol === fromCol - 1 && toRow === fromRow) return 3;
    return -1;
}

/**
 * Combiners only accept feed on their side ports (left/right relative to output).
 * @param {string} combinerKey
 * @param {string} fromKey
 */
function factoryCombinerCanAcceptFrom(combinerKey, fromKey) {
    const cp = combinerKey.split(',');
    const fp = fromKey.split(',');
    const cc = Number(cp[0]);
    const cr = Number(cp[1]);
    const fc = Number(fp[0]);
    const fr = Number(fp[1]);
    if (!Number.isFinite(cc) || !Number.isFinite(cr) || !Number.isFinite(fc) || !Number.isFinite(fr)) return false;
    const incomingDir = factoryDirectionFromTo(fc, fr, cc, cr);
    if (incomingDir < 0) return false;
    const outDir = factoryCombinerDir(combinerKey);
    const leftIn = (outDir + 1) % 4;
    const rightIn = (outDir + 3) % 4;
    return incomingDir === leftIn || incomingDir === rightIn;
}

/**
 * Extractors → adjacent transporters; belts → storage, empty transporters, or combiners (intake/merge);
 * combiners eject along output dir onto empty transporters.
 */
function factoryRunSimTick(nowTick) {
    const slideT = Number.isFinite(nowTick) ? Number(nowTick) : performance.now();
    const targetMs = factoryLoopIntervalMs();
    const elapsedMs = factoryLastSimTickAt > 0 ? slideT - factoryLastSimTickAt : targetMs;
    factoryLastSimTickAt = slideT;
    const slideDur = Math.max(16, Math.round(Math.min(targetMs * 2.25, Math.max(targetMs * 0.8, elapsedMs))));
    for (const k of Object.keys(state.factory.itemSlides)) {
        if (!state.factory.cellItems[k]) delete state.factory.itemSlides[k];
    }
    const out = simulateFactoryStep(state.factory, {
        inBounds: (col, row) => factoryInBounds(col, row),
        getResourceId: (col, row) => factoryCellResourceId(col, row),
        getTransporterDir: (key) => factoryTransporterDir(key),
        getSorterDir: (key) => factorySorterDir(key),
        getBridgeDir: (key) => factoryBridgeDir(key),
        getCombinerDir: (key) => factoryCombinerDir(key),
        resolveRecipeId: (a, b) => {
            const comboKey = [a, b].sort().join('+');
            const result = state.recipes[comboKey];
            return result && typeof result.id === 'string' ? result.id : null;
        }
    });
    if (isInventoryPanelOpen()) {
        addItemsToPlayerInventory(out && out.invDelta && typeof out.invDelta === 'object' ? out.invDelta : {});
    }
    const moveLike = [
        ...(out.spawns || []),
        ...(out.sorterPulls || []),
        ...(out.bridgeMoves || []),
        ...(out.movesTT || []),
        ...(out.movesToEmptyCombiner || [])
    ];
    for (const mv of moveLike) {
        if (!mv || !mv.from || !mv.to) continue;
        factoryRecordItemSlide(mv.to, mv.from, slideDur, slideT);
    }
    for (const c of out.combined || []) {
        if (!c || !c.combinerKey || !c.outKey) continue;
        factoryClearSlidesTouchingKey(c.combinerKey);
        factoryRecordItemSlide(c.outKey, c.combinerKey, slideDur, slideT);
    }
}

function stopFactoryLoop() {
    if (factoryLoopTimerId != null) {
        clearInterval(factoryLoopTimerId);
        factoryLoopTimerId = null;
    }
    factoryLastSimTickAt = 0;
}

function onFactoryLoopTick() {
    const now = performance.now();
    factoryRunSimTick(now);
    state.factory.loopTick = (state.factory.loopTick | 0) + 1;
    state.factory.loopPulseUntil = now + 120;
}

function startFactoryLoop() {
    stopFactoryLoop();
    if (state.activeWorkspace !== 'factory' || !factoryCanvasEl) return;
    const ms = factoryLoopIntervalMs();
    factoryLastSimTickAt = performance.now();
    factoryLoopTimerId = setInterval(onFactoryLoopTick, ms);
}

function restartFactoryLoop() {
    if (state.activeWorkspace === 'factory') startFactoryLoop();
}

function updateFactoryUpgradeBar() {
    const cols = factoryGridCols();
    const rows = factoryGridRows();
    if (factoryUpgradeSizeReadout) {
        factoryUpgradeSizeReadout.textContent = `${cols}×${rows}`;
    }
    if (factoryUpgradeSpeedReadout) {
        factoryUpgradeSpeedReadout.textContent = `${factoryLoopIntervalMs()} ms`;
    }
    if (factoryUpgradeSizeBtn) {
        const maxed = state.factory.sizeUpgradeLevel >= MAX_FACTORY_SIZE_LEVEL;
        factoryUpgradeSizeBtn.disabled = maxed;
    }
    if (factoryUpgradeSpeedBtn) {
        factoryUpgradeSpeedBtn.disabled = !factoryCanSpeedUpgrade();
    }
}
const modal = document.getElementById('discovery-modal');
const clearBtn = document.getElementById('clear-btn');
const factoryClearBtn = document.getElementById('factory-clear-btn');
const discoveryTitleEl = document.getElementById('discovery-title');
const discoverySelectedNameEl = document.getElementById('discovery-selected-name');
const discoveryStepNameEl = document.getElementById('discovery-step-name');
const discoveryStepImageEl = document.getElementById('discovery-step-image');
const discoveryImageDoneBtn = document.getElementById('discovery-image-done');
const modalPreview = document.getElementById('modal-preview');
const aiWrap = document.getElementById('ai-suggestions-wrap');
const aiStatus = document.getElementById('ai-status');
const aiOutgoingWrap = document.getElementById('ai-outgoing-wrap');
const aiOutgoingEl = document.getElementById('ai-outgoing');
const aiReplyWrap = document.getElementById('ai-reply-wrap');
const aiReplyFullEl = document.getElementById('ai-reply-full');
const aiSuggestionsEl = document.getElementById('ai-suggestions');
const discoveryAiImageBtn = document.getElementById('discovery-ai-image-btn');
const discoveryOpenCustomIconBtn = document.getElementById('discovery-open-custom-icon');
const discoveryCustomIconModal = document.getElementById('discovery-custom-icon-modal');
const discoveryCustomIconCloseBtn = document.getElementById('close-discovery-custom-icon');
const discoveryCustomIconOkBtn = document.getElementById('discovery-custom-icon-ok');
const discoveryTakeIconBtn = document.getElementById('discovery-take-icon');
const discoveryIconUrlInput = document.getElementById('discovery-icon-url');
const discoveryApplyIconUrlBtn = document.getElementById('discovery-apply-icon-url');
const discoveryUploadIconBtn = document.getElementById('discovery-upload-icon-btn');
const discoveryUploadIconFileInput = /** @type {HTMLInputElement | null} */ (
    document.getElementById('discovery-upload-icon-file')
);
const discoveryAiImageStatus = document.getElementById('discovery-ai-image-status');
const discoveryAiImageImg = document.getElementById('discovery-ai-image-img');
const discoveryAiImageGridEl = document.getElementById('discovery-ai-image-grid');
const discoveryAiImageQueryInput = /** @type {HTMLInputElement | null} */ (document.getElementById('discovery-ai-image-query'));
const discoveryAiImagePrevBtn = document.getElementById('discovery-ai-image-prev');
const discoveryAiImageNextBtn = document.getElementById('discovery-ai-image-next');
const discoveryAiImagePageEl = document.getElementById('discovery-ai-image-page');
const discoveryCustomIconStatus = document.getElementById('discovery-custom-icon-status');
const saveDiscoveryBtn = document.getElementById('save-discovery');
const rejectDiscoveryBtn = document.getElementById('reject-discovery');
const discoveryNameInputEl = /** @type {HTMLInputElement | null} */ (document.getElementById('discovery-name-input'));
const discoveryEmojiInputEl = /** @type {HTMLInputElement | null} */ (document.getElementById('discovery-emoji-input'));
const discoveryNameColorGridEl = document.getElementById('discovery-name-color-grid');

/** How many icon candidates to show for each client-side search. */
const DISCOVERY_ICON_VARIANT_COUNT = 8;
let lastAutoIconSearchQuery = '';
let discoveryIconSearchPage = 0;
let discoveryIconSearchLastCount = 0;

const AI_REPLY_BASE_CLASS =
    'text-[11px] leading-snug whitespace-pre-wrap break-words max-h-64 overflow-y-auto rounded-lg border p-2.5';

/**
 * Green / red / neutral using inline styles so colors always show.
 * @param {HTMLElement | null} el
 * @param {boolean | null} makesenceYes
 */
function applyAiExplanationAppearance(el, makesenceYes) {
    if (!el) return;
    el.className = AI_REPLY_BASE_CLASS;
    el.style.borderStyle = 'solid';
    el.style.borderWidth = '1px';
    if (makesenceYes === true) {
        el.style.borderColor = 'rgba(16, 185, 129, 0.65)';
        el.style.backgroundColor = 'rgba(6, 78, 59, 0.42)';
        el.style.color = 'rgb(167, 243, 208)';
    } else if (makesenceYes === false) {
        el.style.borderColor = 'rgba(239, 68, 68, 0.75)';
        el.style.backgroundColor = 'rgba(69, 10, 10, 0.5)';
        el.style.color = 'rgb(254, 202, 202)';
    } else {
        el.style.borderColor = 'rgb(71, 85, 105)';
        el.style.backgroundColor = 'rgba(15, 23, 42, 0.72)';
        el.style.color = 'rgb(203, 213, 225)';
    }
}

function clearAiFullReplyUi() {
    if (aiReplyFullEl) {
        aiReplyFullEl.textContent = '';
        aiReplyFullEl.removeAttribute('style');
        aiReplyFullEl.className = `${AI_REPLY_BASE_CLASS} border border-slate-600 bg-slate-900/70 text-slate-300`;
    }
    if (aiReplyWrap) aiReplyWrap.classList.add('hidden');
}

function updateFloatingDiscoveryAlert(blink) {
    const pendingCount = Array.isArray(state.pendingDiscoveryNotices) ? state.pendingDiscoveryNotices.length : 0;
    const hasPending = pendingCount > 0;
    if (floatingDiscoveryAlertWrapEl) {
        floatingDiscoveryAlertWrapEl.classList.toggle('hidden', !hasPending);
    }
    if (floatingDiscoveryAlertCountEl) {
        floatingDiscoveryAlertCountEl.textContent = String(pendingCount);
    }
    if (!openLatestDiscoveryBtn) return;
    openLatestDiscoveryBtn.disabled = !hasPending;
    if (blink && hasPending) {
        openLatestDiscoveryBtn.classList.remove('is-blinking');
        void openLatestDiscoveryBtn.offsetWidth;
        openLatestDiscoveryBtn.classList.add('is-blinking');
        setTimeout(() => {
            if (openLatestDiscoveryBtn) openLatestDiscoveryBtn.classList.remove('is-blinking');
        }, 2000);
    }
}

function setDeferredDiscoveryPrompt(pending) {
    deferredDiscoveryPromptPending = pending || null;
    if (!deferredDiscoveryPromptWrapEl) return;
    deferredDiscoveryPromptWrapEl.classList.toggle('hidden', !deferredDiscoveryPromptPending);
}

function rememberDeferredDiscovery(pending) {
    if (!pending || !pending.a || !pending.b) return;
    const key = String(pending.key || [pending.a.id, pending.b.id].sort().join('+'));
    if (!key) return;
    state.deferredDiscoveries[key] = true;
}

function isDeferredDiscoveryCombo(comboKey) {
    return !!state.deferredDiscoveries[String(comboKey || '')];
}

function getDiscoveryExistingItemId() {
    return state.pendingCombination && typeof state.pendingCombination.resultId === 'string'
        ? state.pendingCombination.resultId
        : '';
}

/**
 * Apply parsed AI discovery reply to the discovery modal UI.
 * @param {{ suggestions: { name: string, emoji: string }[], explanation: string, makesenceYes: boolean | null }} parsed
 */
function applyDiscoveryAiResult(parsed) {
    state.aiSuggestions = parsed.suggestions;
    state.discoverySelectedName = '';
    if (aiStatus) aiStatus.textContent = '';
    if (aiOutgoingWrap) aiOutgoingWrap.classList.add('hidden');
    if (aiOutgoingEl) aiOutgoingEl.textContent = '';
    syncDiscoverySelectedNameUi();
    renderAiSuggestions();
    updateDiscoverySaveButton();
}

function clearDiscoveryAiImageGrid() {
    if (!discoveryAiImageGridEl) return;
    discoveryAiImageGridEl.classList.add('hidden');
    const choices = discoveryAiImageGridEl.querySelectorAll('.discovery-ai-image-choice');
    choices.forEach((btn) => {
        btn.classList.add('hidden');
        const img = btn.querySelector('img');
        if (img) img.removeAttribute('src');
        btn.classList.remove('ring-2', 'ring-blue-400', 'border-blue-500');
        btn.classList.add('border-slate-600');
        btn.removeAttribute('aria-pressed');
    });
}

function syncDiscoveryImagePagerUi() {
    if (discoveryAiImagePageEl) discoveryAiImagePageEl.textContent = `Page ${discoveryIconSearchPage + 1}`;
    if (discoveryAiImagePrevBtn) discoveryAiImagePrevBtn.disabled = discoveryIconSearchPage <= 0;
    if (discoveryAiImageNextBtn) {
        discoveryAiImageNextBtn.disabled = discoveryIconSearchLastCount < DISCOVERY_ICON_VARIANT_COUNT;
    }
}

/**
 * @param {string} url
 * @param {HTMLElement} selectedBtn
 */
function selectDiscoveryAiCandidate(url, selectedBtn) {
    state.discoveryPreviewUrl = url;
    state.discoveryPreviewDataUrl = '';
    if (discoveryAiImageImg) {
        discoveryAiImageImg.src = url;
        discoveryAiImageImg.classList.remove('hidden');
    }
    if (!discoveryAiImageGridEl) return;
    const choices = discoveryAiImageGridEl.querySelectorAll('.discovery-ai-image-choice');
    choices.forEach((btn) => {
        const on = btn === selectedBtn;
        btn.classList.toggle('ring-2', on);
        btn.classList.toggle('ring-blue-400', on);
        btn.classList.toggle('border-blue-500', on);
        btn.classList.toggle('border-slate-600', !on);
        btn.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
    if (discoveryTakeIconBtn) discoveryTakeIconBtn.disabled = false;
}

function unselectDiscoveryAiCandidate() {
    state.discoveryPreviewUrl = '';
    state.discoveryPreviewDataUrl = '';
    if (discoveryAiImageImg) {
        discoveryAiImageImg.removeAttribute('src');
        discoveryAiImageImg.classList.add('hidden');
    }
    if (discoveryAiImageGridEl) {
        const choices = discoveryAiImageGridEl.querySelectorAll('.discovery-ai-image-choice');
        choices.forEach((btn) => {
            btn.classList.remove('ring-2', 'ring-blue-400', 'border-blue-500');
            btn.classList.add('border-slate-600');
            btn.setAttribute('aria-pressed', 'false');
        });
    }
    if (discoveryTakeIconBtn) discoveryTakeIconBtn.disabled = true;
}

/**
 * @param {string[]} urls
 */
function renderDiscoveryAiCandidates(urls) {
    clearDiscoveryAiImageGrid();
    if (!discoveryAiImageGridEl) return;
    const list = urls
        .filter((u) => typeof u === 'string' && u.trim())
        .slice(0, DISCOVERY_ICON_VARIANT_COUNT);
    if (!list.length) return;
    const choices = discoveryAiImageGridEl.querySelectorAll('.discovery-ai-image-choice');
    discoveryAiImageGridEl.classList.remove('hidden');
    list.forEach((u, i) => {
        const btn = choices[i];
        if (!btn) return;
        const img = btn.querySelector('img');
        if (img) img.src = u;
        btn.classList.remove('hidden');
    });
}

if (discoveryAiImageGridEl) {
    discoveryAiImageGridEl.addEventListener('click', (ev) => {
        const t = ev.target;
        if (!t || !(t instanceof Element)) return;
        const btn = t.closest('.discovery-ai-image-choice');
        if (!btn || btn.classList.contains('hidden')) return;
        const img = btn.querySelector('img');
        const u = img && img.getAttribute('src');
        if (!u) return;
        const isSelected = btn.getAttribute('aria-pressed') === 'true' && state.discoveryPreviewUrl === u;
        if (isSelected) {
            unselectDiscoveryAiCandidate();
            return;
        }
        selectDiscoveryAiCandidate(u, /** @type {HTMLElement} */ (btn));
    });
}

function resetDiscoveryAiImagePreview() {
    state.discoveryPreviewUrl = '';
    state.discoveryPreviewDataUrl = '';
    state.discoveryIconItemId = '';
    lastAutoIconSearchQuery = '';
    discoveryIconSearchPage = 0;
    discoveryIconSearchLastCount = 0;
    if (discoveryAiImageBtn) discoveryAiImageBtn.disabled = false;
    if (discoveryTakeIconBtn) discoveryTakeIconBtn.disabled = true;
    if (discoveryApplyIconUrlBtn) discoveryApplyIconUrlBtn.disabled = false;
    if (discoveryUploadIconBtn) discoveryUploadIconBtn.disabled = false;
    if (discoveryIconUrlInput) discoveryIconUrlInput.value = '';
    if (discoveryAiImageQueryInput) discoveryAiImageQueryInput.value = '';
    if (discoveryUploadIconFileInput) discoveryUploadIconFileInput.value = '';
    if (discoveryCustomIconModal) discoveryCustomIconModal.classList.add('hidden');
    if (discoveryAiImageStatus) discoveryAiImageStatus.textContent = '';
    if (discoveryCustomIconStatus) discoveryCustomIconStatus.textContent = '';
    syncDiscoveryImagePagerUi();
    clearDiscoveryAiImageGrid();
    if (discoveryAiImageImg) {
        discoveryAiImageImg.removeAttribute('src');
        discoveryAiImageImg.classList.add('hidden');
    }
}

/** @returns {string} */
function defaultDiscoveryImageQueryFromName() {
    const itemName = getDiscoveryChosenName() || (state.discoveryIconItemName || '').trim() || 'item';
    return `${itemName} isometric`;
}

/** @returns {string} */
function buildDiscoveryImageQuery() {
    const typed = discoveryAiImageQueryInput ? discoveryAiImageQueryInput.value.trim() : '';
    if (typed) return typed;
    return defaultDiscoveryImageQueryFromName();
}

function syncDiscoveryImageQueryInput() {
    if (!discoveryAiImageQueryInput) return;
    discoveryAiImageQueryInput.value = defaultDiscoveryImageQueryFromName();
}

function setDiscoveryStep(step) {
    const isName = step === 'name';
    if (discoveryStepNameEl) discoveryStepNameEl.classList.toggle('hidden', !isName);
    if (discoveryStepImageEl) discoveryStepImageEl.classList.toggle('hidden', isName);
}

async function generateDiscoveryIconPreview(targetPage) {
    if (!discoveryAiImageBtn) return;
    const page = Math.max(0, Number(targetPage ?? discoveryIconSearchPage) | 0);
    discoveryAiImageBtn.disabled = true;
    if (discoveryTakeIconBtn) discoveryTakeIconBtn.disabled = true;
    if (discoveryAiImagePrevBtn) discoveryAiImagePrevBtn.disabled = true;
    if (discoveryAiImageNextBtn) discoveryAiImageNextBtn.disabled = true;
    if (discoveryAiImageStatus) {
        discoveryAiImageStatus.textContent = 'Searching isometric images…';
    }
    clearDiscoveryAiImageGrid();
    try {
        const query = buildDiscoveryImageQuery();
        const out = await fetchImageSearchResults({
            query,
            limit: DISCOVERY_ICON_VARIANT_COUNT,
            offset: page * DISCOVERY_ICON_VARIANT_COUNT
        });
        const urls = Array.isArray(out && out.images) ? out.images : [];
        if (!urls.length) throw new Error('No image URLs in response');
        renderDiscoveryAiCandidates(urls);
        discoveryIconSearchPage = page;
        discoveryIconSearchLastCount = urls.length;
        if (discoveryAiImageStatus) {
            discoveryAiImageStatus.textContent = `Found ${urls.length} images. Tap one to select it.`;
        }
    } catch (err) {
        let msg = err && typeof err.message === 'string' ? err.message : String(err);
        state.discoveryPreviewUrl = '';
        discoveryIconSearchLastCount = 0;
        clearDiscoveryAiImageGrid();
        if (discoveryAiImageStatus) {
            discoveryAiImageStatus.textContent = `Image search failed. ${msg.slice(0, 220)}`;
        }
    } finally {
        discoveryAiImageBtn.disabled = false;
        if (discoveryTakeIconBtn) discoveryTakeIconBtn.disabled = true;
        syncDiscoveryImagePagerUi();
    }
}

function autoSearchDiscoveryIconsFromSuggestion() {
    const query = buildDiscoveryImageQuery();
    if (!query || query === lastAutoIconSearchQuery) return;
    lastAutoIconSearchQuery = query;
    discoveryIconSearchPage = 0;
    void generateDiscoveryIconPreview(0);
}

function upsertDiscoveryLocalRecord(id, emoji, name, nameColor, ingredientA, ingredientB) {
    state.recipes[[ingredientA, ingredientB].sort().join('+')] = { id, emoji, name };
    const li = state.library.findIndex((e) => e.id === id);
    const row = { id, emoji, name };
    const normalizedColor = normalizeItemNameColor(nameColor);
    if (normalizedColor) row.nameColor = normalizedColor;
    if (li === -1) state.library.push(row);
    else state.library[li] = row;
    recomputeAllTiers();
}

function placeDiscoveryResultForPending(pending, id, emoji, name) {
    if (pending.resultPlaced) return;
    const newElement = { id, emoji, name };
    const factoryCombKey = pending.factoryCombKey || '';
    if (!factoryCombKey) {
        const midX = (pending.a.x + pending.b.x) / 2;
        const midY = (pending.a.y + pending.b.y) / 2;
        const placed = state.library.find((e) => e.id === id) || newElement;
        createElementOnCanvas(placed, midX + 40, midY + 40);
        showPulse(midX + 40, midY + 40, 'bg-yellow-400');
    } else {
        delete state.factory.combinerDiscovery[factoryCombKey];
        state.factory.cellItems[factoryCombKey] = id;
        notifyFactoryStateMutated();
    }
    pending.resultPlaced = true;
}

async function savePendingDiscovery(pending, name, emoji, nameColor) {
    if (!pending || !pending.a || !pending.b) return;
    const text = String(name || '').trim();
    if (!text) return;
    const icon = normalizeSuggestionEmoji(emoji) || '✨';
    const normalizedColor = normalizeItemNameColor(nameColor);
    const existingId = typeof pending.resultId === 'string' ? pending.resultId : '';
    const id = existingId || slugFromNameText(text);
    upsertDiscoveryLocalRecord(
        id,
        icon,
        text,
        normalizedColor,
        String(pending.a.id || ''),
        String(pending.b.id || '')
    );
    placeDiscoveryResultForPending(pending, id, icon, text);
    pending.resultId = id;
    pending.name = text;
    pending.emoji = icon;
    pending.nameColor = normalizedColor;
    if (pending.key) delete state.deferredDiscoveries[String(pending.key)];
    renderLibrary();
    try {
        await postItemUpsertRemote({
            id,
            emoji: icon,
            name: text,
            name_color: normalizedColor || '',
            ingredient_a: String(pending.a.id || ''),
            ingredient_b: String(pending.b.id || '')
        });
    } catch (err) {
        console.warn(err);
    }
}

async function saveDiscoveryAndStartIcon() {
    const text = getDiscoveryChosenName();
    if (!text || suggestionAlreadyInLibrary(text)) return;
    const pending = state.pendingCombination;
    if (!pending) return;
    const icon = getDiscoveryChosenEmoji();
    const nameColor = state.discoveryNameColor;
    if (saveDiscoveryBtn) saveDiscoveryBtn.disabled = true;
    try {
        await savePendingDiscovery(pending, text, icon, nameColor);
    } catch (err) {
        console.warn(err);
        if (discoveryAiImageStatus) {
            discoveryAiImageStatus.textContent =
                'Could not sync to catalog — try again. ' +
                (err && typeof err.message === 'string' ? err.message.slice(0, 120) : '');
        }
        return;
    } finally {
        if (saveDiscoveryBtn) saveDiscoveryBtn.disabled = false;
    }

    const itemId = String(pending.resultId || '');
    const selectedImageUrl = String(state.discoveryPreviewUrl || '').trim();
    const selectedImageDataUrl = String(state.discoveryPreviewDataUrl || '').trim();
    state.discoveryIconItemName = text;
    state.discoveryIconItemId = itemId;
    state.pendingCombination = null;
    state.aiSuggestions = [];
    state.discoverySelectedName = '';
    if (aiWrap) aiWrap.classList.add('hidden');
    clearAiFullReplyUi();
    if (aiOutgoingWrap) aiOutgoingWrap.classList.add('hidden');
    if (aiOutgoingEl) aiOutgoingEl.textContent = '';
    state.discoveryPreviewUrl = '';
    state.discoveryPreviewDataUrl = '';
    clearDiscoveryAiImageGrid();
    if (discoveryAiImageImg) {
        discoveryAiImageImg.removeAttribute('src');
        discoveryAiImageImg.classList.add('hidden');
    }
    if (itemId && selectedImageDataUrl) {
        try {
            const out = await postSaveItemIconRemote(itemId, '', {
                strictUserUrl: true,
                imageDataUrl: selectedImageDataUrl
            });
            if (typeof out.iconPath === 'string' && out.iconPath.trim()) {
                persistIconPathForItem(itemId, out.iconPath.trim());
            }
            await reloadCatalogFromApi();
            if (discoveryAiImageStatus) discoveryAiImageStatus.textContent = 'Discovery and icon saved.';
        } catch (e) {
            const msg = e && typeof e.message === 'string' ? e.message : String(e);
            if (discoveryAiImageStatus) {
                discoveryAiImageStatus.textContent =
                    `Discovery saved, icon upload failed: ${msg.slice(0, 180)}`;
            }
        }
    } else if (itemId && selectedImageUrl) {
        try {
            const out = await postSaveItemIconRemote(itemId, selectedImageUrl);
            if (typeof out.iconPath === 'string' && out.iconPath.trim()) {
                persistIconPathForItem(itemId, out.iconPath.trim());
            }
            await reloadCatalogFromApi();
            if (discoveryAiImageStatus) discoveryAiImageStatus.textContent = 'Discovery and icon saved.';
        } catch (e) {
            const msg = e && typeof e.message === 'string' ? e.message : String(e);
            if (discoveryAiImageStatus) {
                discoveryAiImageStatus.textContent =
                    `Discovery saved, icon download failed: ${msg.slice(0, 180)}`;
            }
        }
    } else if (discoveryAiImageStatus) {
        discoveryAiImageStatus.textContent = 'Discovery saved.';
    }
    if (saveDiscoveryBtn) {
        saveDiscoveryBtn.disabled = true;
        saveDiscoveryBtn.textContent = 'Saved';
    }
    setDiscoveryStep('name');
    state.discoveryIconItemName = '';
    if (aiWrap) aiWrap.classList.add('hidden');
    clearAiFullReplyUi();
    if (aiOutgoingWrap) aiOutgoingWrap.classList.add('hidden');
    if (aiOutgoingEl) aiOutgoingEl.textContent = '';
    resetDiscoveryAiImagePreview();
    modal.classList.add('hidden');
}

async function applyDiscoveryIconFromUrl() {
    const raw = discoveryIconUrlInput ? discoveryIconUrlInput.value.trim() : '';
    if (!raw) {
        if (discoveryCustomIconStatus) discoveryCustomIconStatus.textContent = 'Enter an image URL first.';
        return;
    }
    let parsed;
    try {
        parsed = new URL(raw);
    } catch {
        if (discoveryCustomIconStatus) discoveryCustomIconStatus.textContent = 'That URL is not valid.';
        return;
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        if (discoveryCustomIconStatus) discoveryCustomIconStatus.textContent = 'Use an http or https image URL.';
        return;
    }
    if (discoveryApplyIconUrlBtn) discoveryApplyIconUrlBtn.disabled = true;
    if (discoveryCustomIconStatus) discoveryCustomIconStatus.textContent = 'Using URL...';
    try {
        state.discoveryPreviewDataUrl = '';
        state.discoveryPreviewUrl = raw;
        clearDiscoveryAiImageGrid();
        if (discoveryAiImageImg) {
            discoveryAiImageImg.src = raw;
            discoveryAiImageImg.classList.remove('hidden');
        }
        if (discoveryCustomIconStatus) {
            discoveryCustomIconStatus.textContent = 'Custom icon selected.';
        }
        if (discoveryAiImageStatus) discoveryAiImageStatus.textContent = 'Custom icon selected.';
        if (discoveryTakeIconBtn) discoveryTakeIconBtn.disabled = true;
    } catch (e) {
        const msg = e && typeof e.message === 'string' ? e.message : String(e);
        if (discoveryCustomIconStatus) discoveryCustomIconStatus.textContent = msg.slice(0, 280);
    } finally {
        if (discoveryApplyIconUrlBtn) discoveryApplyIconUrlBtn.disabled = false;
    }
}

async function applyDiscoveryIconFromUpload(file) {
    const v = validateDiscoveryUploadFile(file);
    if (!v.ok) {
        if (discoveryCustomIconStatus) discoveryCustomIconStatus.textContent = v.message;
        return;
    }
    if (discoveryUploadIconBtn) discoveryUploadIconBtn.disabled = true;
    if (discoveryCustomIconStatus) discoveryCustomIconStatus.textContent = 'Uploading...';
    try {
        const imageDataUrl = await fileToDataUrl(file);
        state.discoveryPreviewDataUrl = imageDataUrl;
        state.discoveryPreviewUrl = '';
        clearDiscoveryAiImageGrid();
        if (discoveryAiImageImg) {
            discoveryAiImageImg.src = imageDataUrl;
            discoveryAiImageImg.classList.remove('hidden');
        }
        if (discoveryCustomIconStatus) discoveryCustomIconStatus.textContent = 'Custom upload selected.';
        if (discoveryAiImageStatus) discoveryAiImageStatus.textContent = 'Custom icon selected.';
        if (discoveryTakeIconBtn) discoveryTakeIconBtn.disabled = true;
    } catch (e) {
        const msg = e && typeof e.message === 'string' ? e.message : String(e);
        if (discoveryCustomIconStatus) discoveryCustomIconStatus.textContent = msg.slice(0, 280);
    } finally {
        if (discoveryUploadIconBtn) discoveryUploadIconBtn.disabled = false;
        if (discoveryUploadIconFileInput) discoveryUploadIconFileInput.value = '';
    }
}

function suggestionAlreadyInLibrary(nameText) {
    const id = slugFromNameText(nameText);
    const currentId = getDiscoveryExistingItemId();
    return state.library.some((e) => {
        if (currentId && e.id === currentId) return false;
        return e.id === id || slugFromNameText(e.name) === id;
    });
}

function getDiscoveryChosenName() {
    const inputName = discoveryNameInputEl ? discoveryNameInputEl.value : '';
    return String(inputName || state.discoverySelectedName || '').trim();
}

function getDiscoveryChosenEmoji() {
    const typed = discoveryEmojiInputEl ? discoveryEmojiInputEl.value : '';
    const cleanTyped = normalizeSuggestionEmoji(typed);
    if (cleanTyped) return cleanTyped;
    const name = getDiscoveryChosenName();
    const chosen = state.aiSuggestions.find((s) => s && s.name === name);
    const fromSuggestion = chosen && typeof chosen.emoji === 'string' ? normalizeSuggestionEmoji(chosen.emoji) : '';
    return fromSuggestion || '✨';
}

function syncDiscoverySelectedNameUi() {
    const t = getDiscoveryChosenName();
    if (discoveryNameInputEl && discoveryNameInputEl.value !== t) {
        discoveryNameInputEl.value = t;
    }
    if (discoverySelectedNameEl) {
        discoverySelectedNameEl.textContent = t || '— Tap a suggestion —';
    }
}

function isDiscoveryNameAllowed(name) {
    const n = String(name || '').trim();
    return n.length > 0;
}

function setDiscoveryNameColor(color) {
    state.discoveryNameColor = normalizeItemNameColor(color);
    renderDiscoveryNameColorChoices();
}

function renderDiscoveryNameColorChoices() {
    if (!discoveryNameColorGridEl) return;
    discoveryNameColorGridEl.innerHTML = '';
    for (const color of DISCOVERY_NAME_COLOR_CHOICES) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'discovery-color-swatch' + (state.discoveryNameColor === color ? ' is-selected' : '');
        btn.style.backgroundColor = color;
        btn.title = color;
        btn.setAttribute('aria-label', `Name color ${color}`);
        btn.setAttribute('aria-pressed', state.discoveryNameColor === color ? 'true' : 'false');
        btn.addEventListener('click', () => setDiscoveryNameColor(color));
        discoveryNameColorGridEl.appendChild(btn);
    }
}

function updateDiscoverySaveButton() {
    const name = getDiscoveryChosenName();
    const valid = isDiscoveryNameAllowed(name) && !suggestionAlreadyInLibrary(name);
    if (saveDiscoveryBtn) saveDiscoveryBtn.disabled = !valid;
}

function setDiscoverySelectedName(name, emoji, opts) {
    state.discoverySelectedName = String(name || '').trim();
    if (discoveryNameInputEl) discoveryNameInputEl.value = state.discoverySelectedName;
    if (discoveryEmojiInputEl && typeof emoji === 'string') {
        discoveryEmojiInputEl.value = normalizeSuggestionEmoji(emoji) || '';
    }
    syncDiscoveryImageQueryInput();
    syncDiscoverySelectedNameUi();
    renderAiSuggestions();
    updateDiscoverySaveButton();
    if (opts && opts.autoSearchImages === true) {
        autoSearchDiscoveryIconsFromSuggestion();
    }
}

function renderAiSuggestions() {
    if (!aiSuggestionsEl) return;
    aiSuggestionsEl.innerHTML = '';
    const chosen = getDiscoveryChosenName();
    state.aiSuggestions.forEach((prop) => {
        const propName = prop && typeof prop.name === 'string' ? prop.name : '';
        const propEmoji = prop && typeof prop.emoji === 'string' ? prop.emoji : '';
        if (!propName) return;
        const already = suggestionAlreadyInLibrary(propName);
        const selected = chosen && propName === chosen;
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.disabled = already;
        btn.className =
            'text-left py-2 px-3 rounded-lg border text-sm transition flex items-start gap-2 min-w-0 ' +
            (already
                ? 'opacity-40 cursor-not-allowed bg-slate-900/50 border-slate-700'
                : selected
                  ? 'bg-slate-800 border-blue-500 ring-1 ring-blue-400/50 hover:bg-slate-800'
                  : 'bg-slate-900/80 border-slate-600 hover:border-blue-500 hover:bg-slate-800');
        const emojiSpan = document.createElement('span');
        emojiSpan.className = 'text-lg leading-none select-none shrink-0 mt-0.5';
        emojiSpan.setAttribute('aria-hidden', 'true');
        emojiSpan.textContent = propEmoji || '✨';
        const nameSpan = document.createElement('span');
        nameSpan.className =
            'text-slate-200 flex-1 min-w-0 whitespace-normal break-words text-left leading-snug';
        nameSpan.textContent = propName;
        btn.appendChild(emojiSpan);
        btn.appendChild(nameSpan);
        btn.addEventListener('click', () => {
            if (already) return;
            setDiscoverySelectedName(propName, propEmoji, { autoSearchImages: false });
        });
        aiSuggestionsEl.appendChild(btn);
    });
}

function runDiscoveryAi(a, b) {
    if (aiOutgoingWrap) aiOutgoingWrap.classList.add('hidden');
    if (aiOutgoingEl) aiOutgoingEl.textContent = '';
    clearAiFullReplyUi();
    if (aiStatus) aiStatus.textContent = '';
    if (aiSuggestionsEl) aiSuggestionsEl.innerHTML = '';
    state.aiSuggestions = [];
    state.discoverySelectedName = '';
    if (discoveryNameInputEl) discoveryNameInputEl.value = '';
    if (discoveryEmojiInputEl) discoveryEmojiInputEl.value = '';
    syncDiscoverySelectedNameUi();
    updateDiscoverySaveButton();
    fetchAiPropositions(a, b)
        .then((parsed) => {
            applyDiscoveryAiResult(parsed);
        })
        .catch((err) => {
            console.error(err);
            clearAiFullReplyUi();
            if (aiStatus) aiStatus.textContent = '';
            state.aiSuggestions = [];
            state.discoverySelectedName = '';
            if (discoveryNameInputEl) discoveryNameInputEl.value = '';
            if (discoveryEmojiInputEl) discoveryEmojiInputEl.value = '';
            syncDiscoverySelectedNameUi();
            updateDiscoverySaveButton();
        });
}

function startAiForCombination(a, b) {
    if (!aiSuggestionsEl) return;
    runDiscoveryAi(a, b);
}

async function queueDiscoveryNotice(a, b, comboKey, preloadedParsed, factoryCombKey) {
    const notice = {
        a,
        b,
        key: comboKey,
        preloadedParsed,
        resultId: '',
        resultPlaced: false,
        factoryCombKey: String(factoryCombKey || ''),
        name: '',
        emoji: '✨'
    };
    const unnamedName = makeUnnamedDiscoveryName();
    await savePendingDiscovery(notice, unnamedName, '✨', '');
    state.pendingDiscoveryNotices.push(notice);
    updateFloatingDiscoveryAlert(true);
}

function openLatestPendingDiscoveryModal() {
    const notice = state.pendingDiscoveryNotices.pop();
    if (!notice) return;
    updateFloatingDiscoveryAlert(false);
    openDiscoveryModal(notice, notice.preloadedParsed);
}

// Initialize Library
function renderLibrary() {
    libraryEl.innerHTML = '';
    state.library.forEach((item) => {
        const icon = typeof item.emoji === 'string' ? item.emoji : splitLabel(item.name).icon;
        const text = typeof item.name === 'string' ? item.name : splitLabel(item.name).text;
        const tier = typeof item.tier === 'number' ? item.tier : 0;
        const card = document.createElement('div');
        card.className =
            'element-card bg-slate-800 p-3 rounded-xl border border-slate-700 flex flex-col items-center justify-center hover:border-blue-500 hover:bg-slate-700 transition shadow-lg';
        card.draggable = true;

        const iconWrap = document.createElement('div');
        iconWrap.className = 'mb-1 flex items-center justify-center h-10 w-10 shrink-0';
        const src = iconSrcForItem(item);
        if (src) {
            const img = document.createElement('img');
            img.src = src;
            img.alt = '';
            img.className = 'library-item-icon-img';
            img.decoding = 'async';
            iconWrap.appendChild(img);
        } else {
            iconWrap.classList.add('text-3xl', 'leading-none');
            iconWrap.textContent = icon;
        }

        const nameEl = document.createElement('span');
        nameEl.className = 'text-xs font-medium text-slate-300 text-center';
        nameEl.textContent = text;
        const nameColor = normalizeItemNameColor(item.nameColor);
        if (nameColor) {
            nameEl.style.color = nameColor;
        }
        const tierEl = document.createElement('span');
        tierEl.className = 'text-[9px] text-slate-500 mt-1 tabular-nums';
        tierEl.textContent = `T${tier}`;
        card.appendChild(iconWrap);
        card.appendChild(nameEl);
        card.appendChild(tierEl);

        card.addEventListener('dragstart', (e) => {
            e.dataTransfer.setData('elementId', item.id);
        });
        card.addEventListener(
            'touchstart',
            (e) => {
                handleTouchStartFromLibrary(e, item);
            },
            { passive: false }
        );

        libraryEl.appendChild(card);
    });
    renderPlayerInventory();
}

function factoryPlacementKey(col, row) {
    return `${col},${row}`;
}

/**
 * After expanding the grid by a ring, move every keyed cell by (dc, dr).
 * @param {number} dc
 * @param {number} dr
 */
function factoryShiftKeyedMaps(dc, dr) {
    if (dc === 0 && dr === 0) return;
    /** @param {Record<string, unknown>} rec */
    function shift(rec) {
        const out = {};
        for (const [k, v] of Object.entries(rec)) {
            const parts = k.split(',');
            const c = Number(parts[0]);
            const r = Number(parts[1]);
            if (!Number.isFinite(c) || !Number.isFinite(r)) continue;
            out[`${c + dc},${r + dr}`] = v;
        }
        return out;
    }
    state.factory.placements = /** @type {typeof state.factory.placements} */ (shift(state.factory.placements));
    state.factory.transporterDirs = /** @type {typeof state.factory.transporterDirs} */ (shift(state.factory.transporterDirs));
    state.factory.sorterDirs = /** @type {typeof state.factory.sorterDirs} */ (shift(state.factory.sorterDirs));
    state.factory.sorterItemFilters = /** @type {typeof state.factory.sorterItemFilters} */ (
        shift(state.factory.sorterItemFilters)
    );
    state.factory.bridgeDirs = /** @type {typeof state.factory.bridgeDirs} */ (shift(state.factory.bridgeDirs));
    state.factory.combinerDirs = /** @type {typeof state.factory.combinerDirs} */ (shift(state.factory.combinerDirs));
    state.factory.combinerDiscovery = /** @type {typeof state.factory.combinerDiscovery} */ (shift(state.factory.combinerDiscovery));
    {
        const slides = state.factory.itemSlides;
        const out = /** @type {typeof state.factory.itemSlides} */ ({});
        for (const [toKey, s] of Object.entries(slides)) {
            if (!s || typeof s.fromKey !== 'string') continue;
            const tp = toKey.split(',');
            const tc = Number(tp[0]);
            const tr = Number(tp[1]);
            const fp = s.fromKey.split(',');
            const fc = Number(fp[0]);
            const fr = Number(fp[1]);
            if (!Number.isFinite(tc) || !Number.isFinite(tr) || !Number.isFinite(fc) || !Number.isFinite(fr)) continue;
            out[`${tc + dc},${tr + dr}`] = {
                fromKey: `${fc + dc},${fr + dr}`,
                startT: s.startT,
                durMs: s.durMs
            };
        }
        state.factory.itemSlides = out;
    }
    state.factory.cellResources = /** @type {typeof state.factory.cellResources} */ (shift(state.factory.cellResources));
    state.factory.gatheringPoints = /** @type {typeof state.factory.gatheringPoints} */ (shift(state.factory.gatheringPoints));
    state.factory.cellItems = /** @type {typeof state.factory.cellItems} */ (shift(state.factory.cellItems));
    state.factory.cellRejectFlashUntil = /** @type {typeof state.factory.cellRejectFlashUntil} */ (
        shift(state.factory.cellRejectFlashUntil)
    );

    const fk = state.factory.factoryDiscoveryCombinerKey;
    if (fk) {
        const p = fk.split(',');
        const c = Number(p[0]);
        const r = Number(p[1]);
        if (Number.isFinite(c) && Number.isFinite(r)) {
            state.factory.factoryDiscoveryCombinerKey = `${c + dc},${r + dr}`;
        }
    }
}

function factoryGridCols() {
    const lv = Math.max(0, Math.min(MAX_FACTORY_SIZE_LEVEL, state.factory.sizeUpgradeLevel | 0));
    return FACTORY_GRID_BASE + 2 * lv;
}

function factoryGridRows() {
    return factoryGridCols();
}

/** @param {number} col @param {number} row */
function factoryCellOnGrid(col, row) {
    const n = factoryGridCols();
    return Number.isFinite(col) && Number.isFinite(row) && col >= 0 && row >= 0 && col < n && row < n;
}

/** Base materials allowed for gathering hub placement. */
const FACTORY_GATHERING_MATERIAL_IDS = ['wood', 'stone', 'flint', 'plants'];

function factoryLoopIntervalMs() {
    const n = Number(state.factory.loopMs);
    const ms = Number.isFinite(n) && n > 0 ? n : FACTORY_LOOP_MS_DEFAULT;
    return Math.max(MIN_FACTORY_LOOP_MS, Math.round(ms));
}

/** @returns {boolean} */
function factoryCanSpeedUpgrade() {
    const cur = factoryLoopIntervalMs();
    const next = Math.max(MIN_FACTORY_LOOP_MS, Math.round(cur * 0.9));
    return next < cur;
}

/**
 * Material on a cell from the four corner sources (NW wood, NE stone, SW flint, SE plants).
 * A cell counts if it is that corner or one step away orthogonally (Manhattan distance 1); no diagonals-only tiles.
 * If a cell is in range of two sources (small grids), pick wood, stone, flint, plants (fixed priority).
 */
function factoryMaterialFromCornerSources(col, row) {
    const center2Col = factoryGridCols() - 1;
    const center2Row = factoryGridRows() - 1;
    const span2 = factoryGridCols() - 1;
    const col2 = col * 2;
    const row2 = row * 2;
    const corners = [
        [center2Col - span2, center2Row - span2, 'wood'],
        [center2Col + span2, center2Row - span2, 'stone'],
        [center2Col - span2, center2Row + span2, 'flint'],
        [center2Col + span2, center2Row + span2, 'plants']
    ];
    const found = [];
    for (const [cc2, cr2, id] of corners) {
        const d2 = Math.abs(col2 - cc2) + Math.abs(row2 - cr2);
        if (d2 === 0 || d2 === 2) found.push(id);
    }
    if (found.length === 0) return null;
    const uniq = [...new Set(found)];
    if (uniq.length === 1) return uniq[0];
    const order = { wood: 0, stone: 1, flint: 2, plants: 3 };
    return uniq.sort((a, b) => order[a] - order[b])[0];
}

function factoryCellResourceId(col, row) {
    const key = factoryPlacementKey(col, row);
    const gp = state.factory.gatheringPoints && typeof state.factory.gatheringPoints === 'object' ? state.factory.gatheringPoints : {};
    const hubHere = gp[key];
    if (hubHere && typeof hubHere === 'string' && hubHere.trim()) {
        return null;
    }
    const ring = [
        [-1, -1],
        [-1, 0],
        [-1, 1],
        [0, -1],
        [0, 1],
        [1, -1],
        [1, 0],
        [1, 1]
    ];
    for (const [dc, dr] of ring) {
        const nc = col + dc;
        const nr = row + dr;
        if (!factoryCellOnGrid(nc, nr)) continue;
        const nk = factoryPlacementKey(nc, nr);
        const m = gp[nk];
        if (m && typeof m === 'string' && m.trim()) return m.trim();
    }
    const stored = state.factory.cellResources[key];
    if (stored && typeof stored === 'string' && stored.trim()) return stored.trim();
    return factoryMaterialFromCornerSources(col, row);
}

function factoryTransporterDir(key) {
    const d = state.factory.transporterDirs[key];
    return typeof d === 'number' && d >= 0 && d <= 3 ? d : 0;
}

function factorySorterDir(key) {
    const d = state.factory.sorterDirs[key];
    return typeof d === 'number' && d >= 0 && d <= 3 ? d : 0;
}

function factoryBridgeDir(key) {
    const d = state.factory.bridgeDirs[key];
    return typeof d === 'number' && d >= 0 && d <= 3 ? d : 0;
}

function factoryCombinerDir(key) {
    const d = state.factory.combinerDirs[key];
    return typeof d === 'number' && d >= 0 && d <= 3 ? d : 0;
}

/**
 * @param {string} toKey
 * @param {string} fromKey
 * @param {number} durMs
 * @param {number} startT performance.now()
 */
function factoryRecordItemSlide(toKey, fromKey, durMs, startT) {
    state.factory.itemSlides[toKey] = { fromKey, startT, durMs };
}

/** @param {string} key */
function factoryClearSlidesTouchingKey(key) {
    delete state.factory.itemSlides[key];
    for (const tk of Object.keys(state.factory.itemSlides)) {
        if (state.factory.itemSlides[tk].fromKey === key) delete state.factory.itemSlides[tk];
    }
}

/**
 * @param {string} key
 * @param {number} now
 * @returns {number | null} 0..1 while sliding, null if no slide
 */
function factoryItemSlideProgress(key, now) {
    const s = state.factory.itemSlides[key];
    if (!s) return null;
    return Math.min(1, Math.max(0, (now - s.startT) / s.durMs));
}

/** @param {string} key @param {{ col: number, row: number }} out */
function factoryKeyToColRow(key, out) {
    const p = key.split(',');
    out.col = Number(p[0]);
    out.row = Number(p[1]);
}

/**
 * @param {number} col
 * @param {number} row
 * @param {{ cellPx: number, gap: number, originX: number, originY: number }} L
 */
function factoryCellCenterCss(col, row, L) {
    const x0 = L.originX + col * (L.cellPx + L.gap);
    const y0 = L.originY + row * (L.cellPx + L.gap);
    return { x: x0 + L.cellPx / 2, y: y0 + L.cellPx / 2 };
}

function factoryEaseInOutQuad(t) {
    return t;
}

/**
 * @param {CanvasRenderingContext2D} ctx
 * @param {{ cellPx: number, gap: number, originX: number, originY: number }} L
 * @param {number} sc
 * @param {number} now
 */
function factoryDrawItemSlides(ctx, L, sc, now) {
    const slides = state.factory.itemSlides;
    const keys = Object.keys(slides);
    if (keys.length === 0) return;

    const cr = { col: 0, row: 0 };
    const fr = { col: 0, row: 0 };

    for (const toKey of keys) {
        const s = slides[toKey];
        if (!s) continue;
        const itemId = state.factory.cellItems[toKey];
        if (!itemId) {
            delete slides[toKey];
            continue;
        }
        const rawP = (now - s.startT) / s.durMs;
        if (rawP >= 1) {
            delete slides[toKey];
            continue;
        }
        const p = factoryEaseInOutQuad(Math.min(1, Math.max(0, rawP)));
        factoryKeyToColRow(toKey, cr);
        factoryKeyToColRow(s.fromKey, fr);
        if (!Number.isFinite(cr.col) || !Number.isFinite(fr.col)) {
            delete slides[toKey];
            continue;
        }
        const fromPt = factoryCellCenterCss(fr.col, fr.row, L);
        const toPt = factoryCellCenterCss(cr.col, cr.row, L);
        const x = fromPt.x + (toPt.x - fromPt.x) * p;
        const y = fromPt.y + (toPt.y - fromPt.y) * p;
        ctx.save();
        ctx.shadowColor = 'rgba(0,0,0,0.55)';
        ctx.shadowBlur = 5 * sc;
        ctx.shadowOffsetY = 1;
        const iconImg = factoryGetLoadedIconImage(itemId);
        if (iconImg) {
            const sz = Math.max(8, 19 * sc);
            ctx.drawImage(iconImg, x - sz / 2, y - sz / 2, sz, sz);
        } else {
            const icon = emojiForItemId(itemId);
            if (!icon) {
                ctx.restore();
                continue;
            }
            const fsz = Math.max(6, 20 * sc);
            ctx.font = `${fsz}px system-ui, "Segoe UI Emoji", "Apple Color Emoji", sans-serif`;
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillStyle = '#f8fafc';
            ctx.fillText(icon, x, y);
        }
        ctx.restore();
    }
}

/** @returns {{ id: string, emoji: string, name: string }} */
function factoryLibraryStubForId(id) {
    const lib = state.library.find((e) => e.id === id);
    if (lib) {
        const emoji = typeof lib.emoji === 'string' ? lib.emoji : splitLabel(lib.name).icon;
        const name = typeof lib.name === 'string' ? splitLabel(lib.name).text : String(lib.name);
        return { id: lib.id, emoji, name };
    }
    return { id, emoji: '·', name: id };
}

function openFactoryCombinerDiscovery(combinerKey, aId, bId, comboKey) {
    void checkCombineRemote(aId, bId)
        .then((out) => {
            if (out.rejected) {
                state.factory.cellRejectFlashUntil[combinerKey] = performance.now() + 1000;
                delete state.factory.combinerDiscovery[combinerKey];
                renderFactoryGrid();
                notifyFactoryStateMutated();
                return;
            }
            if (out.exists && out.item) {
                const known = out.item;
                state.recipes[comboKey] = { id: known.id, emoji: known.emoji, name: known.name };
                const li = state.library.findIndex((e) => e.id === known.id);
                const nextRow = { id: known.id, emoji: known.emoji, name: known.name, tier: 0 };
                const knownNameColor = normalizeItemNameColor(known.nameColor);
                if (knownNameColor) nextRow.nameColor = knownNameColor;
                if (known.iconPath && known.iconPath.trim()) nextRow.iconPath = known.iconPath.trim();
                if (li >= 0) state.library[li] = { ...state.library[li], ...nextRow };
                else state.library.push(nextRow);
                if (cachedBaseItemsMap) {
                    cachedBaseItemsMap[known.id] = {
                        ...(cachedBaseItemsMap[known.id] || {}),
                        id: known.id,
                        emoji: known.emoji,
                        name: known.name,
                        a: known.a || aId,
                        b: known.b || bId,
                        nameColor: knownNameColor || undefined,
                        iconPath: known.iconPath || undefined,
                        discoveredAt: known.discoveredAt || undefined
                    };
                }
                recomputeAllTiers();
                renderLibrary();
                delete state.factory.combinerDiscovery[combinerKey];
                renderFactoryGrid();
                notifyFactoryStateMutated();
                return;
            }
            const a = factoryLibraryStubForId(aId);
            const b = factoryLibraryStubForId(bId);
            if (isDeferredDiscoveryCombo(comboKey)) {
                factoryDeferredFlashUntil[combinerKey] = performance.now() + 1000;
                renderFactoryGrid();
                setDeferredDiscoveryPrompt({
                    a,
                    b,
                    key: comboKey,
                    resultId: '',
                    resultPlaced: false,
                    factoryCombKey: combinerKey,
                    name: '',
                    emoji: '✨'
                });
                return;
            }
            openDiscoveryModal(
                {
                    a,
                    b,
                    key: comboKey,
                    resultId: '',
                    resultPlaced: false,
                    factoryCombKey: combinerKey,
                    name: '',
                    emoji: '✨'
                },
                undefined
            );
        })
        .catch((err) => {
            console.error(err);
            state.factory.cellRejectFlashUntil[combinerKey] = performance.now() + 1000;
            delete state.factory.combinerDiscovery[combinerKey];
            renderFactoryGrid();
            notifyFactoryStateMutated();
        });
}

/**
 * Hit-test and draw layout in CSS pixels (relative to factory canvas).
 * `originX/Y` is the world-space top-left anchor for cell [0,0] (can be far off-screen).
 * @type {{
 *   cellPx: number,
 *   gap: number,
 *   originX: number,
 *   originY: number,
 *   stride: number,
 *   cssW: number,
 *   cssH: number,
 *   minCol: number,
 *   maxCol: number,
 *   minRow: number,
 *   maxRow: number
 * } | null}
 */
let factoryViewLayout = null;

/** @type {number | null} */
let factoryRenderRafId = null;

function factoryComputeViewLayout(cssW, cssH) {
    const gc = Math.max(2, factoryGridCols());
    const gap = Math.max(0, Math.min(2, Math.round(cssW / 220)));
    const pad = 8;
    const availW = Math.max(40, cssW - 2 * pad);
    const availH = Math.max(40, cssH - 2 * pad);
    const legacyCellByW = (availW - (gc - 1) * gap) / gc;
    const legacyCellByH = (availH - (gc - 1) * gap) / gc;
    const baseCell = Math.max(16, Math.floor(Math.min(legacyCellByW, legacyCellByH)));
    const zoom = Math.max(0.35, Math.min(3, Number(state.factory.cameraZoom) || 1));
    const cellPx = Math.max(8, baseCell * zoom);
    const stride = cellPx + gap;

    const camX = Number(state.factory.cameraX);
    const camY = Number(state.factory.cameraY);
    const safeCamX = Number.isFinite(camX) ? camX : (factoryGridCols() - 1) / 2;
    const safeCamY = Number.isFinite(camY) ? camY : (factoryGridRows() - 1) / 2;

    const originX = cssW * 0.5 - safeCamX * stride - cellPx / 2;
    const originY = cssH * 0.5 - safeCamY * stride - cellPx / 2;

    const minCol = Math.floor((0 - originX) / stride) - 1;
    const maxCol = Math.ceil((cssW - originX) / stride) + 1;
    const minRow = Math.floor((0 - originY) / stride) - 1;
    const maxRow = Math.ceil((cssH - originY) / stride) + 1;
    return { cellPx, gap, originX, originY, stride, cssW, cssH, minCol, maxCol, minRow, maxRow };
}

function factoryResizeMainCanvas() {
    if (!factoryCanvasEl || !factoryCanvasWrapEl) return;
    const rect = factoryCanvasWrapEl.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    const cssW = rect.width;
    const cssH = rect.height;
    if (cssW < 4 || cssH < 4) return;
    const bw = Math.max(1, Math.round(cssW * dpr));
    const bh = Math.max(1, Math.round(cssH * dpr));
    if (factoryCanvasEl.width !== bw || factoryCanvasEl.height !== bh) {
        factoryCanvasEl.width = bw;
        factoryCanvasEl.height = bh;
    }
}

/**
 * @param {number} clientX
 * @param {number} clientY
 * @returns {{ col: number, row: number } | null}
 */
function factoryPixelToCell(clientX, clientY) {
    const L = factoryViewLayout;
    if (!factoryCanvasEl || !L) return null;
    const rect = factoryCanvasEl.getBoundingClientRect();
    const x = clientX - rect.left;
    const y = clientY - rect.top;
    const rx = x - L.originX;
    const ry = y - L.originY;
    const col = Math.floor(rx / L.stride);
    const row = Math.floor(ry / L.stride);
    if (!Number.isFinite(col) || !Number.isFinite(row)) return null;
    const lx = rx - col * L.stride;
    const ly = ry - row * L.stride;
    if (lx > L.cellPx || ly > L.cellPx) return null;
    return { col, row };
}

/** @param {{ col: number, row: number }} a @param {{ col: number, row: number }} b */
function factoryCellsOrthogonallyAdjacent(a, b) {
    const d = Math.abs(a.col - b.col) + Math.abs(a.row - b.row);
    return d === 1;
}

/**
 * Orthogonal-only path from start to end (L-shaped). Longer axis first for predictable bends.
 * @returns {{ col: number, row: number }[]}
 */
function factoryManhattanPath(c0, r0, c1, r1) {
    const path = [{ col: c0, row: r0 }];
    let c = c0;
    let r = r0;
    const dx = c1 - c0;
    const dy = r1 - r0;
    const horizFirst = Math.abs(dx) >= Math.abs(dy);
    if (horizFirst) {
        while (c !== c1) {
            c += dx > 0 ? 1 : dx < 0 ? -1 : 0;
            path.push({ col: c, row: r });
        }
        while (r !== r1) {
            r += dy > 0 ? 1 : dy < 0 ? -1 : 0;
            path.push({ col: c, row: r });
        }
    } else {
        while (r !== r1) {
            r += dy > 0 ? 1 : dy < 0 ? -1 : 0;
            path.push({ col: c, row: r });
        }
        while (c !== c1) {
            c += dx > 0 ? 1 : dx < 0 ? -1 : 0;
            path.push({ col: c, row: r });
        }
    }
    return path;
}

/** Flow dir 0 up, 1 right, 2 down, 3 left — chevron / sim output. */
function factoryTransporterDirFromTo(from, to) {
    const dc = to.col - from.col;
    const dr = to.row - from.row;
    if (dc === 1 && dr === 0) return 1;
    if (dc === -1 && dr === 0) return 3;
    if (dc === 0 && dr === 1) return 2;
    if (dc === 0 && dr === -1) return 0;
    return 1;
}

/**
 * Keep prefix of path while cells are empty or already transporters; stop before other buildings.
 * @param {{ col: number, row: number }[]} rawPath
 */
function factoryFilterBeltPath(rawPath) {
    const out = [];
    const gp = state.factory.gatheringPoints && typeof state.factory.gatheringPoints === 'object' ? state.factory.gatheringPoints : {};
    for (const cell of rawPath) {
        const k = factoryPlacementKey(cell.col, cell.row);
        if (gp[k]) break;
        const p = state.factory.placements[k];
        if (!p || p === 'transporter') out.push(cell);
        else break;
    }
    return out;
}

/**
 * @param {{ col: number, row: number }[]} filtered
 * @param {{ col: number, row: number }[]} rawPath full manhattan path (same start)
 */
function factoryDirsAlongFilteredPath(filtered, rawPath) {
    const n = filtered.length;
    if (n === 0) return [];
    if (n === 1) {
        let idx = -1;
        for (let i = 0; i < rawPath.length; i++) {
            if (rawPath[i].col === filtered[0].col && rawPath[i].row === filtered[0].row) {
                idx = i;
                break;
            }
        }
        const nxt = idx >= 0 && idx < rawPath.length - 1 ? rawPath[idx + 1] : null;
        if (nxt && factoryCellsOrthogonallyAdjacent(filtered[0], nxt)) {
            return [factoryTransporterDirFromTo(filtered[0], nxt)];
        }
        return [1];
    }
    const dirs = [];
    for (let i = 0; i < n - 1; i++) {
        dirs.push(factoryTransporterDirFromTo(filtered[i], filtered[i + 1]));
    }
    dirs.push(factoryTransporterDirFromTo(filtered[n - 2], filtered[n - 1]));
    return dirs;
}

function factoryApplyBeltPath(filtered, dirs) {
    for (let i = 0; i < filtered.length; i++) {
        const { col, row } = filtered[i];
        const key = factoryPlacementKey(col, row);
        delete state.factory.combinerDiscovery[key];
        factoryClearSlidesTouchingKey(key);
        state.factory.placements[key] = 'transporter';
        state.factory.transporterDirs[key] = dirs[i];
        delete state.factory.combinerDirs[key];
    }
    renderFactoryGrid();
    notifyFactoryStateMutated();
}

/**
 * @param {CanvasRenderingContext2D} ctx
 * @param {{ cellPx: number, gap: number, originX: number, originY: number }} L
 * @param {number} sc
 */
function factoryDrawBeltDragPreview(ctx, L, sc) {
    const cells = state.factory.beltDragPreview;
    if (!cells || cells.length === 0) return;
    const stride = L.cellPx + L.gap;
    ctx.save();
    ctx.strokeStyle = 'rgba(163, 230, 53, 0.75)';
    ctx.fillStyle = 'rgba(74, 222, 128, 0.12)';
    ctx.setLineDash([4 * sc, 3 * sc]);
    ctx.lineWidth = Math.max(1, 1.5 * sc);
    for (const { col, row } of cells) {
        const x0 = L.originX + col * stride;
        const y0 = L.originY + row * stride;
        ctx.beginPath();
        ctx.rect(x0 + 0.5, y0 + 0.5, L.cellPx - 1, L.cellPx - 1);
        ctx.fill();
        ctx.stroke();
    }
    ctx.setLineDash([]);
    ctx.restore();
}

/** Transporter line: pointerdown = first cell, pointerup = last cell (same cell = normal click). */
/** @type {number | null} */
let factoryBeltAnchorPointerId = null;
let factoryBeltAnchorCol = 0;
let factoryBeltAnchorRow = 0;
let factorySuppressNextFactoryCanvasClick = false;
/** @type {null | { pointerId: number, startX: number, startY: number, startCamX: number, startCamY: number, moved: boolean }} */
let factoryCameraPan = null;

function factoryClampCameraZoom(z) {
    return Math.max(0.35, Math.min(3, Number(z) || 1));
}

/**
 * Keep pointed world position stable while zooming.
 * @param {number} clientX
 * @param {number} clientY
 * @param {number} nextZoom
 */
function factoryZoomAtClientPoint(clientX, clientY, nextZoom) {
    if (!factoryCanvasEl || !factoryViewLayout) return;
    const rect = factoryCanvasEl.getBoundingClientRect();
    const x = clientX - rect.left;
    const y = clientY - rect.top;
    const L = factoryViewLayout;
    const halfCellInStride = L.cellPx / (2 * L.stride);
    const worldX = ((x - L.originX) / L.stride) - halfCellInStride;
    const worldY = ((y - L.originY) / L.stride) - halfCellInStride;
    state.factory.cameraZoom = factoryClampCameraZoom(nextZoom);
    const after = factoryComputeViewLayout(rect.width, rect.height);
    state.factory.cameraX = worldX - ((x - rect.width * 0.5) / after.stride);
    state.factory.cameraY = worldY - ((y - rect.height * 0.5) / after.stride);
}

function factoryClearBeltLineState() {
    factoryBeltAnchorPointerId = null;
    state.factory.beltDragPreview = null;
}

/**
 * @param {CanvasRenderingContext2D} ctx
 * @param {number} col
 * @param {number} row
 * @param {number} w
 * @param {number} h
 * @param {number} sc scale from cell size
 */
function factoryDrawCellContent(ctx, col, row, w, h, sc) {
    const key = factoryPlacementKey(col, row);
    const placement = state.factory.placements[key];
    const gp = state.factory.gatheringPoints && typeof state.factory.gatheringPoints === 'object' ? state.factory.gatheringPoints : {};
    const gatherHubId =
        gp[key] && typeof gp[key] === 'string' && gp[key].trim() ? gp[key].trim() : '';
    const resId = factoryCellResourceId(col, row);
    const resIcon = resId ? emojiForItemId(resId) : '';
    const resImg = resId ? factoryGetLoadedIconImage(resId) : null;
    const hasRes = Boolean(resId) || Boolean(gatherHubId);
    const carryId = state.factory.cellItems[key];
    const carryIcon = carryId ? emojiForItemId(carryId) : '';
    const carryImg = carryId ? factoryGetLoadedIconImage(carryId) : null;
    const slideP = factoryItemSlideProgress(key, performance.now());
    const hideCarryForSlide = slideP !== null && slideP < 1;

    const midX = w / 2;
    const midY = h / 2;
    const fs = (n) => `${Math.max(6, n * sc)}px system-ui, "Segoe UI Emoji", "Apple Color Emoji", sans-serif`;

    ctx.save();

    const light = (col + row) % 2 === 0;
    ctx.fillStyle = light ? '#e6e2d6' : '#d9d4c6';
    ctx.fillRect(0, 0, w, h);
    if (hasRes) {
        ctx.fillStyle = gatherHubId ? 'rgba(22, 101, 52, 0.22)' : 'rgba(52, 140, 72, 0.16)';
        ctx.fillRect(0, 0, w, h);
    }
    ctx.strokeStyle = 'rgba(0, 0, 0, 0.06)';
    ctx.lineWidth = 1;
    ctx.strokeRect(0.5, 0.5, w - 1, h - 1);

    if (!placement && gatherHubId) {
        const gIcon = emojiForItemId(gatherHubId);
        const gImg = factoryGetLoadedIconImage(gatherHubId);
        ctx.shadowColor = 'rgba(0,0,0,0.28)';
        ctx.shadowBlur = 5 * sc;
        ctx.shadowOffsetY = 2;
        if (gImg) {
            const sz = Math.min(w, h) * 0.88;
            ctx.drawImage(gImg, midX - sz / 2, midY - sz / 2, sz, sz);
        } else if (gIcon) {
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.font = fs(34);
            ctx.fillStyle = '#14532d';
            ctx.fillText(gIcon, midX, midY);
        }
        ctx.shadowBlur = 0;
    } else if (!placement && hasRes && (resImg || resIcon)) {
        ctx.shadowColor = 'rgba(0,0,0,0.2)';
        ctx.shadowBlur = 3 * sc;
        ctx.shadowOffsetY = 1;
        if (resImg) {
            const sz = Math.min(w, h) * 0.62;
            ctx.drawImage(resImg, midX - sz / 2, midY - sz / 2, sz, sz);
        } else {
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.font = fs(22);
            ctx.fillStyle = '#1c1917';
            ctx.fillText(resIcon, midX, midY);
        }
        ctx.shadowBlur = 0;
    }

    if (placement === 'transporter' || placement === 'bridge') {
        const beltDir = placement === 'bridge' ? factoryBridgeDir(key) : factoryTransporterDir(key);
        const angle = (beltDir * Math.PI) / 2;
        const accentColor = placement === 'bridge' ? '#0284c7' : '#ca8a04';
        const arrowColor = placement === 'bridge' ? '#67e8f9' : '#fde047';
        ctx.save();
        ctx.globalAlpha = 0.5;
        ctx.translate(midX, midY);
        ctx.rotate(angle);
        const rw = w * 0.42;
        const rh = h * 0.38;
        ctx.fillStyle = '#1c1917';
        ctx.fillRect(-rw, -rh, rw * 2, rh * 2);
        ctx.strokeStyle = '#0f172a';
        ctx.lineWidth = Math.max(1, sc);
        ctx.strokeRect(-rw, -rh, rw * 2, rh * 2);
        ctx.fillStyle = accentColor;
        ctx.fillRect(-rw + 2 * sc, -rh * 0.22, rw * 2 - 4 * sc, rh * 0.44);
        const rollerY = [-rh * 0.55, 0, rh * 0.55];
        for (const ry of rollerY) {
            ctx.beginPath();
            ctx.arc(0, ry, 2.2 * sc, 0, Math.PI * 2);
            ctx.fillStyle = '#44403c';
            ctx.fill();
            ctx.strokeStyle = '#57534e';
            ctx.lineWidth = 0.5;
            ctx.stroke();
        }
        ctx.fillStyle = arrowColor;
        ctx.beginPath();
        ctx.moveTo(0, -rh * 0.85);
        ctx.lineTo(3.5 * sc, -rh * 0.35);
        ctx.lineTo(-3.5 * sc, -rh * 0.35);
        ctx.closePath();
        ctx.fill();
        ctx.restore();

        // Tick-state occupancy indicator (independent from smooth slide interpolation).
        const busyBit = carryId ? 1 : 0;
        const label = String(busyBit);
        ctx.save();
        ctx.textAlign = 'right';
        ctx.textBaseline = 'top';
        ctx.font = fs(9);
        ctx.fillStyle = busyBit ? '#fca5a5' : '#86efac';
        ctx.shadowColor = 'rgba(2, 6, 23, 0.85)';
        ctx.shadowBlur = 2 * sc;
        ctx.fillText(label, w - Math.max(2, 2 * sc), Math.max(1, 1 * sc));
        ctx.restore();

        // Conflict input cursor arrow (0 right, 1 up, 2 left, 3 down) if defined.
        // Bridge reuses transporter look, but this cursor applies to transporter conflict routing only.
        if (placement === 'transporter') {
            const ttCursor =
                state.factory &&
                state.factory._ttInputCursor &&
                typeof state.factory._ttInputCursor === 'object' &&
                Number.isFinite(Number(state.factory._ttInputCursor[key]))
                    ? ((Number(state.factory._ttInputCursor[key]) | 0) + 4) % 4
                    : null;
            if (ttCursor !== null) {
                const angleByInputDir = {
                    0: 0,
                    1: -Math.PI / 2,
                    2: Math.PI,
                    3: Math.PI / 2
                };
                ctx.save();
                ctx.translate(midX, Math.max(5 * sc, h * 0.18));
                ctx.rotate(angleByInputDir[ttCursor]);
                ctx.fillStyle = '#7dd3fc';
                ctx.strokeStyle = '#0f172a';
                ctx.lineWidth = Math.max(0.8, sc * 0.9);
                ctx.beginPath();
                ctx.moveTo(5.4 * sc, 0);
                ctx.lineTo(-2.6 * sc, -3.4 * sc);
                ctx.lineTo(-2.6 * sc, 3.4 * sc);
                ctx.closePath();
                ctx.fill();
                ctx.stroke();
                ctx.restore();
            }
        }
    } else if (placement === 'sorter') {
        const sDir = factorySorterDir(key);
        const angle = (sDir * Math.PI) / 2;
        const bodyW = w * 0.66;
        const bodyH = h * 0.44;
        ctx.save();
        ctx.translate(midX, midY);
        ctx.fillStyle = '#0f172a';
        ctx.strokeStyle = '#334155';
        ctx.lineWidth = Math.max(1, sc);
        ctx.fillRect(-bodyW / 2, -bodyH / 2, bodyW, bodyH);
        ctx.strokeRect(-bodyW / 2, -bodyH / 2, bodyW, bodyH);
        ctx.rotate(angle);
        ctx.fillStyle = '#38bdf8';
        ctx.beginPath();
        ctx.moveTo(0, -bodyH * 0.78);
        ctx.lineTo(4.2 * sc, -bodyH * 0.22);
        ctx.lineTo(-4.2 * sc, -bodyH * 0.22);
        ctx.closePath();
        ctx.fill();
        ctx.restore();

        const filterId = typeof state.factory.sorterItemFilters[key] === 'string' ? state.factory.sorterItemFilters[key] : '';
        if (filterId) {
            const filterImg = factoryGetLoadedIconImage(filterId);
            const filterEmoji = emojiForItemId(filterId);
            ctx.shadowColor = 'rgba(0,0,0,0.45)';
            ctx.shadowBlur = 3 * sc;
            if (filterImg) {
                const sz = Math.max(7, 14 * sc);
                ctx.drawImage(filterImg, w - sz - Math.max(1, sc), Math.max(1, sc), sz, sz);
            } else if (filterEmoji) {
                ctx.textAlign = 'right';
                ctx.textBaseline = 'top';
                ctx.font = fs(12);
                ctx.fillStyle = '#e2e8f0';
                ctx.fillText(filterEmoji, w - Math.max(1, sc), Math.max(1, sc));
            }
            ctx.shadowBlur = 0;
        } else {
            ctx.textAlign = 'right';
            ctx.textBaseline = 'top';
            ctx.font = fs(10);
            ctx.fillStyle = '#7dd3fc';
            ctx.fillText('?', w - Math.max(2, sc), Math.max(1, sc));
        }
    } else if (placement === 'extractor') {
        const bx = w * 0.12;
        const bw = w * 0.76;
        const bh = h * 0.28;
        const by = h * 0.52;
        ctx.fillStyle = '#b45309';
        ctx.strokeStyle = '#78350f';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.rect(bx, by, bw, bh);
        ctx.fill();
        ctx.stroke();
        ctx.fillStyle = '#44403c';
        ctx.fillRect(bx + bw * 0.08, by - h * 0.22, bw * 0.84, h * 0.2);
        ctx.strokeStyle = '#292524';
        ctx.strokeRect(bx + bw * 0.08, by - h * 0.22, bw * 0.84, h * 0.2);
        ctx.fillStyle = '#1c1917';
        ctx.beginPath();
        ctx.moveTo(midX, by - h * 0.38);
        ctx.lineTo(midX + 5 * sc, by - h * 0.08);
        ctx.lineTo(midX - 5 * sc, by - h * 0.08);
        ctx.closePath();
        ctx.fill();
        ctx.strokeStyle = '#57534e';
        ctx.stroke();
        ctx.fillStyle = '#78716c';
        ctx.fillRect(midX - 2 * sc, by - h * 0.42, 4 * sc, h * 0.12);
    } else if (placement === 'combiner') {
        const cDir = factoryCombinerDir(key);
        const angle = (cDir * Math.PI) / 2;
        const bodyW = w * 0.72;
        const bodyH = h * 0.5;
        ctx.save();
        ctx.translate(midX, midY);
        ctx.rotate(angle);
        ctx.fillStyle = '#5b21b6';
        ctx.strokeStyle = '#4c1d95';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(0, -bodyH * 0.55);
        ctx.lineTo(bodyW * 0.42, bodyH * 0.15);
        ctx.lineTo(bodyW * 0.22, bodyH * 0.48);
        ctx.lineTo(-bodyW * 0.22, bodyH * 0.48);
        ctx.lineTo(-bodyW * 0.42, bodyH * 0.15);
        ctx.closePath();
        ctx.fill();
        ctx.stroke();
        ctx.fillStyle = '#7c3aed';
        ctx.beginPath();
        ctx.arc(0, -bodyH * 0.08, bodyW * 0.2, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = '#c4b5fd';
        ctx.beginPath();
        ctx.moveTo(0, -bodyH * 0.75);
        ctx.lineTo(4 * sc, -bodyH * 0.38);
        ctx.lineTo(-4 * sc, -bodyH * 0.38);
        ctx.closePath();
        ctx.fill();
        ctx.restore();
    } else if (placement === 'storage') {
        const cx = midX;
        const chestW = w * 0.62;
        const chestH = h * 0.42;
        const top = h * 0.22;
        ctx.fillStyle = '#78350f';
        ctx.strokeStyle = '#451a03';
        ctx.lineWidth = 1;
        ctx.beginPath();
        if (typeof ctx.roundRect === 'function') {
            ctx.roundRect(cx - chestW / 2, top + chestH * 0.18, chestW, chestH * 0.78, 3 * sc);
        } else {
            ctx.rect(cx - chestW / 2, top + chestH * 0.18, chestW, chestH * 0.78);
        }
        ctx.fill();
        ctx.stroke();
        ctx.fillStyle = '#92400e';
        ctx.beginPath();
        if (typeof ctx.roundRect === 'function') {
            ctx.roundRect(cx - chestW / 2 * 0.92, top, chestW * 0.92, chestH * 0.35, 2 * sc);
        } else {
            ctx.rect(cx - chestW / 2 * 0.92, top, chestW * 0.92, chestH * 0.35);
        }
        ctx.fill();
        ctx.stroke();
        ctx.fillStyle = '#fbbf24';
        ctx.beginPath();
        ctx.arc(cx, top + chestH * 0.52, 3 * sc, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = '#b45309';
        ctx.lineWidth = 0.75;
        ctx.stroke();
    }

    if (placement && hasRes && (resImg || resIcon)) {
        ctx.shadowColor = 'rgba(0,0,0,0.25)';
        ctx.shadowBlur = 2 * sc;
        if (resImg) {
            const sz = Math.max(8, 11 * sc);
            ctx.drawImage(resImg, w - sz - 1, h - sz - 1, sz, sz);
        } else {
            ctx.textAlign = 'right';
            ctx.textBaseline = 'bottom';
            ctx.font = fs(11);
            ctx.fillStyle = '#292524';
            ctx.fillText(resIcon, w - 2, h - 1);
        }
        ctx.shadowBlur = 0;
    }

    if (state.factory.combinerDiscovery[key]) {
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        const pulse = 0.82 + 0.18 * Math.sin(performance.now() * 0.007);
        ctx.font = fs(26);
        ctx.fillStyle = `rgba(251, 146, 60, ${pulse})`;
        ctx.shadowColor = 'rgba(251, 146, 60, 0.45)';
        ctx.shadowBlur = 10 * sc;
        ctx.fillText('!', midX, midY);
        ctx.shadowBlur = 0;
    } else if ((carryImg || carryIcon) && placement !== 'storage' && !hideCarryForSlide) {
        ctx.shadowColor = 'rgba(0,0,0,0.45)';
        ctx.shadowBlur = 4 * sc;
        ctx.shadowOffsetY = 1;
        if (carryImg) {
            const sz = Math.max(8, 19 * sc);
            ctx.drawImage(carryImg, midX - sz / 2, midY - sz / 2, sz, sz);
        } else {
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.font = fs(20);
            ctx.fillStyle = '#fafaf9';
            ctx.fillText(carryIcon, midX, midY);
        }
        ctx.shadowBlur = 0;
    }

    const rejUntil = state.factory.cellRejectFlashUntil[key];
    if (rejUntil && performance.now() < rejUntil) {
        const pulse = 0.45 + 0.35 * Math.sin(performance.now() * 0.022);
        ctx.save();
        ctx.fillStyle = `rgba(239, 68, 68, ${0.1 + 0.12 * pulse})`;
        ctx.fillRect(0, 0, w, h);
        ctx.strokeStyle = `rgba(220, 38, 38, ${0.55 + 0.35 * pulse})`;
        ctx.lineWidth = Math.max(2, 3.2 * sc);
        ctx.strokeRect(1.5 * sc, 1.5 * sc, w - 3 * sc, h - 3 * sc);
        ctx.strokeStyle = `rgba(254, 202, 202, ${0.35 * pulse})`;
        ctx.lineWidth = Math.max(1, 1.5 * sc);
        ctx.strokeRect(3 * sc, 3 * sc, w - 6 * sc, h - 6 * sc);
        ctx.restore();
    }
    const deferredUntil = factoryDeferredFlashUntil[key];
    if (deferredUntil && performance.now() < deferredUntil) {
        const pulse = 0.45 + 0.35 * Math.sin(performance.now() * 0.022);
        ctx.save();
        ctx.fillStyle = `rgba(251, 191, 36, ${0.1 + 0.12 * pulse})`;
        ctx.fillRect(0, 0, w, h);
        ctx.strokeStyle = `rgba(245, 158, 11, ${0.55 + 0.35 * pulse})`;
        ctx.lineWidth = Math.max(2, 3.2 * sc);
        ctx.strokeRect(1.5 * sc, 1.5 * sc, w - 3 * sc, h - 3 * sc);
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.font = fs(18);
        ctx.fillStyle = `rgba(254, 243, 199, ${0.7 + 0.2 * pulse})`;
        ctx.fillText('?', midX, midY);
        ctx.restore();
    }
    ctx.restore();
}

function factoryDrawFullCanvas() {
    if (!factoryCanvasEl || !factoryCanvasWrapEl) return;
    if (state.activeWorkspace !== 'factory') return;

    factoryResizeMainCanvas();
    const ctx = factoryCanvasEl.getContext('2d');
    if (!ctx) return;

    const rect = factoryCanvasWrapEl.getBoundingClientRect();
    const cssW = rect.width;
    const cssH = rect.height;
    if (cssW < 8 || cssH < 8) return;

    const dpr = window.devicePixelRatio || 1;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    ctx.fillStyle = '#3a362e';
    ctx.fillRect(0, 0, cssW, cssH);
    const cx = cssW * 0.5;
    const cy = cssH * 0.48;
    const vr = Math.max(cssW, cssH) * 0.95;
    const vg = ctx.createRadialGradient(cx, cy, vr * 0.05, cx, cy, vr * 0.55);
    vg.addColorStop(0, 'rgba(90, 85, 72, 0.35)');
    vg.addColorStop(0.55, 'rgba(45, 42, 36, 0)');
    vg.addColorStop(1, 'rgba(12, 10, 8, 0.5)');
    ctx.fillStyle = vg;
    ctx.fillRect(0, 0, cssW, cssH);

    const L = factoryComputeViewLayout(cssW, cssH);
    factoryViewLayout = L;
    const sc = Math.max(0.5, Math.min(1.45, L.cellPx / 52));
    const centerCol = (factoryGridCols() - 1) / 2;
    const centerRow = (factoryGridRows() - 1) / 2;
    const span = (factoryGridCols() - 1) / 2;
    const legacyMinCol = Math.round(centerCol - span);
    const legacyMaxCol = Math.round(centerCol + span);
    const legacyMinRow = Math.round(centerRow - span);
    const legacyMaxRow = Math.round(centerRow + span);
    const legacyGridW = (legacyMaxCol - legacyMinCol + 1) * L.stride - L.gap;
    const legacyGridH = (legacyMaxRow - legacyMinRow + 1) * L.stride - L.gap;
    const legacyX = L.originX + legacyMinCol * L.stride;
    const legacyY = L.originY + legacyMinRow * L.stride;

    const pulseLeft = state.factory.loopPulseUntil - performance.now();
    if (pulseLeft > 0) {
        const a = Math.min(1, pulseLeft / 130) * 0.22;
        ctx.save();
        ctx.shadowColor = `rgba(234, 179, 8, ${a * 0.9})`;
        ctx.shadowBlur = 18;
        ctx.strokeStyle = 'rgba(202, 138, 4, 0.4)';
        ctx.lineWidth = 1.25;
        ctx.strokeRect(legacyX - 1, legacyY - 1, legacyGridW + 2, legacyGridH + 2);
        ctx.restore();
    }

    ctx.strokeStyle = 'rgba(0, 0, 0, 0.35)';
    ctx.lineWidth = 1;
    ctx.strokeRect(legacyX - 0.5, legacyY - 0.5, legacyGridW + 1, legacyGridH + 1);

    for (let row = L.minRow; row <= L.maxRow; row++) {
        for (let col = L.minCol; col <= L.maxCol; col++) {
            const x0 = L.originX + col * L.stride;
            const y0 = L.originY + row * L.stride;
            ctx.save();
            ctx.translate(x0, y0);
            factoryDrawCellContent(ctx, col, row, L.cellPx, L.cellPx, sc);
            ctx.restore();
        }
    }

    factoryDrawBeltDragPreview(ctx, L, sc);

    const now = performance.now();
    factoryDrawItemSlides(ctx, L, sc, now);

    for (const k of Object.keys(state.factory.cellRejectFlashUntil)) {
        if (state.factory.cellRejectFlashUntil[k] <= now) delete state.factory.cellRejectFlashUntil[k];
    }
    for (const k of Object.keys(factoryDeferredFlashUntil)) {
        if (factoryDeferredFlashUntil[k] <= now) delete factoryDeferredFlashUntil[k];
    }
}

function factoryRenderLoop() {
    if (state.activeWorkspace !== 'factory') {
        factoryRenderRafId = null;
        return;
    }
    try {
        factoryDrawFullCanvas();
    } catch (err) {
        console.error('Factory canvas draw error', err);
    }
    factoryRenderRafId = requestAnimationFrame(factoryRenderLoop);
}

function factoryStartRenderLoop() {
    if (!factoryCanvasEl) return;
    if (factoryRenderRafId != null) return;
    factoryRenderRafId = requestAnimationFrame(factoryRenderLoop);
}

function factoryStopRenderLoop() {
    if (factoryRenderRafId != null) {
        cancelAnimationFrame(factoryRenderRafId);
        factoryRenderRafId = null;
    }
    factoryViewLayout = null;
}

if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible' && state.auth.token) {
            void postPlayerPing();
            if (state.activeWorkspace === 'factory') void pullFactoryRuntimeStatus();
        }
        if (document.visibilityState === 'visible' && state.activeWorkspace === 'factory') {
            factoryStartRenderLoop();
        } else if (document.hidden) {
            factoryStopRenderLoop();
        }
    });
}

/**
 * @param {number} col
 * @param {number} row
 * @param {boolean} shiftKey
 */
function factoryHandleCellAction(col, row, shiftKey) {
    const key = factoryPlacementKey(col, row);
    if (shiftKey) {
        delete state.factory.placements[key];
        delete state.factory.transporterDirs[key];
        delete state.factory.sorterDirs[key];
        delete state.factory.sorterItemFilters[key];
        delete state.factory.bridgeDirs[key];
        delete state.factory.combinerDirs[key];
        delete state.factory.combinerDiscovery[key];
        delete state.factory.cellItems[key];
        delete state.factory.gatheringPoints[key];
        factoryClearSlidesTouchingKey(key);
        notifyFactoryStateMutated();
        return;
    }
    const placement = state.factory.placements[key];
    const sel = state.factory.selectedBuilding;
    const placeMat = state.factory.gatheringPlaceMaterialId;
    if (
        placeMat &&
        typeof placeMat === 'string' &&
        FACTORY_GATHERING_MATERIAL_IDS.includes(placeMat) &&
        factoryCellOnGrid(col, row)
    ) {
        delete state.factory.placements[key];
        delete state.factory.transporterDirs[key];
        delete state.factory.sorterDirs[key];
        delete state.factory.sorterItemFilters[key];
        delete state.factory.bridgeDirs[key];
        delete state.factory.combinerDirs[key];
        delete state.factory.combinerDiscovery[key];
        delete state.factory.cellItems[key];
        factoryClearSlidesTouchingKey(key);
        delete state.factory.cellResources[key];
        state.factory.gatheringPoints[key] = placeMat;
        notifyFactoryStateMutated();
        return;
    }

    if (state.factory.combinerDiscovery[key]) {
        const d = state.factory.combinerDiscovery[key];
        openFactoryCombinerDiscovery(key, d.a, d.b, d.comboKey);
        return;
    }

    if (placement === 'transporter' && (!sel || sel === 'transporter')) {
        state.factory.transporterDirs[key] = (factoryTransporterDir(key) + 1) % 4;
        notifyFactoryStateMutated();
        return;
    }

    if (placement === 'sorter' && (!sel || sel === 'sorter')) {
        state.factory.sorterDirs[key] = (factorySorterDir(key) + 1) % 4;
        notifyFactoryStateMutated();
        return;
    }

    if (placement === 'bridge' && (!sel || sel === 'bridge')) {
        state.factory.bridgeDirs[key] = (factoryBridgeDir(key) + 1) % 4;
        notifyFactoryStateMutated();
        return;
    }

    if (placement === 'combiner' && (!sel || sel === 'combiner')) {
        state.factory.combinerDirs[key] = (factoryCombinerDir(key) + 1) % 4;
        notifyFactoryStateMutated();
        return;
    }

    if (!sel) return;
    if (state.factory.gatheringPoints[key]) {
        return;
    }
    if (sel === 'extractor' && !factoryCellResourceId(col, row)) {
        return;
    }
    delete state.factory.combinerDiscovery[key];
    factoryClearSlidesTouchingKey(key);
    state.factory.placements[key] = sel;
    if (sel === 'extractor') {
        delete state.factory.transporterDirs[key];
        delete state.factory.sorterDirs[key];
        delete state.factory.sorterItemFilters[key];
        delete state.factory.bridgeDirs[key];
        delete state.factory.combinerDirs[key];
    } else if (sel === 'transporter') {
        if (state.factory.transporterDirs[key] === undefined) {
            state.factory.transporterDirs[key] = 0;
        }
        delete state.factory.sorterDirs[key];
        delete state.factory.sorterItemFilters[key];
        delete state.factory.bridgeDirs[key];
        delete state.factory.combinerDirs[key];
    } else if (sel === 'sorter') {
        delete state.factory.transporterDirs[key];
        delete state.factory.bridgeDirs[key];
        delete state.factory.combinerDirs[key];
        if (state.factory.sorterDirs[key] === undefined) {
            state.factory.sorterDirs[key] = 0;
        }
    } else if (sel === 'bridge') {
        delete state.factory.transporterDirs[key];
        delete state.factory.sorterDirs[key];
        delete state.factory.sorterItemFilters[key];
        delete state.factory.combinerDirs[key];
        if (state.factory.bridgeDirs[key] === undefined) {
            state.factory.bridgeDirs[key] = 0;
        }
    } else if (sel === 'combiner') {
        delete state.factory.transporterDirs[key];
        delete state.factory.sorterDirs[key];
        delete state.factory.sorterItemFilters[key];
        delete state.factory.bridgeDirs[key];
        if (state.factory.combinerDirs[key] === undefined) {
            state.factory.combinerDirs[key] = 0;
        }
    } else {
        delete state.factory.transporterDirs[key];
        delete state.factory.sorterDirs[key];
        delete state.factory.sorterItemFilters[key];
        delete state.factory.bridgeDirs[key];
        delete state.factory.combinerDirs[key];
    }
    notifyFactoryStateMutated();
}

function updateFactoryGatheringButtons() {
    const mat = state.factory.gatheringPlaceMaterialId;
    document.querySelectorAll('.factory-gathering-btn').forEach((btn) => {
        const id = btn.getAttribute('data-factory-gathering-material');
        const on = id === mat;
        btn.classList.toggle('border-emerald-400', on);
        btn.classList.toggle('bg-emerald-900/40', on);
        btn.classList.toggle('text-emerald-100', on);
        btn.classList.toggle('ring-1', on);
        btn.classList.toggle('ring-emerald-500/50', on);
        btn.classList.toggle('border-slate-600', !on);
        btn.classList.toggle('bg-slate-800', !on);
        btn.classList.toggle('text-slate-200', !on);
    });
}

function updateFactoryBuildButtons() {
    const layout =
        'factory-build-btn w-full flex items-center gap-3 py-3 px-3 rounded-xl border text-left text-sm transition min-h-[3.25rem] ';
    document.querySelectorAll('.factory-build-btn').forEach((btn) => {
        const type = btn.getAttribute('data-factory-building');
        const sel = state.factory.selectedBuilding;
        const on = type === sel;
        btn.className =
            layout +
            (on
                ? 'border-amber-500 bg-amber-900/30 text-amber-100 ring-1 ring-amber-500/50'
                : 'border-slate-600 bg-slate-800 hover:border-amber-500/60 text-slate-200');
    });
    updateFactoryGatheringButtons();
}

function renderFactoryGrid() {
    updateFactoryUpgradeBar();
    factoryStartRenderLoop();
}

function setWorkspace(which) {
    if (which === 'factory' && !state.auth.token) {
        setAuthVisible(true);
        setAuthStatus('Login required for multiplayer factory.');
        return;
    }
    state.activeWorkspace = which;
    const isLab = which === 'lab';
    const floatingUpgrades = document.getElementById('floating-factory-upgrades');
    const floatingClear = document.getElementById('floating-clear-workspace');
    const floatingFactoryClear = document.getElementById('floating-clear-factory');
    if (floatingUpgrades) {
        floatingUpgrades.classList.toggle('hidden', isLab);
    }
    if (floatingClear) {
        floatingClear.classList.toggle('hidden', !isLab);
    }
    if (floatingFactoryClear) {
        floatingFactoryClear.classList.toggle('hidden', isLab);
    }
    if (tabLabBtn && tabFactoryBtn) {
        tabLabBtn.classList.toggle('is-active', isLab);
        tabFactoryBtn.classList.toggle('is-active', !isLab);
    }
    if (panelLabEl && panelFactoryEl) {
        panelLabEl.classList.toggle('hidden', !isLab);
        panelFactoryEl.classList.toggle('hidden', isLab);
    }
    if (sidebarHintLab && sidebarHintFactory) {
        sidebarHintLab.classList.toggle('hidden', !isLab);
        sidebarHintFactory.classList.toggle('hidden', isLab);
    }
    if (workspaceEl && factoryWorkspaceEl) {
        workspaceEl.classList.toggle('hidden', !isLab);
        factoryWorkspaceEl.classList.toggle('hidden', isLab);
    }
    if (!isLab) {
        if (!state.auth.enteringFactory) {
            state.auth.enteringFactory = true;
            pullFactoryStateFromServer()
                .catch((err) => {
                    console.warn('pullFactoryStateFromServer', err);
                })
                .finally(() => {
                    state.auth.enteringFactory = false;
                    // Start run window without overwriting server-side factory state.
                    void startFactoryRunOnServer();
                    renderFactoryGrid();
                    startFactoryLoop();
                    void pullFactoryRuntimeStatus();
                });
        } else {
            renderFactoryGrid();
            startFactoryLoop();
            void pullFactoryRuntimeStatus();
        }
    } else {
        stopFactoryLoop();
        factoryStopRenderLoop();
        factoryClearBeltLineState();
        setUpgradesModalOpen(false);
    }
}

// Workspace Logic
workspaceEl.addEventListener('dragover', (e) => e.preventDefault());

workspaceEl.addEventListener('drop', (e) => {
    e.preventDefault();
    const id = e.dataTransfer.getData('elementId');
    const elementData = state.library.find(el => el.id === id);
    if (elementData) {
        createElementOnCanvas(elementData, e.clientX, e.clientY);
    }
});

function createElementOnCanvas(data, x, y) {
    const rect = workspaceEl.getBoundingClientRect();
    const canvasX = x - rect.left - 40;
    const canvasY = y - rect.top - 40;

    const emoji = typeof data.emoji === 'string' ? data.emoji : splitLabel(data.name).icon;
    const nameText = typeof data.name === 'string' ? data.name : splitLabel(data.name).text;
    const nameColor = normalizeItemNameColor(data.nameColor);

    const instance = {
        uid: Math.random().toString(36).substr(2, 9),
        id: data.id,
        emoji,
        name: nameText,
        nameColor,
        iconPath: typeof data.iconPath === 'string' ? data.iconPath : '',
        x: canvasX,
        y: canvasY
    };

    state.activeElements.push(instance);
    renderCanvas();
    checkCollisions(instance);
}

function renderCanvas() {
    const instruction = document.getElementById('instruction');
    if (instruction) {
        instruction.style.display = state.activeElements.length > 0 ? 'none' : 'flex';
    }

    const existingUids = new Set(state.activeElements.map(e => e.uid));

    Array.from(workspaceEl.querySelectorAll('.canvas-element')).forEach(el => {
        if (!existingUids.has(el.dataset.uid)) el.remove();
    });

    state.activeElements.forEach(item => {
        let el = workspaceEl.querySelector(`[data-uid="${item.uid}"]`);
        if (!el) {
            const icon = typeof item.emoji === 'string' ? item.emoji : splitLabel(item.name).icon;
            const text = typeof item.name === 'string' ? item.name : splitLabel(item.name).text;
            const nameStyle = item.nameColor ? ` style="color:${item.nameColor}"` : '';
            const iconSrc = iconSrcForItem(item);
            const iconMarkup = iconSrc
                ? `<img src="${iconSrc}" alt="" class="w-10 h-10 object-contain pointer-events-none" />`
                : `<span class="text-4xl pointer-events-none">${icon}</span>`;
            el = document.createElement('div');
            el.className = 'canvas-element w-20 h-24 bg-slate-800/80 backdrop-blur-md border border-slate-600 rounded-xl shadow-2xl flex flex-col items-center justify-center cursor-move z-20';
            el.dataset.uid = item.uid;
            el.innerHTML = `
                ${iconMarkup}
                <span class="text-[10px] uppercase font-bold text-slate-400 mt-2 pointer-events-none text-center px-1 leading-tight"${nameStyle}>${text}</span>
            `;

            el.addEventListener('mousedown', (e) => startDragging(e, item, el));
            el.addEventListener('touchstart', (e) => startDragging(e, item, el), { passive: false });

            workspaceEl.appendChild(el);
        }
        el.style.transform = `translate(${item.x}px, ${item.y}px)`;
    });
}

function startDragging(e, item, el) {
    e.preventDefault();
    const startX = e.type.includes('touch') ? e.touches[0].clientX : e.clientX;
    const startY = e.type.includes('touch') ? e.touches[0].clientY : e.clientY;

    const initialX = item.x;
    const initialY = item.y;

    el.style.zIndex = 100;

    const move = (moveEvent) => {
        const currentX = moveEvent.type.includes('touch') ? moveEvent.touches[0].clientX : moveEvent.clientX;
        const currentY = moveEvent.type.includes('touch') ? moveEvent.touches[0].clientY : moveEvent.clientY;

        item.x = initialX + (currentX - startX);
        item.y = initialY + (currentY - startY);
        el.style.transform = `translate(${item.x}px, ${item.y}px)`;
    };

    const stop = () => {
        window.removeEventListener('mousemove', move);
        window.removeEventListener('mouseup', stop);
        window.removeEventListener('touchmove', move);
        window.removeEventListener('touchend', stop);
        el.style.zIndex = 20;
        checkCollisions(item);
    };

    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', stop);
    window.addEventListener('touchmove', move, { passive: false });
    window.addEventListener('touchend', stop);
}

function checkCollisions(movedItem) {
    const threshold = 60;
    const other = state.activeElements.find(el => {
        if (el.uid === movedItem.uid) return false;
        const dx = el.x - movedItem.x;
        const dy = el.y - movedItem.y;
        return Math.sqrt(dx * dx + dy * dy) < threshold;
    });

    if (other) {
        void combineAsync(movedItem, other);
    }
}

async function combineAsync(a, b) {
    const comboKey = [a.id, b.id].sort().join('+');
    const oldA = { ...a };
    const oldB = { ...b };
    let out = null;
    try {
        out = await checkCombineRemote(String(oldA.id || ''), String(oldB.id || ''));
    } catch (err) {
        console.error(err);
        return;
    }
    if (out.rejected) {
        state.activeElements = state.activeElements.filter((el) => el.uid !== a.uid && el.uid !== b.uid);
        state.activeElements.push(oldA, oldB);
        renderCanvas();
        const midX = (a.x + b.x) / 2 + 40;
        const midY = (a.y + b.y) / 2 + 40;
        showPulse(midX, midY, 'bg-red-500');
        return;
    }
    if (out.exists && out.item) {
        const known = out.item;
        state.recipes[comboKey] = { id: known.id, emoji: known.emoji, name: known.name };
        const li = state.library.findIndex((el) => el.id === known.id);
        const nextRow = { id: known.id, emoji: known.emoji, name: known.name, tier: 0 };
        const knownNameColor = normalizeItemNameColor(known.nameColor);
        if (knownNameColor) nextRow.nameColor = knownNameColor;
        if (known.iconPath && known.iconPath.trim()) nextRow.iconPath = known.iconPath.trim();
        if (li >= 0) state.library[li] = { ...state.library[li], ...nextRow };
        else state.library.push(nextRow);
        if (cachedBaseItemsMap) {
            cachedBaseItemsMap[known.id] = {
                ...(cachedBaseItemsMap[known.id] || {}),
                id: known.id,
                emoji: known.emoji,
                name: known.name,
                a: known.a || String(oldA.id || ''),
                b: known.b || String(oldB.id || ''),
                nameColor: knownNameColor || undefined,
                iconPath: known.iconPath || undefined,
                discoveredAt: known.discoveredAt || undefined
            };
        }
        recomputeAllTiers();
        renderLibrary();
        state.activeElements = state.activeElements.filter((el) => el.uid !== a.uid && el.uid !== b.uid);
        const midX = (a.x + b.x) / 2;
        const midY = (a.y + b.y) / 2;
        const resultData = state.library.find((el) => el.id === known.id) || nextRow;
        createElementOnCanvas(resultData, midX + 40, midY + 40);
        showPulse(midX + 40, midY + 40, 'bg-blue-400');
        renderCanvas();
        return;
    }
    state.activeElements = state.activeElements.filter((el) => el.uid !== a.uid && el.uid !== b.uid);
    renderCanvas();
    if (isDeferredDiscoveryCombo(comboKey)) {
        state.activeElements.push(oldA, oldB);
        renderCanvas();
        const midX = (a.x + b.x) / 2 + 40;
        const midY = (a.y + b.y) / 2 + 40;
        showPulse(midX, midY, 'bg-yellow-400');
        const q = document.createElement('div');
        q.className = 'absolute pointer-events-none z-50 text-2xl font-bold text-amber-300';
        q.textContent = '???';
        q.style.left = `${midX}px`;
        q.style.top = `${midY - 36}px`;
        q.style.transform = 'translate(-50%, -50%)';
        q.style.textShadow = '0 0 12px rgba(251,191,36,0.8)';
        workspaceEl.appendChild(q);
        setTimeout(() => q.remove(), 900);
        setDeferredDiscoveryPrompt({
            a: oldA,
            b: oldB,
            key: comboKey,
            resultId: '',
            resultPlaced: false,
            factoryCombKey: '',
            name: '',
            emoji: '✨'
        });
        return;
    }
    openDiscoveryModal(
        {
            a: oldA,
            b: oldB,
            key: comboKey,
            resultId: '',
            resultPlaced: false,
            factoryCombKey: '',
            name: '',
            emoji: '✨'
        },
        undefined
    );
}

/**
 * @param {{ a: unknown, b: unknown, key: string, resultId?: string, resultPlaced?: boolean, factoryCombKey?: string, name?: string, emoji?: string }} pending
 * @param {{ suggestions: { name: string, emoji: string }[], explanation: string, makesenceYes: boolean | null } | undefined} preloadedParsed
 */
function openDiscoveryModal(pending, preloadedParsed) {
    setDeferredDiscoveryPrompt(null);
    state.discoveryIconItemName = '';
    state.pendingCombination = pending;
    state.discoveryNameColor = normalizeItemNameColor(pending && pending.nameColor) || DISCOVERY_NAME_COLOR_CHOICES[0];
    const la = promptPartsFromItem(pending.a);
    const lb = promptPartsFromItem(pending.b);
    const modalRecipe = document.getElementById('modal-recipe-text');
    if (modalRecipe) {
        modalRecipe.innerText = `You combined ${la.text} and ${lb.text} and created something new!`;
    }
    if (discoveryTitleEl) {
        const eA = la.icon || '✨';
        const eB = lb.icon || '';
        discoveryTitleEl.textContent = `${eA}${eB} New Discovery!`;
    }
    state.discoverySelectedName = '';
    if (discoveryNameInputEl) discoveryNameInputEl.value = '';
    if (discoveryEmojiInputEl) discoveryEmojiInputEl.value = '';
    renderDiscoveryNameColorChoices();
    syncDiscoverySelectedNameUi();
    syncDiscoveryImageQueryInput();
    if (saveDiscoveryBtn) {
        saveDiscoveryBtn.disabled = true;
        saveDiscoveryBtn.textContent = 'Confirm';
    }
    state.aiSuggestions = [];
    if (aiWrap) aiWrap.classList.remove('hidden');
    if (aiStatus) aiStatus.textContent = '';
    clearAiFullReplyUi();
    if (aiOutgoingWrap) aiOutgoingWrap.classList.add('hidden');
    if (aiOutgoingEl) aiOutgoingEl.textContent = '';
    if (aiSuggestionsEl) aiSuggestionsEl.innerHTML = '';
    resetDiscoveryAiImagePreview();
    modal.classList.remove('hidden');
    setDiscoveryStep('name');
    if (preloadedParsed) {
        applyDiscoveryAiResult(preloadedParsed);
    } else {
        startAiForCombination(pending.a, pending.b);
    }
}

if (discoveryAiImageBtn) {
    discoveryAiImageBtn.addEventListener('click', () => {
        discoveryIconSearchPage = 0;
        void generateDiscoveryIconPreview(0);
    });
}
if (discoveryOpenCustomIconBtn) {
    discoveryOpenCustomIconBtn.addEventListener('click', () => {
        if (discoveryCustomIconStatus) discoveryCustomIconStatus.textContent = '';
        if (discoveryCustomIconModal) discoveryCustomIconModal.classList.remove('hidden');
    });
}
if (discoveryCustomIconCloseBtn) {
    discoveryCustomIconCloseBtn.addEventListener('click', () => {
        if (discoveryCustomIconModal) discoveryCustomIconModal.classList.add('hidden');
    });
}
if (discoveryCustomIconOkBtn) {
    discoveryCustomIconOkBtn.addEventListener('click', () => {
        const hasCustomIcon = !!String(state.discoveryPreviewUrl || '').trim() || !!String(state.discoveryPreviewDataUrl || '').trim();
        if (!hasCustomIcon) {
            if (discoveryCustomIconStatus) discoveryCustomIconStatus.textContent = 'Pick icon URL or upload first.';
            return;
        }
        if (discoveryCustomIconStatus) discoveryCustomIconStatus.textContent = '';
        if (discoveryCustomIconModal) discoveryCustomIconModal.classList.add('hidden');
    });
}
if (discoveryAiImageQueryInput) {
    discoveryAiImageQueryInput.addEventListener('keydown', (ev) => {
        if (ev.key !== 'Enter') return;
        ev.preventDefault();
        discoveryIconSearchPage = 0;
        void generateDiscoveryIconPreview(0);
    });
}
if (discoveryApplyIconUrlBtn) {
    discoveryApplyIconUrlBtn.addEventListener('click', () => {
        void applyDiscoveryIconFromUrl();
    });
}

if (discoveryUploadIconBtn && discoveryUploadIconFileInput) {
    discoveryUploadIconBtn.addEventListener('click', () => {
        discoveryUploadIconFileInput.click();
    });
    discoveryUploadIconFileInput.addEventListener('change', () => {
        const file = discoveryUploadIconFileInput.files && discoveryUploadIconFileInput.files[0];
        if (!file) return;
        void applyDiscoveryIconFromUpload(file);
    });
}

if (discoveryIconUrlInput) {
    discoveryIconUrlInput.addEventListener('keydown', (ev) => {
        if (ev.key === 'Enter') {
            ev.preventDefault();
            void applyDiscoveryIconFromUrl();
        }
    });
}

if (discoveryTakeIconBtn) {
    discoveryTakeIconBtn.addEventListener('click', async () => {
        const itemId = state.discoveryIconItemId;
        const url = state.discoveryPreviewUrl;
        if (!itemId || !url) return;
        discoveryTakeIconBtn.disabled = true;
        try {
            const out = await postSaveItemIconRemote(itemId, url);
            if (typeof out.iconPath === 'string' && out.iconPath.trim()) {
                persistIconPathForItem(itemId, out.iconPath.trim());
            }
            await reloadCatalogFromApi();
            if (discoveryAiImageStatus) {
                discoveryAiImageStatus.textContent = 'Icon saved to images/ and catalog.';
            }
        } catch (e) {
            const msg = e && typeof e.message === 'string' ? e.message : String(e);
            if (discoveryAiImageStatus) discoveryAiImageStatus.textContent = msg.slice(0, 280);
        } finally {
            if (discoveryTakeIconBtn) discoveryTakeIconBtn.disabled = !state.discoveryPreviewUrl;
        }
    });
}

if (discoveryImageDoneBtn) {
    discoveryImageDoneBtn.addEventListener('click', () => {
        setDiscoveryStep('name');
        state.discoveryIconItemName = '';
        if (aiWrap) aiWrap.classList.add('hidden');
        clearAiFullReplyUi();
        if (aiOutgoingWrap) aiOutgoingWrap.classList.add('hidden');
        if (aiOutgoingEl) aiOutgoingEl.textContent = '';
        resetDiscoveryAiImagePreview();
        modal.classList.add('hidden');
    });
}

if (saveDiscoveryBtn) {
    saveDiscoveryBtn.addEventListener('click', () => {
        void saveDiscoveryAndStartIcon();
    });
}

function closeDiscoveryModalFromCancelFlow() {
    state.pendingCombination = null;
    state.aiSuggestions = [];
    state.discoverySelectedName = '';
    if (discoveryNameInputEl) discoveryNameInputEl.value = '';
    if (discoveryEmojiInputEl) discoveryEmojiInputEl.value = '';
    state.discoveryIconItemName = '';
    if (aiWrap) aiWrap.classList.add('hidden');
    clearAiFullReplyUi();
    if (aiOutgoingWrap) aiOutgoingWrap.classList.add('hidden');
    if (aiOutgoingEl) aiOutgoingEl.textContent = '';
    resetDiscoveryAiImagePreview();
    modal.classList.add('hidden');
}

/**
 * For lab discoveries, cancel should revert consumed ingredients.
 * Factory path keeps combiner unresolved and does not need canvas restore.
 * @param {{ a?: any, b?: any, factoryCombKey?: string }} pending
 */
function restorePendingIngredientsOnCancel(pending) {
    if (!pending || pending.factoryCombKey) return;
    const a = pending.a;
    const b = pending.b;
    if (!a || !b) return;
    const existingUids = new Set(state.activeElements.map((el) => String(el.uid || '')));
    if (!existingUids.has(String(a.uid || ''))) state.activeElements.push({ ...a });
    if (!existingUids.has(String(b.uid || ''))) state.activeElements.push({ ...b });
    renderCanvas();
}

if (rejectDiscoveryBtn) {
    rejectDiscoveryBtn.addEventListener('click', async () => {
        const pending = state.pendingCombination;
        rejectDiscoveryBtn.disabled = true;
        try {
            if (pending && pending.a && pending.b) {
                await postRejectedCraftRemote(String(pending.a.id || ''), String(pending.b.id || ''));
                if (pending.factoryCombKey) {
                    const ck = String(pending.factoryCombKey);
                    state.factory.cellRejectFlashUntil[ck] = performance.now() + 1000;
                    delete state.factory.combinerDiscovery[ck];
                    renderFactoryGrid();
                    notifyFactoryStateMutated();
                }
            }
        } finally {
            rejectDiscoveryBtn.disabled = false;
            closeDiscoveryModalFromCancelFlow();
        }
    });
}

if (discoveryNameInputEl) {
    discoveryNameInputEl.addEventListener('input', () => {
        state.discoverySelectedName = discoveryNameInputEl.value.trim();
        renderAiSuggestions();
        updateDiscoverySaveButton();
    });
}

if (discoveryEmojiInputEl) {
    discoveryEmojiInputEl.addEventListener('input', () => {
        const cleaned = normalizeSuggestionEmoji(discoveryEmojiInputEl.value);
        discoveryEmojiInputEl.value = cleaned;
    });
}

document.getElementById('cancel-discovery').addEventListener('click', () => {
    const pending = state.pendingCombination;
    rememberDeferredDiscovery(pending);
    restorePendingIngredientsOnCancel(pending);
    closeDiscoveryModalFromCancelFlow();
});

if (openDeferredDiscoveryBtn) {
    openDeferredDiscoveryBtn.addEventListener('click', () => {
        if (!deferredDiscoveryPromptPending) return;
        const pending = deferredDiscoveryPromptPending;
        setDeferredDiscoveryPrompt(null);
        openDiscoveryModal(pending, undefined);
    });
}

if (openLatestDiscoveryBtn) {
    openLatestDiscoveryBtn.addEventListener('click', () => {
        openLatestPendingDiscoveryModal();
    });
}

function showPulse(x, y, colorClass) {
    const pulse = document.createElement('div');
    pulse.className = `absolute rounded-full pointer-events-none animate-ping ${colorClass} opacity-75`;
    pulse.style.left = `${x}px`;
    pulse.style.top = `${y}px`;
    pulse.style.width = '100px';
    pulse.style.height = '100px';
    pulse.style.transform = 'translate(-50%, -50%)';
    workspaceEl.appendChild(pulse);
    setTimeout(() => pulse.remove(), 1000);
}

clearBtn.addEventListener('click', () => {
    state.activeElements = [];
    renderCanvas();
});

if (factoryClearBtn) {
    factoryClearBtn.addEventListener('click', () => {
        state.factory.placements = {};
        state.factory.selectedBuilding = null;
        state.factory.cellResources = {};
        state.factory.gatheringPoints = {};
        state.factory.gatheringPlaceMaterialId = null;
        state.factory.transporterDirs = {};
        state.factory.sorterDirs = {};
        state.factory.sorterItemFilters = {};
        state.factory.bridgeDirs = {};
        state.factory.cellItems = {};
        state.factory.combinerDirs = {};
        state.factory.combinerDiscovery = {};
        state.factory.factoryDiscoveryCombinerKey = null;
        state.factory.itemSlides = {};
        state.factory.beltDragPreview = null;
        state.factory.cellRejectFlashUntil = {};
        factoryClearBeltLineState();
        updateFactoryBuildButtons();
        renderFactoryGrid();
        notifyFactoryStateMutated();
    });
}

if (tabLabBtn && tabFactoryBtn) {
    tabLabBtn.addEventListener('click', () => setWorkspace('lab'));
    tabFactoryBtn.addEventListener('click', () => setWorkspace('factory'));
}

const toggleInventoryBtn = document.getElementById('toggle-inventory-panel');
const inventoryPanelEl = document.getElementById('inventory-panel');
if (toggleInventoryBtn && inventoryPanelEl) {
    toggleInventoryBtn.addEventListener('click', () => {
        inventoryPanelEl.classList.toggle('hidden');
        const open = !inventoryPanelEl.classList.contains('hidden');
        toggleInventoryBtn.setAttribute('aria-expanded', String(open));
        if (open && state.auth.token) {
            void apiFetch('/api/inventory/open', { method: 'POST' })
                .then(async (r) => {
                    if (!r.ok) return;
                    const payload = await r.json();
                    if (payload && payload.inventory) applyServerInventorySnapshot(payload.inventory);
                    if (payload && payload.runtime) applyFactoryRuntime(payload.runtime);
                })
                .catch(() => {});
        }
        requestAnimationFrame(() => {
            window.dispatchEvent(new Event('resize'));
            if (state.activeWorkspace === 'factory') {
                factoryResizeMainCanvas();
            }
        });
    });
}

if (factoryRuntimeStatusEl) {
    factoryRuntimeStatusEl.addEventListener('click', async () => {
        const rt = state.factoryRuntime || {};
        if (!rt.runStoppedAt) return;
        await pullFactoryRuntimeStatus();
        renderFactoryRuntimeStatsModal();
        setFactoryRuntimeStatsModalOpen(true);
    });
}

if (closeFactoryRuntimeStatsBtn) {
    closeFactoryRuntimeStatsBtn.addEventListener('click', () => setFactoryRuntimeStatsModalOpen(false));
}
if (factoryRuntimeStatsModalEl) {
    factoryRuntimeStatsModalEl.addEventListener('click', (e) => {
        if (e.target === factoryRuntimeStatsModalEl) setFactoryRuntimeStatsModalOpen(false);
    });
}

if (openGlobalDiscoveriesBtn) {
    openGlobalDiscoveriesBtn.addEventListener('click', async () => {
        openGlobalDiscoveriesBtn.disabled = true;
        try {
            globalDiscoveriesPage = 1;
            globalDiscoveriesExpandedId = '';
            discoveryProposalsByItem = {};
            await refreshGlobalDiscoveriesFromApi();
            setGlobalDiscoveriesModalOpen(true);
        } catch (e) {
            console.warn('refreshGlobalDiscoveriesFromApi', e);
        } finally {
            openGlobalDiscoveriesBtn.disabled = false;
        }
    });
}

if (closeGlobalDiscoveriesBtn) {
    closeGlobalDiscoveriesBtn.addEventListener('click', () => {
        setGlobalDiscoveriesModalOpen(false);
    });
}

if (globalDiscoveriesPrevBtn) {
    globalDiscoveriesPrevBtn.addEventListener('click', () => {
        globalDiscoveriesPage = Math.max(1, globalDiscoveriesPage - 1);
        renderGlobalDiscoveriesPage();
    });
}

if (globalDiscoveriesNextBtn) {
    globalDiscoveriesNextBtn.addEventListener('click', () => {
        globalDiscoveriesPage += 1;
        renderGlobalDiscoveriesPage();
    });
}

if (globalDiscoveriesModalEl) {
    globalDiscoveriesModalEl.addEventListener('click', (e) => {
        if (e.target === globalDiscoveriesModalEl) setGlobalDiscoveriesModalOpen(false);
    });
}

if (openDbViewerBtn) {
    openDbViewerBtn.addEventListener('click', async () => {
        openDbViewerBtn.disabled = true;
        try {
            await openDbViewerModal();
        } catch (e) {
            setDbViewerStatus(String(e && e.message ? e.message : e).slice(0, 240));
            setDbViewerModalOpen(true);
        } finally {
            openDbViewerBtn.disabled = false;
        }
    });
}
if (closeDbViewerBtn) {
    closeDbViewerBtn.addEventListener('click', () => setDbViewerModalOpen(false));
}
if (dbViewerModalEl) {
    dbViewerModalEl.addEventListener('click', (e) => {
        if (e.target === dbViewerModalEl) setDbViewerModalOpen(false);
    });
}
if (dbViewerTableSelectEl) {
    dbViewerTableSelectEl.addEventListener('change', () => {
        dbViewerSelectedTable = dbViewerTableSelectEl.value;
        void refreshDbViewerRows().catch((e) =>
            setDbViewerStatus(String(e && e.message ? e.message : e).slice(0, 240))
        );
    });
}
if (dbViewerRefreshBtn) {
    dbViewerRefreshBtn.addEventListener('click', () => {
        void refreshDbViewerRows().catch((e) =>
            setDbViewerStatus(String(e && e.message ? e.message : e).slice(0, 240))
        );
    });
}

if (openProfileBtn) {
    openProfileBtn.addEventListener('click', async () => {
        openProfileBtn.disabled = true;
        try {
            await openProfileModal();
        } catch (e) {
            setProfileStatus(String(e && e.message ? e.message : e).slice(0, 240));
            setProfileModalOpen(true);
        } finally {
            openProfileBtn.disabled = false;
        }
    });
}
if (closeProfileBtn) {
    closeProfileBtn.addEventListener('click', () => setProfileModalOpen(false));
}
if (profileModalEl) {
    profileModalEl.addEventListener('click', (e) => {
        if (e.target === profileModalEl) setProfileModalOpen(false);
    });
}

if (globalDiscoveriesListEl) {
    globalDiscoveriesListEl.addEventListener('click', async (ev) => {
        const t = ev.target;
        if (!t || !(t instanceof Element)) return;
        const editBtn = t.closest('[data-discovery-edit-btn="1"]');
        if (editBtn) {
            const id = String(editBtn.getAttribute('data-id') || '').trim();
            if (!id) return;
            const row = globalDiscoveriesRows.find((r) => r.id === id);
            if (!row) return;
            openDiscoveryEditModal(row);
            return;
        }
        const voteBtn = t.closest('[data-discovery-vote-btn="1"]');
        if (voteBtn) {
            const id = String(voteBtn.getAttribute('data-id') || '').trim();
            const vote =
                voteBtn.getAttribute('data-vote') === 'down'
                    ? 'down'
                    : voteBtn.getAttribute('data-vote') === 'up'
                      ? 'up'
                      : '';
            if (!id || !vote) return;
            const row = globalDiscoveriesRows.find((r) => r.id === id);
            if (!row) return;
            const buttons = globalDiscoveriesListEl.querySelectorAll(`[data-discovery-vote-btn="1"][data-id="${id}"]`);
            buttons.forEach((b) => b.setAttribute('disabled', 'disabled'));
            try {
                const out = await postDiscoveryVote(id, /** @type {'up' | 'down'} */ (vote));
                row.upvotes = out.upvotes;
                row.downvotes = out.downvotes;
                if (cachedBaseItemsMap && cachedBaseItemsMap[id]) {
                    cachedBaseItemsMap[id] = {
                        ...cachedBaseItemsMap[id],
                        upvotes: out.upvotes,
                        downvotes: out.downvotes
                    };
                }
                renderGlobalDiscoveriesPage();
            } catch (e) {
                console.warn('postDiscoveryVote', e);
                const msg = e && typeof e.message === 'string' ? e.message : String(e);
                alert(msg.slice(0, 180));
                buttons.forEach((b) => b.removeAttribute('disabled'));
            }
            return;
        }

        const proposalOpenBtn = t.closest('[data-discovery-proposal-open-btn="1"]');
        if (proposalOpenBtn) {
            const id = String(proposalOpenBtn.getAttribute('data-id') || '').trim();
            if (!id) return;
            discoveryProposalTargetItemId = id;
            if (discoveryNameProposalStatusEl) discoveryNameProposalStatusEl.textContent = '';
            if (discoveryImageProposalStatusEl) discoveryImageProposalStatusEl.textContent = '';
            setDiscoveryVoteOptionsModalOpen(true);
            return;
        }

        const proposalVoteBtn = t.closest('[data-discovery-proposal-vote-btn="1"]');
        if (proposalVoteBtn) {
            const proposalId = Number(proposalVoteBtn.getAttribute('data-proposal-id') || 0) | 0;
            const itemId = String(proposalVoteBtn.getAttribute('data-item-id') || '').trim();
            const vote =
                proposalVoteBtn.getAttribute('data-proposal-vote') === 'down'
                    ? 'down'
                    : proposalVoteBtn.getAttribute('data-proposal-vote') === 'up'
                      ? 'up'
                      : '';
            if (!proposalId || !itemId || !vote) return;
            proposalVoteBtn.setAttribute('disabled', 'disabled');
            try {
                await postDiscoveryProposalVote(proposalId, /** @type {'up'|'down'} */ (vote));
                await refreshDiscoveryProposalsForItem(itemId);
                renderGlobalDiscoveriesPage();
            } catch (e) {
                console.warn('postDiscoveryProposalVote', e);
                const msg = e && typeof e.message === 'string' ? e.message : String(e);
                alert(msg.slice(0, 180));
                proposalVoteBtn.removeAttribute('disabled');
            }
            return;
        }

        const expandToggle = t.closest('[data-discovery-expand-toggle]');
        if (expandToggle) {
            const id = String(expandToggle.getAttribute('data-discovery-expand-toggle') || '').trim();
            if (!id) return;
            if (globalDiscoveriesExpandedId === id) {
                globalDiscoveriesExpandedId = '';
                renderGlobalDiscoveriesPage();
                return;
            }
            globalDiscoveriesExpandedId = id;
            try {
                await refreshDiscoveryProposalsForItem(id);
            } catch (e) {
                console.warn('refreshDiscoveryProposalsForItem', e);
            }
            renderGlobalDiscoveriesPage();
        }
    });
}

if (discoveryEditCloseBtn) {
    discoveryEditCloseBtn.addEventListener('click', () => setDiscoveryEditModalOpen(false));
}
if (discoveryEditModalEl) {
    discoveryEditModalEl.addEventListener('click', (e) => {
        if (e.target === discoveryEditModalEl) setDiscoveryEditModalOpen(false);
    });
}
if (discoveryEditIngAEl) {
    discoveryEditIngAEl.addEventListener('click', () => {
        if (!discoveryEditTargetId || discoveryEditIngAEl.disabled) return;
        discoveryEditSlot = 'a';
        if (discoveryEditPickerEl) discoveryEditPickerEl.classList.remove('hidden');
        if (discoveryEditPickerLabelEl) discoveryEditPickerLabelEl.textContent = 'Replace ingredient A';
        if (discoveryEditSearchInputEl) {
            discoveryEditSearchInputEl.value = '';
            discoveryEditSearchInputEl.focus();
        }
        if (discoveryEditSearchResultsEl) discoveryEditSearchResultsEl.innerHTML = '';
    });
}
if (discoveryEditIngBEl) {
    discoveryEditIngBEl.addEventListener('click', () => {
        if (!discoveryEditTargetId || discoveryEditIngBEl.disabled) return;
        discoveryEditSlot = 'b';
        if (discoveryEditPickerEl) discoveryEditPickerEl.classList.remove('hidden');
        if (discoveryEditPickerLabelEl) discoveryEditPickerLabelEl.textContent = 'Replace ingredient B';
        if (discoveryEditSearchInputEl) {
            discoveryEditSearchInputEl.value = '';
            discoveryEditSearchInputEl.focus();
        }
        if (discoveryEditSearchResultsEl) discoveryEditSearchResultsEl.innerHTML = '';
    });
}
if (discoveryEditSearchInputEl) {
    discoveryEditSearchInputEl.addEventListener('input', () => scheduleDiscoveryEditSearch());
}
if (discoveryEditSearchResultsEl) {
    discoveryEditSearchResultsEl.addEventListener('click', async (ev) => {
        const t = ev.target;
        if (!t || !(t instanceof Element)) return;
        const pick = t.closest('[data-discovery-edit-pick-id]');
        if (!pick) return;
        const pickId = String(pick.getAttribute('data-discovery-edit-pick-id') || '').trim();
        const tid = discoveryEditTargetId;
        const slot = discoveryEditSlot;
        if (!tid || (slot !== 'a' && slot !== 'b') || !pickId) return;
        pick.setAttribute('disabled', 'disabled');
        try {
            await postDiscoveryUpdateIngredient(tid, /** @type {'a' | 'b'} */ (slot), pickId);
            await refreshGlobalDiscoveriesFromApi();
            await reloadCatalogFromApi();
            const row = globalDiscoveriesRows.find((r) => r.id === tid);
            if (row) fillDiscoveryEditIngredientLabels(row);
            hideDiscoveryEditPicker();
        } catch (e) {
            const msg = e && typeof e.message === 'string' ? e.message : String(e);
            alert(msg.slice(0, 240));
        } finally {
            pick.removeAttribute('disabled');
        }
    });
}
if (discoveryEditDeleteBtn) {
    discoveryEditDeleteBtn.addEventListener('click', async () => {
        const id = discoveryEditTargetId;
        if (!id) return;
        discoveryEditDeleteBtn.setAttribute('disabled', 'disabled');
        try {
            const ok = await runDiscoveryDeleteFlow(id);
            if (ok) setDiscoveryEditModalOpen(false);
        } catch (e) {
            const msg = e && typeof e.message === 'string' ? e.message : String(e);
            alert(msg.slice(0, 240));
        } finally {
            discoveryEditDeleteBtn.removeAttribute('disabled');
        }
    });
}

if (globalDiscoveriesSortEl) {
    globalDiscoveriesSortEl.value = globalDiscoveriesSort;
    globalDiscoveriesSortEl.addEventListener('change', () => {
        globalDiscoveriesSort = globalDiscoveriesSortEl.value === 'name' ? 'name' : 'datetime';
        globalDiscoveriesPage = 1;
        renderGlobalDiscoveriesPage();
    });
}

if (closeDiscoveryVoteOptionsBtn) {
    closeDiscoveryVoteOptionsBtn.addEventListener('click', () => setDiscoveryVoteOptionsModalOpen(false));
}
if (discoveryVoteOptionsModalEl) {
    discoveryVoteOptionsModalEl.addEventListener('click', (e) => {
        if (e.target === discoveryVoteOptionsModalEl) setDiscoveryVoteOptionsModalOpen(false);
    });
}

if (openDiscoveryNameProposalBtn) {
    openDiscoveryNameProposalBtn.addEventListener('click', () => {
        setDiscoveryVoteOptionsModalOpen(false);
        if (discoveryProposedNameInputEl) discoveryProposedNameInputEl.value = '';
        if (discoveryNameProposalStatusEl) discoveryNameProposalStatusEl.textContent = '';
        setDiscoveryNameProposalModalOpen(true);
    });
}

if (openDiscoveryImageProposalBtn) {
    openDiscoveryImageProposalBtn.addEventListener('click', () => {
        setDiscoveryVoteOptionsModalOpen(false);
        if (discoveryProposedImageUrlInputEl) discoveryProposedImageUrlInputEl.value = '';
        if (discoveryImageProposalStatusEl) discoveryImageProposalStatusEl.textContent = '';
        if (discoveryImageProposalPreviewEl) {
            discoveryImageProposalPreviewEl.classList.add('hidden');
            discoveryImageProposalPreviewEl.removeAttribute('src');
        }
        if (discoveryProposedImageFileInputEl) discoveryProposedImageFileInputEl.value = '';
        setDiscoveryImageProposalModalOpen(true);
    });
}

if (closeDiscoveryNameProposalBtn) {
    closeDiscoveryNameProposalBtn.addEventListener('click', () => setDiscoveryNameProposalModalOpen(false));
}
if (discoveryNameProposalModalEl) {
    discoveryNameProposalModalEl.addEventListener('click', (e) => {
        if (e.target === discoveryNameProposalModalEl) setDiscoveryNameProposalModalOpen(false);
    });
}

if (closeDiscoveryImageProposalBtn) {
    closeDiscoveryImageProposalBtn.addEventListener('click', () => setDiscoveryImageProposalModalOpen(false));
}
if (discoveryImageProposalModalEl) {
    discoveryImageProposalModalEl.addEventListener('click', (e) => {
        if (e.target === discoveryImageProposalModalEl) setDiscoveryImageProposalModalOpen(false);
    });
}

if (submitDiscoveryNameProposalBtn) {
    submitDiscoveryNameProposalBtn.addEventListener('click', async () => {
        const itemId = String(discoveryProposalTargetItemId || '').trim();
        const proposedName = String((discoveryProposedNameInputEl && discoveryProposedNameInputEl.value) || '').trim();
        if (!itemId || !proposedName) {
            if (discoveryNameProposalStatusEl) discoveryNameProposalStatusEl.textContent = 'Enter a proposed name.';
            return;
        }
        submitDiscoveryNameProposalBtn.disabled = true;
        if (discoveryNameProposalStatusEl) discoveryNameProposalStatusEl.textContent = 'Starting vote...';
        try {
            await postCreateDiscoveryProposal(itemId, { proposalType: 'name', proposedName });
            await refreshDiscoveryProposalsForItem(itemId);
            globalDiscoveriesExpandedId = itemId;
            renderGlobalDiscoveriesPage();
            if (discoveryNameProposalStatusEl) discoveryNameProposalStatusEl.textContent = 'Vote started.';
            setDiscoveryNameProposalModalOpen(false);
        } catch (e) {
            const msg = e && typeof e.message === 'string' ? e.message : String(e);
            if (discoveryNameProposalStatusEl) discoveryNameProposalStatusEl.textContent = msg.slice(0, 200);
        } finally {
            submitDiscoveryNameProposalBtn.disabled = false;
        }
    });
}

if (submitDiscoveryImageUrlProposalBtn) {
    submitDiscoveryImageUrlProposalBtn.addEventListener('click', async () => {
        const itemId = String(discoveryProposalTargetItemId || '').trim();
        const imageUrl = String((discoveryProposedImageUrlInputEl && discoveryProposedImageUrlInputEl.value) || '').trim();
        if (!itemId || !imageUrl) {
            if (discoveryImageProposalStatusEl) discoveryImageProposalStatusEl.textContent = 'Enter image URL first.';
            return;
        }
        submitDiscoveryImageUrlProposalBtn.disabled = true;
        if (discoveryImageProposalStatusEl) discoveryImageProposalStatusEl.textContent = 'Creating image proposal...';
        try {
            const out = await postCreateDiscoveryProposal(itemId, { proposalType: 'image', imageUrl });
            if (discoveryImageProposalPreviewEl && out && out.proposedImagePath) {
                discoveryImageProposalPreviewEl.src = proposalImageSrc(out.proposedImagePath);
                discoveryImageProposalPreviewEl.classList.remove('hidden');
            }
            await refreshDiscoveryProposalsForItem(itemId);
            globalDiscoveriesExpandedId = itemId;
            renderGlobalDiscoveriesPage();
            if (discoveryImageProposalStatusEl) discoveryImageProposalStatusEl.textContent = 'Vote started.';
            setDiscoveryImageProposalModalOpen(false);
        } catch (e) {
            const msg = e && typeof e.message === 'string' ? e.message : String(e);
            if (discoveryImageProposalStatusEl) discoveryImageProposalStatusEl.textContent = msg.slice(0, 200);
        } finally {
            submitDiscoveryImageUrlProposalBtn.disabled = false;
        }
    });
}

if (openDiscoveryImageUploadProposalBtn && discoveryProposedImageFileInputEl) {
    openDiscoveryImageUploadProposalBtn.addEventListener('click', () => {
        discoveryProposedImageFileInputEl.click();
    });
    discoveryProposedImageFileInputEl.addEventListener('change', async () => {
        const file = discoveryProposedImageFileInputEl.files && discoveryProposedImageFileInputEl.files[0];
        const itemId = String(discoveryProposalTargetItemId || '').trim();
        if (!file || !itemId) return;
        const valid = validateDiscoveryUploadFile(file);
        if (!valid.ok) {
            if (discoveryImageProposalStatusEl) discoveryImageProposalStatusEl.textContent = valid.message;
            return;
        }
        openDiscoveryImageUploadProposalBtn.disabled = true;
        if (discoveryImageProposalStatusEl) discoveryImageProposalStatusEl.textContent = 'Uploading and creating vote...';
        try {
            const imageDataUrl = await fileToDataUrl(file);
            const out = await postCreateDiscoveryProposal(itemId, { proposalType: 'image', imageDataUrl });
            if (discoveryImageProposalPreviewEl && out && out.proposedImagePath) {
                discoveryImageProposalPreviewEl.src = proposalImageSrc(out.proposedImagePath);
                discoveryImageProposalPreviewEl.classList.remove('hidden');
            }
            await refreshDiscoveryProposalsForItem(itemId);
            globalDiscoveriesExpandedId = itemId;
            renderGlobalDiscoveriesPage();
            if (discoveryImageProposalStatusEl) discoveryImageProposalStatusEl.textContent = 'Vote started.';
            setDiscoveryImageProposalModalOpen(false);
        } catch (e) {
            const msg = e && typeof e.message === 'string' ? e.message : String(e);
            if (discoveryImageProposalStatusEl) discoveryImageProposalStatusEl.textContent = msg.slice(0, 200);
        } finally {
            openDiscoveryImageUploadProposalBtn.disabled = false;
            discoveryProposedImageFileInputEl.value = '';
        }
    });
}

const upgradesOpenBtn = document.getElementById('open-upgrades');
const upgradesCloseBtn = document.getElementById('close-upgrades');
const upgradesModalEl = document.getElementById('upgrades-modal');
function setUpgradesModalOpen(open) {
    if (!upgradesModalEl) return;
    upgradesModalEl.classList.toggle('hidden', !open);
    if (open) {
        updateFactoryUpgradeBar();
    }
}
if (upgradesOpenBtn && upgradesModalEl) {
    upgradesOpenBtn.addEventListener('click', () => setUpgradesModalOpen(true));
}
if (upgradesCloseBtn && upgradesModalEl) {
    upgradesCloseBtn.addEventListener('click', () => setUpgradesModalOpen(false));
}
if (upgradesModalEl) {
    upgradesModalEl.addEventListener('click', (e) => {
        if (e.target === upgradesModalEl) setUpgradesModalOpen(false);
    });
}
window.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (dbViewerModalEl && !dbViewerModalEl.classList.contains('hidden')) {
        setDbViewerModalOpen(false);
        return;
    }
    if (profileModalEl && !profileModalEl.classList.contains('hidden')) {
        setProfileModalOpen(false);
        return;
    }
    if (discoveryImageProposalModalEl && !discoveryImageProposalModalEl.classList.contains('hidden')) {
        setDiscoveryImageProposalModalOpen(false);
        return;
    }
    if (discoveryNameProposalModalEl && !discoveryNameProposalModalEl.classList.contains('hidden')) {
        setDiscoveryNameProposalModalOpen(false);
        return;
    }
    if (discoveryVoteOptionsModalEl && !discoveryVoteOptionsModalEl.classList.contains('hidden')) {
        setDiscoveryVoteOptionsModalOpen(false);
        return;
    }
    if (globalDiscoveriesModalEl && !globalDiscoveriesModalEl.classList.contains('hidden')) {
        setGlobalDiscoveriesModalOpen(false);
        return;
    }
    if (factoryRuntimeStatsModalEl && !factoryRuntimeStatsModalEl.classList.contains('hidden')) {
        setFactoryRuntimeStatsModalOpen(false);
        return;
    }
    if (upgradesModalEl && !upgradesModalEl.classList.contains('hidden')) {
        setUpgradesModalOpen(false);
    }
});

if (factoryCanvasEl) {
    factoryCanvasEl.addEventListener('contextmenu', (e) => {
        e.preventDefault();
    });

    factoryCanvasEl.addEventListener(
        'wheel',
        (e) => {
            if (state.activeWorkspace !== 'factory') return;
            e.preventDefault();
            const factor = e.deltaY < 0 ? 1.1 : 1 / 1.1;
            factoryZoomAtClientPoint(e.clientX, e.clientY, state.factory.cameraZoom * factor);
        },
        { passive: false }
    );

    factoryCanvasEl.addEventListener('click', (e) => {
        if (factorySuppressNextFactoryCanvasClick) {
            e.preventDefault();
            e.stopPropagation();
            factorySuppressNextFactoryCanvasClick = false;
            return;
        }
        const hit = factoryPixelToCell(e.clientX, e.clientY);
        if (!hit) return;
        factoryHandleCellAction(hit.col, hit.row, e.shiftKey);
    });

    factoryCanvasEl.addEventListener('pointerdown', (e) => {
        if (state.activeWorkspace !== 'factory') return;
        if (e.button !== 0 || e.shiftKey) return;
        const transporterDrawMode = state.factory.selectedBuilding === 'transporter';
        const hit = factoryPixelToCell(e.clientX, e.clientY);
        if (!hit) return;
        if (transporterDrawMode) {
            factoryBeltAnchorPointerId = e.pointerId;
            factoryBeltAnchorCol = hit.col;
            factoryBeltAnchorRow = hit.row;
            state.factory.beltDragPreview = [{ col: hit.col, row: hit.row }];
        } else {
            factoryCameraPan = {
                pointerId: e.pointerId,
                startX: e.clientX,
                startY: e.clientY,
                startCamX: state.factory.cameraX,
                startCamY: state.factory.cameraY,
                moved: false
            };
        }
        try {
            factoryCanvasEl.setPointerCapture(e.pointerId);
        } catch (_) {
            /* ignore */
        }
    });

    factoryCanvasEl.addEventListener('pointermove', (e) => {
        if (factoryBeltAnchorPointerId === e.pointerId) {
            const endHit = factoryPixelToCell(e.clientX, e.clientY);
            if (!endHit) return;
            const raw = factoryManhattanPath(factoryBeltAnchorCol, factoryBeltAnchorRow, endHit.col, endHit.row);
            state.factory.beltDragPreview = factoryFilterBeltPath(raw);
            return;
        }
        if (!factoryCameraPan || factoryCameraPan.pointerId !== e.pointerId || !factoryViewLayout) return;
        const dx = e.clientX - factoryCameraPan.startX;
        const dy = e.clientY - factoryCameraPan.startY;
        if (Math.abs(dx) > 3 || Math.abs(dy) > 3) {
            factoryCameraPan.moved = true;
            state.factory.cameraX = factoryCameraPan.startCamX - dx / factoryViewLayout.stride;
            state.factory.cameraY = factoryCameraPan.startCamY - dy / factoryViewLayout.stride;
        }
    });

    factoryCanvasEl.addEventListener('pointerup', (e) => {
        if (factoryCameraPan && factoryCameraPan.pointerId === e.pointerId) {
            const moved = factoryCameraPan.moved;
            factoryCameraPan = null;
            if (moved) factorySuppressNextFactoryCanvasClick = true;
            try {
                factoryCanvasEl.releasePointerCapture(e.pointerId);
            } catch (_) {
                /* ignore */
            }
            return;
        }
        if (factoryBeltAnchorPointerId !== e.pointerId) return;
        try {
            factoryCanvasEl.releasePointerCapture(e.pointerId);
        } catch (_) {
            /* ignore */
        }
        const scol = factoryBeltAnchorCol;
        const srow = factoryBeltAnchorRow;
        factoryBeltAnchorPointerId = null;
        state.factory.beltDragPreview = null;

        factorySuppressNextFactoryCanvasClick = true;

        const endHit = factoryPixelToCell(e.clientX, e.clientY);
        if (!endHit) return;

        if (endHit.col === scol && endHit.row === srow) {
            factoryHandleCellAction(scol, srow, e.shiftKey);
            return;
        }

        const raw = factoryManhattanPath(scol, srow, endHit.col, endHit.row);
        const filtered = factoryFilterBeltPath(raw);
        if (filtered.length > 0) {
            const dirs = factoryDirsAlongFilteredPath(filtered, raw);
            factoryApplyBeltPath(filtered, dirs);
        }
    });

    factoryCanvasEl.addEventListener('pointercancel', (e) => {
        if (factoryCameraPan && factoryCameraPan.pointerId === e.pointerId) {
            factoryCameraPan = null;
            factorySuppressNextFactoryCanvasClick = true;
            return;
        }
        if (factoryBeltAnchorPointerId !== e.pointerId) return;
        factoryBeltAnchorPointerId = null;
        state.factory.beltDragPreview = null;
        factorySuppressNextFactoryCanvasClick = true;
    });
}

document.querySelectorAll('.factory-build-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
        const t = btn.getAttribute('data-factory-building');
        if (!t || (t !== 'transporter' && t !== 'extractor' && t !== 'combiner' && t !== 'storage' && t !== 'sorter' && t !== 'bridge')) return;
        factoryClearBeltLineState();
        state.factory.gatheringPlaceMaterialId = null;
        state.factory.selectedBuilding = state.factory.selectedBuilding === t ? null : t;
        updateFactoryBuildButtons();
    });
});

document.querySelectorAll('.factory-gathering-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
        const id = btn.getAttribute('data-factory-gathering-material');
        if (!id || !FACTORY_GATHERING_MATERIAL_IDS.includes(id)) return;
        factoryClearBeltLineState();
        state.factory.selectedBuilding = null;
        state.factory.gatheringPlaceMaterialId = state.factory.gatheringPlaceMaterialId === id ? null : id;
        updateFactoryBuildButtons();
    });
});

if (factoryClearBuildingsBtn) {
    factoryClearBuildingsBtn.addEventListener('click', () => {
        state.factory.placements = {};
        state.factory.transporterDirs = {};
        state.factory.sorterDirs = {};
        state.factory.sorterItemFilters = {};
        state.factory.bridgeDirs = {};
        state.factory.combinerDirs = {};
        state.factory.combinerDiscovery = {};
        state.factory.factoryDiscoveryCombinerKey = null;
        state.factory.itemSlides = {};
        state.factory.cellItems = {};
        state.factory.cellRejectFlashUntil = {};
        factoryClearBeltLineState();
        renderFactoryGrid();
        notifyFactoryStateMutated();
    });
}

if (factoryUpgradeSizeBtn) {
    factoryUpgradeSizeBtn.addEventListener('click', () => {
        if (state.factory.sizeUpgradeLevel >= MAX_FACTORY_SIZE_LEVEL) return;
        factoryShiftKeyedMaps(1, 1);
        state.factory.sizeUpgradeLevel++;
        state.factory.cameraX += 1;
        state.factory.cameraY += 1;
        renderFactoryGrid();
        notifyFactoryStateMutated();
    });
}

if (factoryUpgradeSpeedBtn) {
    factoryUpgradeSpeedBtn.addEventListener('click', () => {
        if (!factoryCanSpeedUpgrade()) return;
        const cur = factoryLoopIntervalMs();
        state.factory.loopMs = Math.max(MIN_FACTORY_LOOP_MS, Math.round(cur * 0.9));
        restartFactoryLoop();
        updateFactoryUpgradeBar();
        notifyFactoryStateMutated();
    });
}

if (authLoginBtn) {
    authLoginBtn.addEventListener('click', () => {
        void runAuthRequest('/api/auth/login');
    });
}
if (authRegisterBtn) {
    authRegisterBtn.addEventListener('click', () => {
        void runAuthRequest('/api/auth/register');
    });
}
if (authPasswordInput) {
    authPasswordInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            e.preventDefault();
            void runAuthRequest('/api/auth/login');
        }
    });
}
if (authLogoutBtn) {
    authLogoutBtn.addEventListener('click', () => {
        const oldToken = state.auth.token;
        state.auth.token = '';
        state.auth.username = '';
        state.pendingDiscoveryNotices = [];
        state.deferredDiscoveries = {};
        state.pendingCombination = null;
        state.playerInventory = {};
        setDeferredDiscoveryPrompt(null);
        updateFloatingDiscoveryAlert(false);
        applyLoggedInUi();
        stopPlayerPingLoop();
        stopFactoryRuntimeSyncLoop();
        renderPlayerInventory();
        storeSessionToken('');
        void fetch(`${apiOrigin()}/api/auth/logout`, {
            method: 'POST',
            headers: oldToken ? { Authorization: `Bearer ${oldToken}` } : {}
        }).catch(() => {});
        setAuthVisible(true);
    });
}

function handleTouchStartFromLibrary(e, item) {
    const ghost = document.createElement('div');
    ghost.className = 'fixed text-4xl pointer-events-none z-50';
    ghost.innerText = typeof item.emoji === 'string' ? item.emoji : splitLabel(item.name).icon;
    document.body.appendChild(ghost);

    const move = (me) => {
        const mt = me.touches[0];
        ghost.style.left = `${mt.clientX - 20}px`;
        ghost.style.top = `${mt.clientY - 20}px`;
    };

    const stop = (ee) => {
        const et = ee.changedTouches[0];
        const rect = workspaceEl.getBoundingClientRect();
        if (
            et.clientX >= rect.left &&
            et.clientX <= rect.right &&
            et.clientY >= rect.top &&
            et.clientY <= rect.bottom
        ) {
            createElementOnCanvas(item, et.clientX, et.clientY);
        }
        ghost.remove();
        window.removeEventListener('touchmove', move);
        window.removeEventListener('touchend', stop);
    };

    window.addEventListener('touchmove', move);
    window.addEventListener('touchend', stop);
}

async function bootAfterAuth() {
    await loadGameData();
    state.pendingDiscoveryNotices = [];
    state.deferredDiscoveries = {};
    setDeferredDiscoveryPrompt(null);
    updateFloatingDiscoveryAlert(false);
    recomputeAllTiers();
    renderLibrary();
    renderCanvas();
    updateFactoryBuildButtons();
    updateFactoryUpgradeBar();
}

async function initAuthThenBoot() {
    applyLoggedInUi();
    const stored = readStoredSessionToken();
    if (stored) {
        state.auth.token = stored;
        try {
            const r = await apiFetch('/api/auth/autologin', { method: 'POST' });
            if (r.ok) {
                const payload = await r.json();
                if (payload && payload.username) state.auth.username = String(payload.username);
                if (payload && payload.inventory) applyServerInventorySnapshot(payload.inventory);
                applyLoggedInUi();
                startPlayerPingLoop();
                startFactoryRuntimeSyncLoop();
                setAuthVisible(false);
            } else {
                state.auth.token = '';
                storeSessionToken('');
                stopPlayerPingLoop();
                stopFactoryRuntimeSyncLoop();
                setAuthVisible(true);
            }
        } catch {
            state.auth.token = '';
            storeSessionToken('');
            stopPlayerPingLoop();
            stopFactoryRuntimeSyncLoop();
            setAuthVisible(true);
        }
    } else {
        setAuthVisible(true);
    }
    await bootAfterAuth();
}

initAuthThenBoot().catch((err) => {
    console.error(err);
    const instruction = document.getElementById('instruction');
    if (instruction) {
        instruction.innerHTML =
            '<p class="text-center px-8 text-amber-300/90 max-w-md">Could not load items from the API server. Run <code class="text-slate-300">npm start</code> and login first.</p>';
        instruction.style.display = 'flex';
        instruction.style.opacity = '1';
        instruction.style.pointerEvents = 'auto';
    }
});
