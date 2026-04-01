import http from 'http';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import sharp from 'sharp';
import { fileURLToPath } from 'url';
import {
    openDb,
    getItemsMap,
    recordRejectedCraft,
    isRejectedCraft,
    upsertItem,
    findItemByName,
    listDependentItems,
    deleteItemById,
    setItemIconPath,
    voteOnItem,
    createDiscoveryProposal,
    listDiscoveryProposalsByItem,
    voteOnDiscoveryProposal,
    listTopDiscoveriesByUser,
    createUser,
    getUserByUsername,
    getUserById,
    touchUserLastSeen,
    upsertSession,
    getSessionByTokenHash,
    deleteSessionByTokenHash,
    getUserInventoryMap,
    addToUserInventory,
    saveUserFactoryState,
    loadUserFactoryState,
    addFactorySnapshoot,
    loadLatestFactorySnapshoot
} from './db.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = 3456;
const OPENAI_KEY_FILE = path.join(__dirname, 'key.txt');

function readOpenAiKeyFromFile() {
    try {
        const raw = fs.readFileSync(OPENAI_KEY_FILE, 'utf8');
        const text = String(raw || '')
            .replace(/^\uFEFF/, '')
            .trim();
        if (!text) return '';
        const firstNonEmpty = text
            .split(/\r?\n/)
            .map((line) => line.trim())
            .find((line) => line.length > 0);
        if (!firstNonEmpty) return '';
        let candidate = firstNonEmpty;
        const m = candidate.match(/^(?:export\s+)?OPENAI_API_KEY\s*=\s*(.+)$/i);
        if (m && m[1]) candidate = m[1].trim();
        candidate = candidate.replace(/^['"]|['"]$/g, '').trim();
        if (!candidate.startsWith('sk-')) return '';
        return candidate;
    } catch {
        return '';
    }
}

const OPENAI_KEY = readOpenAiKeyFromFile() || String(process.env.OPENAI_API_KEY || '').trim();
const SESSION_TTL_DAYS = 30;
const FACTORY_GRID_BASE = 8;
const FACTORY_LOOP_MS_DEFAULT = 500;
const MIN_FACTORY_LOOP_MS = 33;
const MAX_FACTORY_SIZE_LEVEL = 10;
const PLAYER_TIMEOUT_MS = 60 * 1000;
const FACTORY_RUN_WINDOW_MS = 10 * 1000;

const db = openDb();
const publicRoot = path.join(__dirname, 'public');
const imagesRoot = path.join(__dirname, 'images');

/** @type {Map<number, any>} */
const factoryStateByUser = new Map();
/** @type {Map<number, number>} user id -> last ping/activity ms */
const playerLastSeenAt = new Map();
let recipeIndex = buildRecipeIndex(getItemsMap(db));

const CORS_API = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization'
};

const MIME = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.ico': 'image/x-icon',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.svg': 'image/svg+xml'
};

function send(res, status, body, headers = {}) {
    res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8', ...headers });
    res.end(body);
}

function sendJson(res, status, payload, headers = {}) {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', ...headers });
    res.end(JSON.stringify(payload));
}

function readRequestBody(req) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        req.on('data', (c) => chunks.push(c));
        req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
        req.on('error', reject);
    });
}

function parseBody(raw) {
    try {
        return JSON.parse(raw);
    } catch {
        return null;
    }
}

function normalizeUsername(input) {
    return String(input || '')
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9_.-]/g, '');
}

function passwordHash(password, salt) {
    return crypto.scryptSync(String(password), String(salt), 64).toString('hex');
}

function randomTokenHex(bytes = 32) {
    return crypto.randomBytes(bytes).toString('hex');
}

function sha256Hex(s) {
    return crypto.createHash('sha256').update(String(s)).digest('hex');
}

function sessionTokenFromRequest(req) {
    const h = String(req.headers.authorization || '').trim();
    if (h.startsWith('Bearer ')) return h.slice(7).trim();
    return '';
}

function sessionExpiryIso() {
    const now = Date.now();
    return new Date(now + SESSION_TTL_DAYS * 24 * 60 * 60 * 1000).toISOString();
}

function authenticate(req) {
    const token = sessionTokenFromRequest(req);
    if (!token) return null;
    const tokenHash = sha256Hex(token);
    const session = getSessionByTokenHash(db, tokenHash);
    if (!session) return null;
    const exp = Date.parse(session.expires_at);
    if (!Number.isFinite(exp) || exp < Date.now()) {
        deleteSessionByTokenHash(db, tokenHash);
        return null;
    }
    const userId = Number(session.user_id);
    touchUserLastSeen(db, userId);
    playerLastSeenAt.set(userId, Date.now());
    return { userId, token, tokenHash };
}

function isPlayerTimedOut(userId, now = Date.now()) {
    const uid = Number(userId) | 0;
    const last = Number(playerLastSeenAt.get(uid) || 0);
    return !last || now - last > PLAYER_TIMEOUT_MS;
}

function buildRecipeIndex(items) {
    const out = {};
    for (const [id, def] of Object.entries(items)) {
        if (!def || typeof def !== 'object') continue;
        if (typeof def.a !== 'string' || typeof def.b !== 'string') continue;
        const key = [def.a, def.b].sort().join('+');
        out[key] = id;
    }
    return out;
}

function factoryPlacementKey(col, row) {
    return `${col},${row}`;
}

function factoryNeighborColRow(col, row, dir) {
    if (dir === 0) return { col, row: row - 1 };
    if (dir === 1) return { col: col + 1, row };
    if (dir === 2) return { col, row: row + 1 };
    return { col: col - 1, row };
}

function factoryKeyToColRow(key) {
    const parts = String(key).split(',');
    return { col: Number(parts[0] || 0), row: Number(parts[1] || 0) };
}

function factoryGridCols(state) {
    const lv = Math.max(0, Math.min(MAX_FACTORY_SIZE_LEVEL, Number(state.sizeUpgradeLevel || 0) | 0));
    return FACTORY_GRID_BASE + lv * 2;
}

function factoryLoopIntervalMs(state) {
    const n = Number(state.loopMs);
    if (!Number.isFinite(n)) return FACTORY_LOOP_MS_DEFAULT;
    return Math.max(MIN_FACTORY_LOOP_MS, Math.round(n));
}

function factoryInBounds(state, col, row) {
    const n = factoryGridCols(state);
    return col >= 0 && row >= 0 && col < n && row < n;
}

function factoryMaterialFromCornerSources(state, col, row) {
    const n = factoryGridCols(state);
    const corners = [
        [0, 0, 'wood'],
        [n - 1, 0, 'stone'],
        [0, n - 1, 'water'],
        [n - 1, n - 1, 'dirt']
    ];
    const found = [];
    for (const [cc, rr, id] of corners) {
        const d2 = Math.abs(col - cc) + Math.abs(row - rr);
        if (d2 === 0 || d2 === 2) found.push(id);
    }
    if (found.length === 0) return null;
    const uniq = [...new Set(found)];
    if (uniq.length === 1) return uniq[0];
    const order = { wood: 0, stone: 1, water: 2, dirt: 3 };
    return uniq.sort((a, b) => order[a] - order[b])[0];
}

function factoryCellResourceId(state, col, row) {
    const key = factoryPlacementKey(col, row);
    const stored = state.cellResources[key];
    if (stored && typeof stored === 'string' && stored.trim()) return stored.trim();
    return factoryMaterialFromCornerSources(state, col, row);
}

function factoryTransporterDir(state, key) {
    const d = state.transporterDirs[key];
    return d === 0 || d === 1 || d === 2 || d === 3 ? d : 0;
}

function factoryCombinerDir(state, key) {
    const d = state.combinerDirs[key];
    return d === 0 || d === 1 || d === 2 || d === 3 ? d : 0;
}

function defaultFactoryState() {
    return {
        placements: {},
        selectedBuilding: null,
        cellResources: {},
        transporterDirs: {},
        sizeUpgradeLevel: 0,
        loopMs: FACTORY_LOOP_MS_DEFAULT,
        loopTick: 0,
        cellItems: {},
        loopPulseUntil: 0,
        combinerDirs: {},
        combinerDiscovery: {},
        factoryDiscoveryCombinerKey: null,
        itemSlides: {},
        beltDragPreview: null,
        cellRejectFlashUntil: {},
        cameraX: (FACTORY_GRID_BASE - 1) / 2,
        cameraY: (FACTORY_GRID_BASE - 1) / 2,
        cameraZoom: 1,
        _serverLastTickAt: Date.now(),
        _serverAccumulatorMs: 0,
        _factoryLastChangedAt: 0,
        _factoryRunUntilAt: 0,
        _factoryRunStartedAt: 0,
        _factoryRunStoppedAtIso: null,
        _factoryPendingProduced: {},
        _factoryCurrentProducedPerMinute: {},
        _factoryLastProducedPerMinute: {}
    };
}

function sanitizeFactoryState(raw) {
    const base = defaultFactoryState();
    if (!raw || typeof raw !== 'object') return base;
    const st = { ...base, ...raw };
    st.placements = typeof raw.placements === 'object' && raw.placements ? raw.placements : {};
    st.cellResources = typeof raw.cellResources === 'object' && raw.cellResources ? raw.cellResources : {};
    st.transporterDirs = typeof raw.transporterDirs === 'object' && raw.transporterDirs ? raw.transporterDirs : {};
    st.combinerDirs = typeof raw.combinerDirs === 'object' && raw.combinerDirs ? raw.combinerDirs : {};
    st.cellItems = typeof raw.cellItems === 'object' && raw.cellItems ? raw.cellItems : {};
    st.combinerDiscovery =
        typeof raw.combinerDiscovery === 'object' && raw.combinerDiscovery ? raw.combinerDiscovery : {};
    st.itemSlides = typeof raw.itemSlides === 'object' && raw.itemSlides ? raw.itemSlides : {};
    st.cellRejectFlashUntil =
        typeof raw.cellRejectFlashUntil === 'object' && raw.cellRejectFlashUntil ? raw.cellRejectFlashUntil : {};
    st.sizeUpgradeLevel = Math.max(
        0,
        Math.min(MAX_FACTORY_SIZE_LEVEL, Number(raw.sizeUpgradeLevel || 0) | 0)
    );
    st.loopMs = factoryLoopIntervalMs(st);
    st._serverLastTickAt = Date.now();
    st._serverAccumulatorMs = 0;
    st._factoryLastChangedAt = Number(raw._factoryLastChangedAt || 0) || 0;
    st._factoryRunUntilAt = Number(raw._factoryRunUntilAt || 0) || 0;
    st._factoryRunStartedAt = Number(raw._factoryRunStartedAt || 0) || 0;
    st._factoryRunStoppedAtIso =
        typeof raw._factoryRunStoppedAtIso === 'string' && raw._factoryRunStoppedAtIso.trim()
            ? raw._factoryRunStoppedAtIso.trim()
            : null;
    st._factoryPendingProduced =
        typeof raw._factoryPendingProduced === 'object' && raw._factoryPendingProduced ? raw._factoryPendingProduced : {};
    st._factoryCurrentProducedPerMinute =
        typeof raw._factoryCurrentProducedPerMinute === 'object' && raw._factoryCurrentProducedPerMinute
            ? raw._factoryCurrentProducedPerMinute
            : {};
    st._factoryLastProducedPerMinute =
        typeof raw._factoryLastProducedPerMinute === 'object' && raw._factoryLastProducedPerMinute
            ? raw._factoryLastProducedPerMinute
            : {};
    return st;
}

function activateFactoryRunWindow(state, now = Date.now()) {
    state._factoryLastChangedAt = now;
    state._factoryRunUntilAt = now + FACTORY_RUN_WINDOW_MS;
    state._factoryRunStartedAt = now;
    state._factoryRunStoppedAtIso = null;
    if (!state._factoryPendingProduced || typeof state._factoryPendingProduced !== 'object') {
        state._factoryPendingProduced = {};
    }
    state._factoryCurrentProducedPerMinute = {};
}

function addProducedToMinuteStats(state, nowMs, delta) {
    if (!delta || typeof delta !== 'object') return;
    const startedAt = Number(state._factoryRunStartedAt || 0);
    if (!startedAt) return;
    const minuteIdx = Math.max(0, Math.floor((nowMs - startedAt) / 60000));
    const minuteKey = String(minuteIdx);
    if (!state._factoryCurrentProducedPerMinute || typeof state._factoryCurrentProducedPerMinute !== 'object') {
        state._factoryCurrentProducedPerMinute = {};
    }
    const bucket = state._factoryCurrentProducedPerMinute[minuteKey];
    const outBucket = bucket && typeof bucket === 'object' ? bucket : {};
    for (const [itemId, qty] of Object.entries(delta)) {
        const n = Number(qty) | 0;
        if (!itemId || n <= 0) continue;
        outBucket[itemId] = (Number(outBucket[itemId] || 0) | 0) + n;
    }
    state._factoryCurrentProducedPerMinute[minuteKey] = outBucket;
}

function factoryStatsPerMinuteRows(state) {
    const src = state._factoryLastProducedPerMinute && typeof state._factoryLastProducedPerMinute === 'object'
        ? state._factoryLastProducedPerMinute
        : {};
    const minuteIdxs = Object.keys(src)
        .map((k) => Number(k))
        .filter((n) => Number.isFinite(n) && n >= 0)
        .sort((a, b) => a - b);
    const rows = [];
    for (const idx of minuteIdxs) {
        const bucket = src[String(idx)];
        if (!bucket || typeof bucket !== 'object') continue;
        const items = [];
        for (const [itemId, qtyRaw] of Object.entries(bucket)) {
            const qty = Number(qtyRaw) | 0;
            if (!itemId || qty <= 0) continue;
            items.push({ itemId, qty });
        }
        items.sort((a, b) => a.itemId.localeCompare(b.itemId));
        rows.push({ minute: idx + 1, items });
    }
    return rows;
}

function factoryRuntimeStatus(state, now = Date.now()) {
    const runUntil = Number(state._factoryRunUntilAt || 0);
    const running = runUntil > now;
    return {
        running,
        runUntilAt: runUntil > 0 ? new Date(runUntil).toISOString() : null,
        runStartedAt:
            Number(state._factoryRunStartedAt || 0) > 0 ? new Date(Number(state._factoryRunStartedAt)).toISOString() : null,
        runStoppedAt: state._factoryRunStoppedAtIso || null,
        remainingMs: running ? Math.max(0, runUntil - now) : 0,
        statsPerMinute: factoryStatsPerMinuteRows(state)
    };
}

function factoryStep(state) {
    const work = {};
    for (const [k, v] of Object.entries(state.cellItems || {})) {
        if (typeof v === 'string' && v) work[k] = v;
    }
    const combinerFeeds = [];
    const combinerInputs = {};
    for (const [key, p] of Object.entries(state.placements || {})) {
        if (p !== 'extractor') continue;
        const { col, row } = factoryKeyToColRow(key);
        const resId = factoryCellResourceId(state, col, row);
        if (!resId) continue;
        for (let dir = 0; dir < 4; dir++) {
            const nb = factoryNeighborColRow(col, row, dir);
            if (!factoryInBounds(state, nb.col, nb.row)) continue;
            const tk = factoryPlacementKey(nb.col, nb.row);
            if (state.placements[tk] !== 'transporter') continue;
            if (work[tk]) continue;
            work[tk] = resId;
            break;
        }
    }
    const invDelta = {};
    for (const [key, p] of Object.entries(state.placements || {})) {
        if (p !== 'transporter') continue;
        const itemId = work[key];
        if (!itemId) continue;
        const { col, row } = factoryKeyToColRow(key);
        const dir = factoryTransporterDir(state, key);
        const nb = factoryNeighborColRow(col, row, dir);
        if (!factoryInBounds(state, nb.col, nb.row)) continue;
        const dest = factoryPlacementKey(nb.col, nb.row);
        const destPl = state.placements[dest];
        if (destPl === 'storage') {
            invDelta[itemId] = (invDelta[itemId] || 0) + 1;
            delete work[key];
        } else if (destPl === 'transporter' && !work[dest]) {
            work[dest] = itemId;
            delete work[key];
        } else if (destPl === 'combiner') {
            if (!combinerInputs[dest]) combinerInputs[dest] = [];
            combinerInputs[dest].push({ from: key, itemId });
            combinerFeeds.push({ from: key, to: dest, itemId });
        }
    }
    for (const k of Object.keys(combinerInputs)) {
        const arr = combinerInputs[k];
        if (!arr || arr.length < 2) continue;
        arr.sort((a, b) => a.from.localeCompare(b.from));
        const a = arr[0].itemId;
        const b = arr[1].itemId;
        const key = [a, b].sort().join('+');
        const resultId = recipeIndex[key];
        if (!resultId) {
            state.combinerDiscovery[k] = { a, b, comboKey: key };
            continue;
        }
        const { col, row } = factoryKeyToColRow(k);
        const outDir = factoryCombinerDir(state, k);
        const nb = factoryNeighborColRow(col, row, outDir);
        if (!factoryInBounds(state, nb.col, nb.row)) continue;
        const outKey = factoryPlacementKey(nb.col, nb.row);
        if (state.placements[outKey] !== 'transporter') continue;
        if (work[outKey]) continue;
        work[outKey] = resultId;
        for (const input of arr.slice(0, 2)) {
            delete work[input.from];
        }
    }
    state.cellItems = work;
    state.loopTick = (Number(state.loopTick || 0) | 0) + 1;
    return invDelta;
}

function tickAllFactories() {
    const now = Date.now();
    for (const [userId, st] of factoryStateByUser.entries()) {
        const runUntil = Number(st._factoryRunUntilAt || 0);
        if (!runUntil || runUntil <= 0) continue;
        if (now >= runUntil) {
            if (!st._factoryRunStoppedAtIso) {
                st._factoryRunStoppedAtIso = new Date(now).toISOString();
                st._factoryLastProducedPerMinute = st._factoryCurrentProducedPerMinute || {};
            }
            st._factoryRunUntilAt = 0;
            st._factoryRunStartedAt = 0;
            persistFactoryState(userId, st);
            try {
                addFactorySnapshoot(db, userId, JSON.stringify(st));
            } catch (err) {
                console.warn(
                    `[factory-snapshoot] user=${Number(userId) | 0} err=${String(err && err.message ? err.message : err)}`
                );
            }
            factoryStateByUser.delete(userId);
            continue;
        }
        const elapsed = Math.max(0, now - Number(st._serverLastTickAt || now));
        st._serverLastTickAt = now;
        st._serverAccumulatorMs = Number(st._serverAccumulatorMs || 0) + elapsed;
        const stepMs = factoryLoopIntervalMs(st);
        let guard = 0;
        const totalDelta = {};
        while (st._serverAccumulatorMs >= stepMs && guard < 20) {
            st._serverAccumulatorMs -= stepMs;
            const delta = factoryStep(st) || {};
            for (const [itemId, qty] of Object.entries(delta)) {
                totalDelta[itemId] = (totalDelta[itemId] || 0) + (Number(qty) | 0);
            }
            guard++;
        }
        if (Object.keys(totalDelta).length) {
            // Persist produced items immediately to DB inventory (server-authoritative).
            addToUserInventory(db, Number(userId) | 0, totalDelta);
            addProducedToMinuteStats(st, now, totalDelta);
        }
    }
}
setInterval(tickAllFactories, 100);

function sanitizeInventoryMap(raw) {
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

function persistFactoryState(userId, st) {
    const uid = Number(userId) | 0;
    if (!uid || !st || typeof st !== 'object') return;
    try {
        saveUserFactoryState(db, uid, JSON.stringify(st));
    } catch (err) {
        console.warn(`[factory-persist] user=${uid} err=${String(err && err.message ? err.message : err)}`);
    }
}

function getOrInitFactoryState(userId) {
    const uid = Number(userId) | 0;
    if (!uid) return defaultFactoryState();
    const fromMem = factoryStateByUser.get(uid);
    if (fromMem) return fromMem;
    let st = null;
    try {
        const stateJson = loadUserFactoryState(db, uid) || loadLatestFactorySnapshoot(db, uid);
        if (stateJson) {
            const parsed = parseBody(stateJson);
            if (parsed && typeof parsed === 'object') {
                st = sanitizeFactoryState(parsed);
            }
        }
    } catch (err) {
        console.warn(`[factory-load] user=${uid} err=${String(err && err.message ? err.message : err)}`);
    }
    if (!st) st = defaultFactoryState();
    factoryStateByUser.set(uid, st);
    return st;
}

function factoryClientSnapshot(state) {
    return {
        placements: state.placements || {},
        selectedBuilding: state.selectedBuilding || null,
        cellResources: state.cellResources || {},
        transporterDirs: state.transporterDirs || {},
        sizeUpgradeLevel: Number(state.sizeUpgradeLevel || 0) | 0,
        loopMs: factoryLoopIntervalMs(state),
        loopTick: Number(state.loopTick || 0) | 0,
        cellItems: state.cellItems || {},
        loopPulseUntil: 0,
        combinerDirs: state.combinerDirs || {},
        combinerDiscovery: state.combinerDiscovery || {},
        factoryDiscoveryCombinerKey: state.factoryDiscoveryCombinerKey || null,
        itemSlides: {},
        beltDragPreview: null,
        cellRejectFlashUntil: state.cellRejectFlashUntil || {},
        cameraX: Number(state.cameraX || 0),
        cameraY: Number(state.cameraY || 0),
        cameraZoom: Number(state.cameraZoom || 1)
    };
}

async function ensureImagesDir() {
    await fs.promises.mkdir(imagesRoot, { recursive: true });
}

const MAX_USER_ICON_PNG_JPG_BYTES = 20 * 1024;
const MAX_USER_ICON_GIF_BYTES = 120 * 1024;
const ICON_SIZE_PX = 48;
function imageExtFromBuffer(buf) {
    if (!buf || buf.length < 4) return null;
    if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return '.jpg';
    if (buf.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return '.png';
    if (buf.length >= 6 && buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x38) return '.gif';
    if (
        buf.length >= 12 &&
        buf[0] === 0x52 &&
        buf[1] === 0x49 &&
        buf[2] === 0x46 &&
        buf[3] === 0x46 &&
        buf[8] === 0x57 &&
        buf[9] === 0x45 &&
        buf[10] === 0x42 &&
        buf[11] === 0x50
    ) {
        return '.webp';
    }
    // SVG can include XML/BOM/whitespace; detect "<svg" in first chunk.
    const probe = buf.slice(0, Math.min(buf.length, 512)).toString('utf8').replace(/^\uFEFF/, '').trimStart();
    if (/^<svg[\s>]/i.test(probe) || /^<\?xml[\s\S]*?<svg[\s>]/i.test(probe)) return '.svg';
    return null;
}

/**
 * Force icon file to fixed 48x48 px.
 * Keeps GIF as GIF (animated) when possible.
 * @param {Buffer} buf
 * @param {string} ext
 * @returns {Promise<{ buf: Buffer, ext: string }>}
 */
async function forceIconSize48(buf, ext) {
    if (!buf) return { buf, ext };
    try {
        if (ext === '.gif') {
            const outGif = await sharp(buf, { animated: true, limitInputPixels: false })
                .resize(ICON_SIZE_PX, ICON_SIZE_PX, {
                    fit: 'contain',
                    background: { r: 0, g: 0, b: 0, alpha: 0 }
                })
                .gif()
                .toBuffer();
            return { buf: outGif, ext: '.gif' };
        }
        const outPng = await sharp(buf, { animated: false, limitInputPixels: false })
            .resize(ICON_SIZE_PX, ICON_SIZE_PX, {
                fit: 'contain',
                background: { r: 0, g: 0, b: 0, alpha: 0 }
            })
            .png()
            .toBuffer();
        return { buf: outPng, ext: '.png' };
    } catch {
        return { buf, ext };
    }
}

function decodeDataUrlToBuffer(dataUrl) {
    const raw = String(dataUrl || '').trim();
    const m = raw.match(/^data:([^;,]+)?;base64,([a-zA-Z0-9+/=]+)$/);
    if (!m) return null;
    try {
        return Buffer.from(m[2], 'base64');
    } catch {
        return null;
    }
}

function validateStrictUserIconBytes(buf, ext) {
    if (!buf || !ext) return 'Image must be JPEG, PNG, or GIF.';
    if (ext === '.gif') {
        if (buf.length > MAX_USER_ICON_GIF_BYTES) {
            return `GIF must be ${MAX_USER_ICON_GIF_BYTES} bytes or smaller.`;
        }
        return null;
    }
    if (ext === '.png' || ext === '.jpg') {
        if (buf.length >= MAX_USER_ICON_PNG_JPG_BYTES) {
            return `PNG/JPG must be smaller than ${MAX_USER_ICON_PNG_JPG_BYTES} bytes.`;
        }
        return null;
    }
    return 'Image must be JPEG, PNG, or GIF.';
}

function isStrictHttpUrl(input) {
    try {
        const u = new URL(String(input || '').trim());
        return u.protocol === 'http:' || u.protocol === 'https:';
    } catch {
        return false;
    }
}

async function fetchIconBufferFromUrlOrData(imageUrl, imageDataUrl) {
    const dataUrl = String(imageDataUrl || '').trim();
    if (dataUrl) {
        const buf = decodeDataUrlToBuffer(dataUrl);
        if (!buf) throw new Error('Invalid imageDataUrl payload.');
        return buf;
    }
    const remote = String(imageUrl || '').trim();
    if (!remote || !isStrictHttpUrl(remote)) throw new Error('Use a valid http/https image URL.');
    const r = await fetch(remote);
    if (!r.ok) throw new Error(`Failed to fetch image: ${r.status}`);
    return Buffer.from(await r.arrayBuffer());
}

async function proxyOpenAI(req, res, target) {
    if (!OPENAI_KEY) {
        send(res, 500, 'Set OPENAI_API_KEY for dev-server.mjs', CORS_API);
        return;
    }
    const raw = await readRequestBody(req);
    const body = parseBody(raw);
    if (!body) {
        send(res, 400, 'Invalid JSON', CORS_API);
        return;
    }
    const r = await fetch(target, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${OPENAI_KEY}`
        },
        body: JSON.stringify(body)
    });
    const text = await r.text();
    res.writeHead(r.status, { 'Content-Type': 'application/json; charset=utf-8', ...CORS_API });
    res.end(text);
}

/**
 * Server-side DuckDuckGo image search (no browser CORS issues).
 * @param {string} query
 * @param {number} limit
 * @param {number} offset
 * @returns {Promise<string[]>}
 */
async function fetchDuckDuckGoImageCandidatesServer(query, limit, offset) {
    const q = String(query || '').trim();
    const max = Math.max(1, Math.min(12, Number(limit || 6) | 0));
    const start = Math.max(0, Number(offset || 0) | 0);
    if (!q) return [];
    const pageUrl = `https://duckduckgo.com/?q=${encodeURIComponent(q)}&iax=images&ia=images`;
    const pageRes = await fetch(pageUrl, {
        headers: {
            'User-Agent': 'Mozilla/5.0',
            Accept: 'text/html'
        }
    });
    if (!pageRes.ok) throw new Error(`DuckDuckGo page failed: ${pageRes.status}`);
    const pageHtml = await pageRes.text();
    const vqdMatch =
        pageHtml.match(/vqd=['"]([^'"]+)['"]/i) ||
        pageHtml.match(/vqd=([0-9-]+)\&/i) ||
        pageHtml.match(/"vqd"\s*:\s*"([^"]+)"/i);
    const vqd = vqdMatch && vqdMatch[1] ? String(vqdMatch[1]).trim() : '';
    if (!vqd) throw new Error('DuckDuckGo token missing in response.');
    const apiUrl =
        `https://duckduckgo.com/i.js?o=json&l=wt-wt&p=1` +
        `&q=${encodeURIComponent(q)}&vqd=${encodeURIComponent(vqd)}` +
        `&s=${start}`;
    const imgRes = await fetch(apiUrl, {
        headers: {
            'User-Agent': 'Mozilla/5.0',
            Accept: 'application/json',
            Referer: 'https://duckduckgo.com/'
        }
    });
    if (!imgRes.ok) throw new Error(`DuckDuckGo images failed: ${imgRes.status}`);
    const payload = await imgRes.json();
    const rows = Array.isArray(payload && payload.results) ? payload.results : [];
    const out = [];
    const seen = new Set();
    for (const row of rows) {
        const u = row && typeof row.image === 'string' ? row.image.trim() : '';
        if (!u || seen.has(u)) continue;
        seen.add(u);
        out.push(u);
        if (out.length >= max) break;
    }
    return out;
}

/** @param {string} raw */
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
            return JSON.parse(s.replace(/,\s*([}\]])/g, '$1'));
        } catch {
            return null;
        }
    }
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

/** @param {string} raw */
function stripEmojiClusters(raw) {
    return String(raw || '')
        .replace(
            /(?:\p{Extended_Pictographic}(?:\u200D\p{Extended_Pictographic})*[\uFE0F\u{1F3FB}-\u{1F3FF}]?)/gu,
            ''
        )
        .replace(/\s+/g, ' ')
        .trim();
}

/**
 * @param {unknown[]} propositions
 * @returns {{ name: string, emoji: string }[]}
 */
function parseDiscoveryPropositions(propositions) {
    const out = [];
    const seen = new Set();
    for (const p of propositions) {
        let rawName = '';
        let rawEmoji = '';
        if (typeof p === 'string') {
            rawName = stripEmojiClusters(p);
            rawEmoji = normalizeSuggestionEmoji(p);
        } else if (p && typeof p === 'object') {
            rawName = String(p.name ?? '').trim();
            rawEmoji = String(p.emoji ?? '').trim();
            if (!rawName && typeof p.label === 'string') {
                rawName = stripEmojiClusters(p.label);
                if (!rawEmoji) rawEmoji = normalizeSuggestionEmoji(p.label);
            }
        }
        const words = stripEmojiClusters(rawName).split(/\s+/).filter(Boolean);
        const name = words.slice(0, 2).join(' ');
        if (!name) continue;
        const key = name.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({ name, emoji: normalizeSuggestionEmoji(rawEmoji) || '✨' });
        if (out.length >= 6) break;
    }
    return out;
}

/**
 * @param {{ itemA: { name: string }, itemB: { name: string } }} input
 * @returns {{ messages: { role: string, content: string }[] }}
 */
function composeDiscoverySuggestionRequest(input) {
    const itemName1 = String(input?.itemA?.name || '').trim() || 'Item A';
    const itemName2 = String(input?.itemB?.name || '').trim() || 'Item B';
    const userPrompt =
        `Give exactly six name ideas for an industry based/civilization/economic game.\n\n` +
        `What in factory can be built using only or mainly "${itemName1}" and "${itemName2}"??\n\n` +
        `Use one word when possible; two words are allowed only when necessary.\n` +
        `MUST BE ONE OF THESE - resource,material,tool,item,element,part, prop.\n` +
        `cant be building planet or abstract.\n\n` +
        `Each proposition must include one fitting emoji.\n\n` +
        `Reply in JSON only (no markdown fences, no text outside the object), using this exact shape:\n` +
        `{\n` +
        `  "explanation": "Short optional note (e.g. theme of the names).",\n` +
        `  "propositions": [\n` +
        `    { "name": "Mud", "emoji": "🟤" },\n` +
        `    { "name": "Clay", "emoji": "🧱" },\n` +
        `    { "name": "Iron Ingot", "emoji": "⚙️" },\n` +
        `    { "name": "Stone Axe", "emoji": "🪓" },\n` +
        `    { "name": "Raft", "emoji": "🛶" },\n` +
        `    { "name": "Peat", "emoji": "🪵" }\n` +
        `  ]\n` +
        `}\n\n` +
        `Rules:\n` +
        `- propositions must contain exactly six distinct entries\n` +
        `- each entry must have:\n` +
        `  - "name": 1-2 words\n` +
        `  - "emoji": exactly one fitting emoji`;
    const systemContent =
        'Reply with a single valid JSON object only. Keys: explanation (string), propositions (array of exactly six objects: { name, emoji }). name must be 1-2 words (prefer one word; no long phrases). emoji must be a fitting emoji. No verdict or boolean about validity.';
    return {
        messages: [
            { role: 'system', content: systemContent },
            { role: 'user', content: userPrompt }
        ]
    };
}

/**
 * @param {{ itemA: { name: string }, itemB: { name: string } }} input
 * @returns {Promise<{ suggestions: { name: string, emoji: string }[], explanation: string, makesenceYes: boolean | null }>}
 */
async function fetchDiscoverySuggestions(input) {
    if (!OPENAI_KEY) throw new Error('Set key.txt (or OPENAI_API_KEY) for discovery suggestions.');
    const req = composeDiscoverySuggestionRequest(input);
    const r = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${OPENAI_KEY}`
        },
        body: JSON.stringify({
            model: 'gpt-4o-mini',
            temperature: 0.75,
            messages: req.messages
        })
    });
    const text = await r.text();
    if (!r.ok) throw new Error(text || `${r.status} ${r.statusText}`);
    const payload = parseBody(text);
    const content = payload?.choices?.[0]?.message?.content;
    const obj = extractJsonObjectFromAiReply(content || '');
    const props = Array.isArray(obj?.propositions) ? obj.propositions : [];
    const suggestions = parseDiscoveryPropositions(props);
    const explanation = typeof obj?.explanation === 'string' ? stripEmojiClusters(obj.explanation) : '';
    return { suggestions, explanation, makesenceYes: null };
}

/**
 * Remove AI suggestions that already exist in DB by name.
 * @param {{ name: string, emoji: string }[]} suggestions
 * @returns {{ name: string, emoji: string }[]}
 */
function filterExistingSuggestionNames(suggestions) {
    if (!Array.isArray(suggestions) || suggestions.length < 1) return [];
    return suggestions.filter((s) => {
        const name = s && typeof s.name === 'string' ? s.name.trim() : '';
        if (!name) return false;
        const existing = findItemByName(db, name);
        return !existing;
    });
}

function staticFileFromRoot(urlPath, root) {
    const rel = urlPath.replace(/^\//, '').replace(/\.\./g, '');
    const filePath = path.resolve(root, rel);
    const relSafe = path.relative(root, filePath);
    if (relSafe.startsWith('..') || path.isAbsolute(relSafe)) return null;
    return filePath;
}

function serveFile(res, filePath) {
    fs.readFile(filePath, (err, data) => {
        if (err) {
            send(res, 404, 'Not found');
            return;
        }
        res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream' });
        res.end(data);
    });
}

function isSafeSqlIdentifier(name) {
    return /^[A-Za-z_][A-Za-z0-9_]*$/.test(String(name || ''));
}

function quoteSqlIdentifier(name) {
    return `"${String(name).replace(/"/g, '""')}"`;
}

function listUserTables(dbConn) {
    const rows = dbConn
        .prepare(
            `SELECT name
             FROM sqlite_master
             WHERE type = 'table'
               AND name NOT LIKE 'sqlite_%'
             ORDER BY name COLLATE NOCASE`
        )
        .all();
    return rows.map((r) => String(r.name || '')).filter(Boolean);
}

function tableColumnsInfo(dbConn, tableName) {
    if (!isSafeSqlIdentifier(tableName)) return [];
    const sql = `PRAGMA table_info(${quoteSqlIdentifier(tableName)})`;
    return dbConn.prepare(sql).all();
}

function tableExists(dbConn, tableName) {
    if (!isSafeSqlIdentifier(tableName)) return false;
    const row = dbConn
        .prepare(
            `SELECT 1 AS x
             FROM sqlite_master
             WHERE type = 'table'
               AND name = ?
             LIMIT 1`
        )
        .get(String(tableName));
    return !!row;
}

function readTableRows(dbConn, tableName, limitRaw, offsetRaw) {
    if (!tableExists(dbConn, tableName)) throw new Error('table not found');
    const cols = tableColumnsInfo(dbConn, tableName);
    const colNames = cols.map((c) => String(c.name || '')).filter(Boolean);
    const primaryKey = cols.filter((c) => Number(c.pk) > 0).sort((a, b) => Number(a.pk) - Number(b.pk)).map((c) => String(c.name));
    const limit = Math.max(1, Math.min(500, Number(limitRaw || 100) | 0));
    const offset = Math.max(0, Number(offsetRaw || 0) | 0);
    const qTable = quoteSqlIdentifier(tableName);
    let rows = [];
    let hasRowid = false;
    try {
        rows = dbConn
            .prepare(`SELECT rowid AS __rowid, * FROM ${qTable} LIMIT @lim OFFSET @off`)
            .all({ lim: limit, off: offset });
        hasRowid = true;
    } catch {
        rows = dbConn
            .prepare(`SELECT * FROM ${qTable} LIMIT @lim OFFSET @off`)
            .all({ lim: limit, off: offset });
        hasRowid = false;
    }
    const totalRow = dbConn.prepare(`SELECT COUNT(*) AS c FROM ${qTable}`).get();
    const total = Number((totalRow && totalRow.c) || 0) | 0;
    return { columns: colNames, primaryKey, rows, hasRowid, limit, offset, total };
}

function deleteTableRow(dbConn, tableName, rowidRaw, pkObj) {
    if (!tableExists(dbConn, tableName)) return 0;
    const cols = tableColumnsInfo(dbConn, tableName);
    const colNames = new Set(cols.map((c) => String(c.name || '')).filter(Boolean));
    const primaryKey = cols.filter((c) => Number(c.pk) > 0).sort((a, b) => Number(a.pk) - Number(b.pk)).map((c) => String(c.name));
    const qTable = quoteSqlIdentifier(tableName);
    if (primaryKey.length > 0 && pkObj && typeof pkObj === 'object') {
        const whereParts = [];
        const params = {};
        for (const col of primaryKey) {
            if (!Object.prototype.hasOwnProperty.call(pkObj, col)) {
                return 0;
            }
            if (!colNames.has(col)) return 0;
            whereParts.push(`${quoteSqlIdentifier(col)} = @${col}`);
            params[col] = pkObj[col];
        }
        if (!whereParts.length) return 0;
        const out = dbConn.prepare(`DELETE FROM ${qTable} WHERE ${whereParts.join(' AND ')}`).run(params);
        return Number(out.changes || 0) | 0;
    }
    if (rowidRaw === undefined || rowidRaw === null || rowidRaw === '') return 0;
    const rowid = Number(rowidRaw);
    if (!Number.isFinite(rowid)) return 0;
    const out = dbConn.prepare(`DELETE FROM ${qTable} WHERE rowid = @rowid`).run({ rowid });
    return Number(out.changes || 0) | 0;
}

const server = http.createServer((req, res) => {
    const pathOnly = req.url.split('?')[0];
    if (req.method === 'OPTIONS' && pathOnly.startsWith('/api/')) {
        res.writeHead(204, CORS_API);
        res.end();
        return;
    }

    if (req.method === 'GET' && pathOnly === '/api/items') {
        try {
            sendJson(res, 200, { items: getItemsMap(db) }, { 'Cache-Control': 'no-store', ...CORS_API });
        } catch (err) {
            console.error(err);
            send(res, 500, String(err.message || err), CORS_API);
        }
        return;
    }

    if (req.method === 'GET' && pathOnly === '/api/db/tables') {
        const auth = authenticate(req);
        if (!auth) return send(res, 401, 'unauthorized', CORS_API);
        try {
            const tables = listUserTables(db);
            sendJson(res, 200, { tables }, CORS_API);
        } catch (err) {
            send(res, 500, String(err.message || err), CORS_API);
        }
        return;
    }

    if (req.method === 'POST' && pathOnly === '/api/db/table') {
        const auth = authenticate(req);
        if (!auth) return send(res, 401, 'unauthorized', CORS_API);
        readRequestBody(req)
            .then((raw) => {
                const body = parseBody(raw);
                if (!body) return send(res, 400, 'Invalid JSON', CORS_API);
                const table = typeof body.table === 'string' ? body.table.trim() : '';
                if (!table) return send(res, 400, 'table required', CORS_API);
                const out = readTableRows(db, table, body.limit, body.offset);
                sendJson(res, 200, { table, ...out }, CORS_API);
            })
            .catch((err) => send(res, 500, String(err.message || err), CORS_API));
        return;
    }

    if (req.method === 'POST' && pathOnly === '/api/db/delete-row') {
        const auth = authenticate(req);
        if (!auth) return send(res, 401, 'unauthorized', CORS_API);
        readRequestBody(req)
            .then((raw) => {
                const body = parseBody(raw);
                if (!body) return send(res, 400, 'Invalid JSON', CORS_API);
                const table = typeof body.table === 'string' ? body.table.trim() : '';
                if (!table) return send(res, 400, 'table required', CORS_API);
                const changes = deleteTableRow(db, table, body.rowid, body.pk);
                if (changes < 1) return send(res, 404, 'row not found', CORS_API);
                recipeIndex = buildRecipeIndex(getItemsMap(db));
                sendJson(res, 200, { ok: true, changes }, CORS_API);
            })
            .catch((err) => send(res, 500, String(err.message || err), CORS_API));
        return;
    }

    if (req.method === 'POST' && pathOnly === '/api/auth/register') {
        readRequestBody(req)
            .then((raw) => {
                const body = parseBody(raw);
                if (!body) return send(res, 400, 'Invalid JSON', CORS_API);
                const username = normalizeUsername(body.username);
                const password = String(body.password || '');
                if (!username || password.length < 4) {
                    return send(res, 400, 'username required; password min 4 chars', CORS_API);
                }
                const salt = randomTokenHex(16);
                const user = createUser(db, {
                    username,
                    passwordHash: passwordHash(password, salt),
                    passwordSalt: salt
                });
                if (!user) return send(res, 409, 'username already exists', CORS_API);
                const token = randomTokenHex(32);
                upsertSession(db, { tokenHash: sha256Hex(token), userId: user.id, expiresAtIso: sessionExpiryIso() });
                getOrInitFactoryState(user.id);
                sendJson(
                    res,
                    200,
                    {
                        ok: true,
                        token,
                        username: user.username,
                        inventory: getUserInventoryMap(db, user.id),
                        lastSeen: new Date().toISOString()
                    },
                    CORS_API
                );
            })
            .catch((err) => send(res, 500, String(err.message || err), CORS_API));
        return;
    }

    if (req.method === 'POST' && pathOnly === '/api/auth/login') {
        readRequestBody(req)
            .then((raw) => {
                const body = parseBody(raw);
                if (!body) return send(res, 400, 'Invalid JSON', CORS_API);
                const username = normalizeUsername(body.username);
                const password = String(body.password || '');
                const user = getUserByUsername(db, username);
                if (!user) return send(res, 401, 'invalid credentials', CORS_API);
                const expected = passwordHash(password, user.password_salt);
                if (expected !== user.password_hash) return send(res, 401, 'invalid credentials', CORS_API);
                const token = randomTokenHex(32);
                upsertSession(db, {
                    tokenHash: sha256Hex(token),
                    userId: Number(user.id),
                    expiresAtIso: sessionExpiryIso()
                });
                getOrInitFactoryState(user.id);
                sendJson(
                    res,
                    200,
                    {
                        ok: true,
                        token,
                        username: user.username,
                        inventory: getUserInventoryMap(db, user.id),
                        lastSeen: new Date().toISOString()
                    },
                    CORS_API
                );
            })
            .catch((err) => send(res, 500, String(err.message || err), CORS_API));
        return;
    }

    if (req.method === 'POST' && pathOnly === '/api/auth/autologin') {
        const auth = authenticate(req);
        if (!auth) {
            send(res, 401, 'invalid session', CORS_API);
            return;
        }
        const user = getUserById(db, auth.userId);
        getOrInitFactoryState(auth.userId);
        sendJson(
            res,
            200,
            {
                ok: true,
                userId: auth.userId,
                username: user ? user.username : '',
                inventory: getUserInventoryMap(db, auth.userId),
                lastSeen: user && user.last_seen_at ? new Date(String(user.last_seen_at)).toISOString() : null
            },
            CORS_API
        );
        return;
    }

    if (req.method === 'POST' && pathOnly === '/api/player/ping') {
        const auth = authenticate(req);
        if (!auth) return send(res, 401, 'unauthorized', CORS_API);
        playerLastSeenAt.set(auth.userId, Date.now());
        sendJson(res, 200, { ok: true, timeoutMs: PLAYER_TIMEOUT_MS, serverNow: Date.now() }, CORS_API);
        return;
    }

    if (req.method === 'GET' && pathOnly === '/api/factory/runtime') {
        const auth = authenticate(req);
        if (!auth) return send(res, 401, 'unauthorized', CORS_API);
        const st = getOrInitFactoryState(auth.userId);
        sendJson(res, 200, { ok: true, serverNow: Date.now(), runtime: factoryRuntimeStatus(st) }, CORS_API);
        return;
    }

    if (req.method === 'POST' && pathOnly === '/api/inventory/open') {
        const auth = authenticate(req);
        if (!auth) return send(res, 401, 'unauthorized', CORS_API);
        const st = getOrInitFactoryState(auth.userId);
        const pending = sanitizeInventoryMap(st._factoryPendingProduced);
        const canGrant = Object.keys(pending).length > 0;
        let granted = {};
        if (canGrant) {
            addToUserInventory(db, auth.userId, pending);
            granted = pending;
            st._factoryPendingProduced = {};
            persistFactoryState(auth.userId, st);
            console.log(`[inventory-open grant] user=${auth.userId} granted=${JSON.stringify(granted)}`);
        }
        sendJson(
            res,
            200,
            {
                ok: true,
                inventory: getUserInventoryMap(db, auth.userId),
                granted,
                runtime: factoryRuntimeStatus(st)
            },
            CORS_API
        );
        return;
    }

    if (req.method === 'POST' && pathOnly === '/api/auth/logout') {
        const token = sessionTokenFromRequest(req);
        if (token) deleteSessionByTokenHash(db, sha256Hex(token));
        sendJson(res, 200, { ok: true }, CORS_API);
        return;
    }

    if (req.method === 'GET' && pathOnly === '/api/profile') {
        const auth = authenticate(req);
        if (!auth) return send(res, 401, 'unauthorized', CORS_API);
        const user = getUserById(db, auth.userId);
        if (!user) return send(res, 404, 'user not found', CORS_API);
        const topDiscoveries = listTopDiscoveriesByUser(db, auth.userId, 20);
        return sendJson(
            res,
            200,
            {
                username: String(user.username || ''),
                lastSeen: user.last_seen_at ? new Date(String(user.last_seen_at)).toISOString() : null,
                topDiscoveries
            },
            CORS_API
        );
    }

    if (req.method === 'GET' && pathOnly === '/api/factory/state') {
        const auth = authenticate(req);
        if (!auth) return send(res, 401, 'unauthorized', CORS_API);
        const st = getOrInitFactoryState(auth.userId);
        sendJson(
            res,
            200,
            { factory: factoryClientSnapshot(st), inventory: getUserInventoryMap(db, auth.userId), runtime: factoryRuntimeStatus(st) },
            { 'Cache-Control': 'no-store', ...CORS_API }
        );
        return;
    }

    if (req.method === 'POST' && pathOnly === '/api/factory/state') {
        const auth = authenticate(req);
        if (!auth) return send(res, 401, 'unauthorized', CORS_API);
        readRequestBody(req)
            .then((raw) => {
                const body = parseBody(raw);
                if (!body || typeof body.factory !== 'object' || !body.factory) {
                    return send(res, 400, 'factory required', CORS_API);
                }
                const prev = getOrInitFactoryState(auth.userId);
                const st = sanitizeFactoryState(body.factory);
                st._factoryPendingProduced = sanitizeInventoryMap(prev._factoryPendingProduced);
                st._factoryRunStoppedAtIso = prev._factoryRunStoppedAtIso || null;
                st._factoryCurrentProducedPerMinute =
                    prev._factoryCurrentProducedPerMinute && typeof prev._factoryCurrentProducedPerMinute === 'object'
                        ? { ...prev._factoryCurrentProducedPerMinute }
                        : {};
                st._factoryLastProducedPerMinute =
                    prev._factoryLastProducedPerMinute && typeof prev._factoryLastProducedPerMinute === 'object'
                        ? { ...prev._factoryLastProducedPerMinute }
                        : {};
                activateFactoryRunWindow(st, Date.now());
                factoryStateByUser.set(auth.userId, st);
                persistFactoryState(auth.userId, st);
                sendJson(
                    res,
                    200,
                    {
                        ok: true,
                        inventory: sanitizeInventoryMap(getUserInventoryMap(db, auth.userId)),
                        runtime: factoryRuntimeStatus(st)
                    },
                    CORS_API
                );
            })
            .catch((err) => send(res, 500, String(err.message || err), CORS_API));
        return;
    }

    if (req.method === 'GET' && pathOnly === '/api/rejected-crafts/check') {
        try {
            const u = new URL(req.url, 'http://127.0.0.1');
            const a = (u.searchParams.get('a') || '').trim();
            const b = (u.searchParams.get('b') || '').trim();
            if (!a || !b) return send(res, 400, 'query params a and b required', CORS_API);
            sendJson(res, 200, { rejected: isRejectedCraft(db, a, b) }, CORS_API);
        } catch (err) {
            send(res, 500, String(err.message || err), CORS_API);
        }
        return;
    }

    if (req.method === 'POST' && pathOnly === '/api/combine/check') {
        readRequestBody(req)
            .then((raw) => {
                const body = parseBody(raw);
                if (!body) return send(res, 400, 'Invalid JSON', CORS_API);
                const idA = typeof body.item_a_id === 'string' ? body.item_a_id.trim() : '';
                const idB = typeof body.item_b_id === 'string' ? body.item_b_id.trim() : '';
                if (!idA || !idB) return send(res, 400, 'item_a_id and item_b_id required', CORS_API);
                const rejected = isRejectedCraft(db, idA, idB);
                if (rejected) {
                    return sendJson(
                        res,
                        200,
                        {
                            exists: false,
                            rejected: true,
                            message: 'This combination is rejected globally.',
                            item: null
                        },
                        CORS_API
                    );
                }
                const comboKey = [idA, idB].sort().join('+');
                const resultId = recipeIndex[comboKey];
                if (!resultId) {
                    return sendJson(
                        res,
                        200,
                        {
                            exists: false,
                            rejected: false,
                            message: 'No discovery exists for this pair yet.',
                            item: null
                        },
                        CORS_API
                    );
                }
                const items = getItemsMap(db);
                const def = items[resultId];
                if (!def || typeof def !== 'object') {
                    return sendJson(
                        res,
                        200,
                        {
                            exists: false,
                            rejected: false,
                            message: 'Recipe found but item record missing.',
                            item: null
                        },
                        CORS_API
                    );
                }
                return sendJson(
                    res,
                    200,
                    {
                        exists: true,
                        rejected: false,
                        message: 'Known discovery found.',
                        item: {
                            id: resultId,
                            emoji: typeof def.emoji === 'string' ? def.emoji : '✨',
                            name: typeof def.name === 'string' ? def.name : resultId,
                            a: typeof def.a === 'string' ? def.a : '',
                            b: typeof def.b === 'string' ? def.b : '',
                            nameColor: typeof def.nameColor === 'string' ? def.nameColor : '',
                            iconPath: typeof def.iconPath === 'string' ? def.iconPath : '',
                            discoveredAt: typeof def.discoveredAt === 'string' ? def.discoveredAt : ''
                        }
                    },
                    CORS_API
                );
            })
            .catch((err) => send(res, 500, String(err.message || err), CORS_API));
        return;
    }

    if (req.method === 'POST' && pathOnly === '/api/rejected-crafts') {
        readRequestBody(req)
            .then((raw) => {
                const body = parseBody(raw);
                if (!body) return send(res, 400, 'Invalid JSON', CORS_API);
                const idA = typeof body.item_a_id === 'string' ? body.item_a_id.trim() : '';
                const idB = typeof body.item_b_id === 'string' ? body.item_b_id.trim() : '';
                if (!idA || !idB) return send(res, 400, 'item_a_id and item_b_id required', CORS_API);
                recordRejectedCraft(db, idA, idB);
                res.writeHead(204, CORS_API);
                res.end();
            })
            .catch((err) => send(res, 500, String(err.message || err), CORS_API));
        return;
    }

    if (req.method === 'POST' && pathOnly === '/api/chat') {
        proxyOpenAI(req, res, 'https://api.openai.com/v1/chat/completions').catch((err) => {
            send(res, 500, String(err.message || err), CORS_API);
        });
        return;
    }

    if (req.method === 'POST' && pathOnly === '/api/discovery/suggestions') {
        readRequestBody(req)
            .then(async (raw) => {
                const body = parseBody(raw);
                if (!body) return send(res, 400, 'Invalid JSON', CORS_API);
                const aName = String(body?.itemA?.name || '').trim();
                const bName = String(body?.itemB?.name || '').trim();
                if (!aName || !bName) return send(res, 400, 'itemA.name and itemB.name required', CORS_API);
                const out = await fetchDiscoverySuggestions({
                    itemA: { name: aName },
                    itemB: { name: bName }
                });
                out.suggestions = filterExistingSuggestionNames(out.suggestions);
                sendJson(res, 200, out, CORS_API);
            })
            .catch((err) => send(res, 500, String(err.message || err), CORS_API));
        return;
    }

    if (req.method === 'POST' && pathOnly === '/api/images') {
        proxyOpenAI(req, res, 'https://api.openai.com/v1/images/generations').catch((err) => {
            send(res, 500, String(err.message || err), CORS_API);
        });
        return;
    }

    if (req.method === 'POST' && pathOnly === '/api/images/search') {
        readRequestBody(req)
            .then(async (raw) => {
                const body = parseBody(raw);
                if (!body) return send(res, 400, 'Invalid JSON', CORS_API);
                const query = typeof body.query === 'string' ? body.query.trim() : '';
                const limitRaw = Number(body.limit);
                const offsetRaw = Number(body.offset);
                const limit = Number.isFinite(limitRaw) ? limitRaw : 6;
                const offset = Number.isFinite(offsetRaw) ? offsetRaw : 0;
                if (!query) return send(res, 400, 'query required', CORS_API);
                const images = await fetchDuckDuckGoImageCandidatesServer(query, limit, offset);
                sendJson(res, 200, { images }, CORS_API);
            })
            .catch((err) => send(res, 500, String(err.message || err), CORS_API));
        return;
    }

    if (req.method === 'POST' && pathOnly === '/api/items/upsert') {
        const auth = authenticate(req);
        if (!auth) return send(res, 401, 'unauthorized', CORS_API);
        readRequestBody(req)
            .then((raw) => {
                const body = parseBody(raw);
                if (!body) return send(res, 400, 'Invalid JSON', CORS_API);
                const id = typeof body.id === 'string' ? body.id.trim() : '';
                const emoji = typeof body.emoji === 'string' ? body.emoji : '';
                const name = typeof body.name === 'string' ? body.name.trim() : '';
                const name_color =
                    typeof body.name_color === 'string' && /^#[0-9a-fA-F]{6}$/.test(body.name_color.trim())
                        ? body.name_color.trim().toLowerCase()
                        : '';
                const ingredient_a = typeof body.ingredient_a === 'string' ? body.ingredient_a.trim() : '';
                const ingredient_b = typeof body.ingredient_b === 'string' ? body.ingredient_b.trim() : '';
                if (!id || !name) return send(res, 400, 'id and name required', CORS_API);
                const existing = findItemByName(db, name);
                if (existing && String(existing.id) !== id) {
                    return send(res, 409, 'item name already exists', CORS_API);
                }
                try {
                    upsertItem(db, {
                        id,
                        emoji: emoji || '✨',
                        name,
                        name_color,
                        ingredient_a: ingredient_a || '',
                        ingredient_b: ingredient_b || '',
                        discovered_by: auth.userId,
                        discovered_at: new Date().toISOString()
                    });
                } catch (err) {
                    const msg = String(err && err.message ? err.message : err);
                    if (/unique constraint failed:\s*items\.name/i.test(msg)) {
                        return send(res, 409, 'item name already exists', CORS_API);
                    }
                    throw err;
                }
                recipeIndex = buildRecipeIndex(getItemsMap(db));
                res.writeHead(204, CORS_API);
                res.end();
            })
            .catch((err) => send(res, 500, String(err.message || err), CORS_API));
        return;
    }

    if (req.method === 'POST' && pathOnly === '/api/items/delete-check') {
        const auth = authenticate(req);
        if (!auth) return send(res, 401, 'unauthorized', CORS_API);
        readRequestBody(req)
            .then((raw) => {
                const body = parseBody(raw);
                if (!body) return send(res, 400, 'Invalid JSON', CORS_API);
                const id = typeof body.id === 'string' ? body.id.trim() : '';
                if (!id) return send(res, 400, 'id required', CORS_API);
                const dependents = listDependentItems(db, id);
                sendJson(res, 200, { ok: true, id, dependents }, CORS_API);
            })
            .catch((err) => send(res, 500, String(err.message || err), CORS_API));
        return;
    }

    if (req.method === 'POST' && pathOnly === '/api/items/delete') {
        const auth = authenticate(req);
        if (!auth) return send(res, 401, 'unauthorized', CORS_API);
        readRequestBody(req)
            .then((raw) => {
                const body = parseBody(raw);
                if (!body) return send(res, 400, 'Invalid JSON', CORS_API);
                const id = typeof body.id === 'string' ? body.id.trim() : '';
                if (!id) return send(res, 400, 'id required', CORS_API);
                const dependents = listDependentItems(db, id);
                if (dependents.length > 0) {
                    return sendJson(
                        res,
                        409,
                        {
                            ok: false,
                            id,
                            dependents,
                            message: 'Item is required by other discoveries. Remove dependents first.'
                        },
                        CORS_API
                    );
                }
                const deleted = deleteItemById(db, id);
                if (!deleted) return send(res, 404, 'item not found', CORS_API);
                recipeIndex = buildRecipeIndex(getItemsMap(db));
                sendJson(res, 200, { ok: true, id }, CORS_API);
            })
            .catch((err) => send(res, 500, String(err.message || err), CORS_API));
        return;
    }

    if (req.method === 'POST' && pathOnly === '/api/items/vote') {
        readRequestBody(req)
            .then((raw) => {
                const body = parseBody(raw);
                if (!body) return send(res, 400, 'Invalid JSON', CORS_API);
                const id = typeof body.id === 'string' ? body.id.trim() : '';
                const vote = body.vote === 'down' ? 'down' : body.vote === 'up' ? 'up' : '';
                if (!id || !vote) return send(res, 400, 'id and vote required', CORS_API);
                const out = voteOnItem(db, id, vote);
                if (!out) return send(res, 409, 'Voting unavailable for this item.', CORS_API);
                sendJson(res, 200, { ok: true, id, upvotes: out.upvotes, downvotes: out.downvotes }, CORS_API);
            })
            .catch((err) => send(res, 500, String(err.message || err), CORS_API));
        return;
    }

    if (req.method === 'GET' && pathOnly === '/api/discovery-proposals') {
        const auth = authenticate(req);
        if (!auth) return send(res, 401, 'unauthorized', CORS_API);
        const u = new URL(req.url, 'http://localhost');
        const itemId = String(u.searchParams.get('itemId') || '').trim();
        if (!itemId) return send(res, 400, 'itemId required', CORS_API);
        const proposals = listDiscoveryProposalsByItem(db, itemId, auth.userId);
        return sendJson(res, 200, { itemId, proposals }, CORS_API);
    }

    if (req.method === 'POST' && pathOnly === '/api/discovery-proposals') {
        const auth = authenticate(req);
        if (!auth) return send(res, 401, 'unauthorized', CORS_API);
        readRequestBody(req)
            .then(async (raw) => {
                const body = parseBody(raw);
                if (!body) return send(res, 400, 'Invalid JSON', CORS_API);
                const itemId = typeof body.itemId === 'string' ? body.itemId.trim() : '';
                const proposalType =
                    body.proposalType === 'name' ? 'name' : body.proposalType === 'image' ? 'image' : '';
                if (!itemId || !proposalType) return send(res, 400, 'itemId and proposalType required', CORS_API);
                if (proposalType === 'name') {
                    const proposedName = typeof body.proposedName === 'string' ? body.proposedName.trim() : '';
                    if (!proposedName) return send(res, 400, 'proposedName required', CORS_API);
                    const out = createDiscoveryProposal(db, {
                        itemId,
                        proposalType: 'name',
                        proposedName,
                        createdBy: auth.userId
                    });
                    if (!out) return send(res, 409, 'Cannot create proposal for this item.', CORS_API);
                    return sendJson(res, 200, { ok: true, proposalId: out.id }, CORS_API);
                }
                const imageUrl = typeof body.imageUrl === 'string' ? body.imageUrl.trim() : '';
                const imageDataUrl = typeof body.imageDataUrl === 'string' ? body.imageDataUrl.trim() : '';
                await ensureImagesDir();
                const buf = await fetchIconBufferFromUrlOrData(imageUrl, imageDataUrl);
                const ext = imageExtFromBuffer(buf);
                if (!ext) return send(res, 400, 'Image must be JPEG, PNG, GIF, WEBP, or SVG.', CORS_API);
                const strictErr = validateStrictUserIconBytes(buf, ext);
                if (strictErr) return send(res, 413, strictErr, CORS_API);
                const safeItem = itemId.replace(/[^a-zA-Z0-9_-]/g, '_') || 'item';
                const rel = `images/proposals/${safeItem}_${Date.now()}_${Math.floor(Math.random() * 1e6)}${ext}`;
                await fs.promises.mkdir(path.dirname(path.join(__dirname, rel)), { recursive: true });
                await fs.promises.writeFile(path.join(__dirname, rel), buf);
                const out = createDiscoveryProposal(db, {
                    itemId,
                    proposalType: 'image',
                    proposedImagePath: rel,
                    createdBy: auth.userId
                });
                if (!out) return send(res, 409, 'Cannot create proposal for this item.', CORS_API);
                return sendJson(res, 200, { ok: true, proposalId: out.id, proposedImagePath: rel }, CORS_API);
            })
            .catch((err) => send(res, 500, String(err.message || err), CORS_API));
        return;
    }

    if (req.method === 'POST' && pathOnly === '/api/discovery-proposals/vote') {
        const auth = authenticate(req);
        if (!auth) return send(res, 401, 'unauthorized', CORS_API);
        readRequestBody(req)
            .then((raw) => {
                const body = parseBody(raw);
                if (!body) return send(res, 400, 'Invalid JSON', CORS_API);
                const proposalId = Number(body.proposalId || 0) | 0;
                const vote = body.vote === 'down' ? 'down' : body.vote === 'up' ? 'up' : '';
                if (!proposalId || !vote) return send(res, 400, 'proposalId and vote required', CORS_API);
                const out = voteOnDiscoveryProposal(db, proposalId, auth.userId, vote);
                if (!out) return send(res, 409, 'Voting unavailable for this proposal.', CORS_API);
                sendJson(res, 200, { ok: true, proposalId, ...out }, CORS_API);
            })
            .catch((err) => send(res, 500, String(err.message || err), CORS_API));
        return;
    }

    if (req.method === 'POST' && pathOnly === '/api/items/icon') {
        readRequestBody(req)
            .then(async (raw) => {
                const body = parseBody(raw);
                if (!body) return send(res, 400, 'Invalid JSON', CORS_API);
                const id = typeof body.id === 'string' ? body.id.trim() : '';
                const imageUrl = typeof body.imageUrl === 'string' ? body.imageUrl.trim() : '';
                const imageDataUrl = typeof body.imageDataUrl === 'string' ? body.imageDataUrl.trim() : '';
                const strictUserUrl = body.strictUserUrl === true;
                if (!id || (!imageUrl && !imageDataUrl)) {
                    return send(res, 400, 'id and imageUrl/imageDataUrl required', CORS_API);
                }
                await ensureImagesDir();
                const safe = id.replace(/[^a-zA-Z0-9_-]/g, '_') || 'item';
                let buf = await fetchIconBufferFromUrlOrData(imageUrl, imageDataUrl);
                let ext = imageExtFromBuffer(buf);
                if (!ext) return send(res, 400, 'Image must be JPEG, PNG, GIF, WEBP, or SVG.', CORS_API);
                if (strictUserUrl) {
                    const err = validateStrictUserIconBytes(buf, ext);
                    if (err) return send(res, 413, err, CORS_API);
                }
                const resized = await forceIconSize48(buf, ext);
                buf = resized.buf;
                ext = resized.ext;
                const rel = `images/${safe}${ext}`;
                await fs.promises.writeFile(path.join(__dirname, rel), buf);
                setItemIconPath(db, id, rel, buf.length);
                sendJson(res, 200, { ok: true, iconPath: rel }, CORS_API);
            })
            .catch((err) => send(res, 500, String(err.message || err), CORS_API));
        return;
    }

    if (req.method === 'GET' && pathOnly.startsWith('/images/')) {
        // Map URL "/images/foo.png" -> file under imagesRoot as "foo.png".
        const relImageUrlPath = `/${pathOnly.replace(/^\/images\/+/, '')}`;
        const filePath = staticFileFromRoot(relImageUrlPath, imagesRoot);
        if (!filePath) return send(res, 403, 'Forbidden');
        return serveFile(res, filePath);
    }

    let staticPath = pathOnly;
    if (staticPath === '/') staticPath = '/index.html';
    const filePath = staticFileFromRoot(staticPath, publicRoot);
    if (!filePath) return send(res, 403, 'Forbidden');
    serveFile(res, filePath);
});

server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
        console.error(`Port ${PORT} is already in use. Close the other app or run: netstat -ano | findstr :${PORT}`);
    } else {
        console.error(err);
    }
    process.exit(1);
});

server.listen(PORT, () => {
    console.log('Alchemic multiplayer server started.');
    console.log(`  http://127.0.0.1:${PORT}`);
    console.log(`  http://localhost:${PORT}`);
});
