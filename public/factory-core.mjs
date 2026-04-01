export function factoryPlacementKey(col, row) {
    return `${col},${row}`;
}

export function factoryKeyToColRow(key) {
    const p = String(key || '').split(',');
    return { col: Number(p[0]), row: Number(p[1]) };
}

export function factoryNeighborColRow(col, row, dir) {
    const d = ((Number(dir) | 0) + 4) % 4;
    if (d === 0) return { col, row: row - 1 };
    if (d === 1) return { col: col + 1, row };
    if (d === 2) return { col, row: row + 1 };
    return { col: col - 1, row };
}

function directionFromTo(fromCol, fromRow, toCol, toRow) {
    const dc = (toCol | 0) - (fromCol | 0);
    const dr = (toRow | 0) - (fromRow | 0);
    if (dc === 0 && dr === -1) return 0;
    if (dc === 1 && dr === 0) return 1;
    if (dc === 0 && dr === 1) return 2;
    if (dc === -1 && dr === 0) return 3;
    return -1;
}

function canCombinerAcceptFrom(combinerKey, fromKey, getCombinerDir) {
    const c = factoryKeyToColRow(combinerKey);
    const f = factoryKeyToColRow(fromKey);
    if (!Number.isFinite(c.col) || !Number.isFinite(c.row) || !Number.isFinite(f.col) || !Number.isFinite(f.row)) {
        return false;
    }
    const incomingDir = directionFromTo(f.col, f.row, c.col, c.row);
    if (incomingDir < 0) return false;
    const outDir = ((Number(getCombinerDir(combinerKey)) | 0) + 4) % 4;
    return incomingDir === (outDir + 1) % 4 || incomingDir === (outDir + 3) % 4;
}

/**
 * Shared factory simulation tick.
 * Mutates state.cellItems / state.combinerDiscovery.
 */
export function simulateFactoryStep(state, deps) {
    const inBounds = deps.inBounds;
    const getResourceId = deps.getResourceId;
    const getTransporterDir = deps.getTransporterDir;
    const getCombinerDir = deps.getCombinerDir;
    const resolveRecipeId = deps.resolveRecipeId;

    const work = {};
    for (const [k, v] of Object.entries(state.cellItems || {})) {
        if (typeof v === 'string' && v) work[k] = v;
    }
    for (const k of Object.keys(state.combinerDiscovery || {})) delete work[k];

    const spawns = [];
    for (const [key, p] of Object.entries(state.placements || {})) {
        if (p !== 'extractor') continue;
        const cell = factoryKeyToColRow(key);
        const resId = getResourceId(cell.col, cell.row);
        if (!resId) continue;
        for (let dir = 0; dir < 4; dir++) {
            const nb = factoryNeighborColRow(cell.col, cell.row, dir);
            if (!inBounds(nb.col, nb.row)) continue;
            const tk = factoryPlacementKey(nb.col, nb.row);
            if (state.placements[tk] !== 'transporter') continue;
            if (work[tk]) continue;
            work[tk] = resId;
            spawns.push({ from: key, to: tk, itemId: resId });
        }
    }

    const deposits = [];
    const movesTT = [];
    const movesToEmptyCombiner = [];
    const combinerFeeds = [];

    for (const [key, p] of Object.entries(state.placements || {})) {
        if (p !== 'transporter') continue;
        const itemId = work[key];
        if (!itemId) continue;
        const cell = factoryKeyToColRow(key);
        const nb = factoryNeighborColRow(cell.col, cell.row, getTransporterDir(key));
        if (!inBounds(nb.col, nb.row)) continue;
        const destKey = factoryPlacementKey(nb.col, nb.row);
        const destPl = state.placements[destKey];
        if (destPl === 'storage') {
            deposits.push({ from: key, to: destKey, itemId });
        } else if (destPl === 'transporter' && !work[destKey]) {
            movesTT.push({ from: key, to: destKey, itemId });
        } else if (destPl === 'combiner') {
            if (state.combinerDiscovery && state.combinerDiscovery[destKey]) continue;
            if (!canCombinerAcceptFrom(destKey, key, getCombinerDir)) continue;
            if (!work[destKey]) movesToEmptyCombiner.push({ from: key, to: destKey, itemId });
            else if (work[destKey] !== itemId) combinerFeeds.push({ from: key, to: destKey, incoming: itemId });
        }
    }

    const invDelta = {};
    for (const dep of deposits) {
        if (!work[dep.from]) continue;
        delete work[dep.from];
        invDelta[dep.itemId] = (invDelta[dep.itemId] || 0) + 1;
    }

    const claimedDest = new Set();
    const claimedFrom = new Set();
    movesTT.sort((a, b) => a.from.localeCompare(b.from));
    for (const m of movesTT) {
        if (claimedDest.has(m.to) || claimedFrom.has(m.from)) continue;
        // Destination may have become occupied earlier in the tick; if so, wait.
        if (work[m.to]) continue;
        // Source may have been consumed/changed earlier in the tick; if so, skip.
        if (!work[m.from] || work[m.from] !== m.itemId) continue;
        claimedDest.add(m.to);
        claimedFrom.add(m.from);
        delete work[m.from];
        work[m.to] = m.itemId;
    }

    movesToEmptyCombiner.sort((a, b) => a.from.localeCompare(b.from));
    for (const m of movesToEmptyCombiner) {
        if (claimedDest.has(m.to) || claimedFrom.has(m.from)) continue;
        if (work[m.to]) continue;
        if (state.combinerDiscovery && state.combinerDiscovery[m.to]) continue;
        claimedDest.add(m.to);
        claimedFrom.add(m.from);
        delete work[m.from];
        work[m.to] = m.itemId;
    }

    const combined = [];
    combinerFeeds.sort((a, b) => a.from.localeCompare(b.from));
    const combinerDestClaimed = new Set();
    const combinerOutClaimed = new Set();
    for (const f of combinerFeeds) {
        if (!work[f.from] || work[f.from] !== f.incoming) continue;
        if (combinerDestClaimed.has(f.to)) continue;
        if (claimedFrom.has(f.from)) continue;
        const existing = work[f.to];
        if (!existing || existing === f.incoming) continue;
        if (state.combinerDiscovery && state.combinerDiscovery[f.to]) continue;
        const comboKey = [existing, f.incoming].sort().join('+');
        const resultId = resolveRecipeId(existing, f.incoming);
        if (resultId) {
            const c = factoryKeyToColRow(f.to);
            const nb = factoryNeighborColRow(c.col, c.row, getCombinerDir(f.to));
            if (!inBounds(nb.col, nb.row)) continue;
            const outKey = factoryPlacementKey(nb.col, nb.row);
            if (state.placements[outKey] !== 'transporter') continue;
            if (work[outKey]) continue;
            if (claimedDest.has(outKey) || combinerOutClaimed.has(outKey)) continue;
            combinerDestClaimed.add(f.to);
            claimedFrom.add(f.from);
            claimedDest.add(outKey);
            combinerOutClaimed.add(outKey);
            delete work[f.from];
            delete work[f.to];
            work[outKey] = resultId;
            combined.push({ combinerKey: f.to, a: existing, b: f.incoming, resultId, outKey });
        } else {
            combinerDestClaimed.add(f.to);
            claimedFrom.add(f.from);
            delete work[f.from];
            delete work[f.to];
            state.combinerDiscovery[f.to] = { a: existing, b: f.incoming, comboKey };
        }
    }

    const next = {};
    for (const [k, v] of Object.entries(work)) {
        if (!v) continue;
        if (state.placements[k] === 'storage') continue;
        next[k] = v;
    }
    state.cellItems = next;
    return { invDelta, deposits, combined, spawns, movesTT, movesToEmptyCombiner };
}
