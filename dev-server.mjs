import http from 'http';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import {
    openDb,
    getItemsMap,
    recordRejectedCraft,
    isRejectedCraft,
    upsertItem,
    setItemIconPath,
    createUser,
    getUserByUsername,
    getUserById,
    upsertSession,
    getSessionByTokenHash,
    deleteSessionByTokenHash,
    saveUserFactoryState,
    loadUserFactoryState
} from './db.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = 3456;
const OPENAI_KEY_HARDCODED =
    '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';
const OPENAI_KEY = String(process.env.OPENAI_API_KEY || OPENAI_KEY_HARDCODED || '').trim();
const SESSION_TTL_DAYS = 30;
const FACTORY_GRID_BASE = 8;
const FACTORY_LOOP_MS_DEFAULT = 500;
const MIN_FACTORY_LOOP_MS = 33;
const MAX_FACTORY_SIZE_LEVEL = 10;

const db = openDb();
const publicRoot = path.join(__dirname, 'public');
const imagesRoot = path.join(__dirname, 'images');

/** @type {Map<number, any>} */
const factoryStateByUser = new Map();
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
    return { userId: Number(session.user_id), token, tokenHash };
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
        _serverAccumulatorMs: 0
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
    return st;
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
        const resId = state.cellResources[key];
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
}

function tickAllFactories() {
    const now = Date.now();
    for (const st of factoryStateByUser.values()) {
        const elapsed = Math.max(0, now - Number(st._serverLastTickAt || now));
        st._serverLastTickAt = now;
        st._serverAccumulatorMs = Number(st._serverAccumulatorMs || 0) + elapsed;
        const stepMs = factoryLoopIntervalMs(st);
        let guard = 0;
        while (st._serverAccumulatorMs >= stepMs && guard < 20) {
            st._serverAccumulatorMs -= stepMs;
            factoryStep(st);
            guard++;
        }
    }
}
setInterval(tickAllFactories, 100);

function getOrInitFactoryState(userId) {
    const uid = Number(userId);
    const fromMem = factoryStateByUser.get(uid);
    if (fromMem) return fromMem;
    let st = null;
    const json = loadUserFactoryState(db, uid);
    if (json) {
        try {
            st = sanitizeFactoryState(JSON.parse(json));
        } catch {
            st = null;
        }
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

const MAX_USER_ICON_BYTES = 16 * 1024;
function imageExtFromBuffer(buf) {
    if (!buf || buf.length < 4) return null;
    if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return '.jpg';
    if (buf.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return '.png';
    if (buf.length >= 6 && buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x38) return '.gif';
    return null;
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
                sendJson(res, 200, { ok: true, token, username: user.username }, CORS_API);
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
                sendJson(res, 200, { ok: true, token, username: user.username }, CORS_API);
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
        sendJson(res, 200, { ok: true, userId: auth.userId, username: user ? user.username : '' }, CORS_API);
        return;
    }

    if (req.method === 'POST' && pathOnly === '/api/auth/logout') {
        const token = sessionTokenFromRequest(req);
        if (token) deleteSessionByTokenHash(db, sha256Hex(token));
        sendJson(res, 200, { ok: true }, CORS_API);
        return;
    }

    if (req.method === 'GET' && pathOnly === '/api/factory/state') {
        const auth = authenticate(req);
        if (!auth) return send(res, 401, 'unauthorized', CORS_API);
        const st = getOrInitFactoryState(auth.userId);
        sendJson(res, 200, { factory: factoryClientSnapshot(st) }, { 'Cache-Control': 'no-store', ...CORS_API });
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
                const st = sanitizeFactoryState(body.factory);
                factoryStateByUser.set(auth.userId, st);
                saveUserFactoryState(db, auth.userId, JSON.stringify(factoryClientSnapshot(st)));
                sendJson(res, 200, { ok: true }, CORS_API);
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

    if (req.method === 'POST' && pathOnly === '/api/images') {
        proxyOpenAI(req, res, 'https://api.openai.com/v1/images/generations').catch((err) => {
            send(res, 500, String(err.message || err), CORS_API);
        });
        return;
    }

    if (req.method === 'POST' && pathOnly === '/api/items/upsert') {
        readRequestBody(req)
            .then((raw) => {
                const body = parseBody(raw);
                if (!body) return send(res, 400, 'Invalid JSON', CORS_API);
                const id = typeof body.id === 'string' ? body.id.trim() : '';
                const emoji = typeof body.emoji === 'string' ? body.emoji : '';
                const name = typeof body.name === 'string' ? body.name.trim() : '';
                const ingredient_a = typeof body.ingredient_a === 'string' ? body.ingredient_a.trim() : '';
                const ingredient_b = typeof body.ingredient_b === 'string' ? body.ingredient_b.trim() : '';
                if (!id || !name) return send(res, 400, 'id and name required', CORS_API);
                upsertItem(db, {
                    id,
                    emoji: emoji || '✨',
                    name,
                    ingredient_a: ingredient_a || '',
                    ingredient_b: ingredient_b || ''
                });
                recipeIndex = buildRecipeIndex(getItemsMap(db));
                res.writeHead(204, CORS_API);
                res.end();
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
                const strictUserUrl = body.strictUserUrl === true;
                if (!id || !imageUrl) return send(res, 400, 'id and imageUrl required', CORS_API);
                await ensureImagesDir();
                const safe = id.replace(/[^a-zA-Z0-9_-]/g, '_') || 'item';
                const r = await fetch(imageUrl);
                if (!r.ok) return send(res, 502, `Failed to fetch image: ${r.status}`, CORS_API);
                const buf = Buffer.from(await r.arrayBuffer());
                let rel;
                if (strictUserUrl) {
                    if (buf.length > MAX_USER_ICON_BYTES) {
                        return send(
                            res,
                            413,
                            `Image must be ${MAX_USER_ICON_BYTES} bytes or smaller (JPEG, PNG, or GIF).`,
                            CORS_API
                        );
                    }
                    const ext = imageExtFromBuffer(buf);
                    if (!ext) return send(res, 400, 'Image must be JPEG, PNG, or GIF.', CORS_API);
                    rel = `images/${safe}${ext}`;
                } else {
                    rel = `images/${safe}.png`;
                }
                await fs.promises.writeFile(path.join(__dirname, rel), buf);
                setItemIconPath(db, id, rel);
                sendJson(res, 200, { ok: true, iconPath: rel }, CORS_API);
            })
            .catch((err) => send(res, 500, String(err.message || err), CORS_API));
        return;
    }

    if (req.method === 'GET' && pathOnly.startsWith('/images/')) {
        const filePath = staticFileFromRoot(pathOnly, imagesRoot);
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
