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

function inputDirFromSourceToDest(fromCol, fromRow, toCol, toRow) {
    if (fromCol === toCol + 1 && fromRow === toRow) return 0; // right
    if (fromCol === toCol && fromRow === toRow - 1) return 1; // up
    if (fromCol === toCol - 1 && fromRow === toRow) return 2; // left
    if (fromCol === toCol && fromRow === toRow + 1) return 3; // down
    return -1;
}

function sourceColRowFromInputDir(destCol, destRow, inputDir) {
    const d = ((Number(inputDir) | 0) + 4) % 4;
    if (d === 0) return { col: destCol + 1, row: destRow };
    if (d === 1) return { col: destCol, row: destRow - 1 };
    if (d === 2) return { col: destCol - 1, row: destRow };
    return { col: destCol, row: destRow + 1 };
}

function inputDirFromTransporterOutputDir(outDir) {
    const d = ((Number(outDir) | 0) + 4) % 4;
    if (d === 0) return 1; // up
    if (d === 1) return 0; // right
    if (d === 2) return 3; // down
    return 2; // left
}

function ensureTransporterConflictState(state, getTransporterDir) {
    const signatureParts = [];
    const transporterKeys = Object.entries(state.placements || {})
        .filter(([, p]) => p === 'transporter')
        .map(([k]) => k)
        .sort();
    for (const key of transporterKeys) {
        signatureParts.push(`${key}:${getTransporterDir(key)}`);
    }
    const sig = signatureParts.join('|');
    if (state._ttConflictSig === sig && state._ttConflictInputs && state._ttInputCursor) return;

    const incomingByDest = {};
    for (const srcKey of transporterKeys) {
        const s = factoryKeyToColRow(srcKey);
        if (!Number.isFinite(s.col) || !Number.isFinite(s.row)) continue;
        const nb = factoryNeighborColRow(s.col, s.row, getTransporterDir(srcKey));
        const destKey = factoryPlacementKey(nb.col, nb.row);
        if (state.placements[destKey] !== 'transporter') continue;
        const d = factoryKeyToColRow(destKey);
        const inDir = inputDirFromSourceToDest(s.col, s.row, d.col, d.row);
        if (inDir < 0) continue;
        if (!incomingByDest[destKey]) incomingByDest[destKey] = [];
        incomingByDest[destKey].push(inDir);
    }
    const conflictInputs = {};
    for (const [destKey, dirs] of Object.entries(incomingByDest)) {
        const uniq = [...new Set(dirs)].sort((a, b) => a - b);
        if (uniq.length > 1) conflictInputs[destKey] = uniq;
    }

    const nextCursor = {};
    const prevCursor = state._ttInputCursor && typeof state._ttInputCursor === 'object' ? state._ttInputCursor : {};
    for (const destKey of Object.keys(conflictInputs)) {
        const prev = ((Number(prevCursor[destKey] || 0) | 0) + 4) % 4;
        const skipDir = inputDirFromTransporterOutputDir(getTransporterDir(destKey));
        let cur = prev;
        for (let i = 0; i < 4; i++) {
            if (cur !== skipDir) break;
            cur = (cur + 1) % 4;
        }
        nextCursor[destKey] = cur;
    }
    state._ttConflictSig = sig;
    state._ttConflictInputs = conflictInputs;
    state._ttInputCursor = nextCursor;
}

/**
 * Shared factory simulation tick.
 * Mutates state.cellItems / state.combinerDiscovery.
 */
export function simulateFactoryStep(state, deps) {
    const inBounds = deps.inBounds;
    const getResourceId = deps.getResourceId;
    const getTransporterDir = deps.getTransporterDir;
    const getSorterDir = deps.getSorterDir;
    const getBridgeDir = deps.getBridgeDir;
    const getCombinerDir = deps.getCombinerDir;
    const resolveRecipeId = deps.resolveRecipeId;
    const loopTick = Number(state.loopTick || 0) | 0;
    const sorterItemFilters =
        state.sorterItemFilters && typeof state.sorterItemFilters === 'object' ? state.sorterItemFilters : {};
    state.sorterItemFilters = sorterItemFilters;
    const rotateStart = (destKey, count, pass) => {
        let h = 0;
        const s = String(destKey || '');
        for (let i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0;
        return ((h + loopTick + pass) >>> 0) % Math.max(1, count);
    };
    ensureTransporterConflictState(state, getTransporterDir);

    const work = {};
    for (const [k, v] of Object.entries(state.cellItems || {})) {
        if (typeof v === 'string' && v) work[k] = v;
    }
    for (const k of Object.keys(state.combinerDiscovery || {})) delete work[k];

    const spawns = [];
    const spawnedThisTick = new Set();
    const extractorTick = (loopTick & 1) === 0;
    if (extractorTick) {
        for (const [key, p] of Object.entries(state.placements || {})) {
            if (p !== 'extractor') continue;
            const cell = factoryKeyToColRow(key);
            const resId = getResourceId(cell.col, cell.row);
            if (!resId) continue;
            for (let dir = 0; dir < 4; dir++) {
                const nb = factoryNeighborColRow(cell.col, cell.row, dir);
                if (!inBounds(nb.col, nb.row)) continue;
                const tk = factoryPlacementKey(nb.col, nb.row);
                if (state.placements[tk] !== 'transporter' && state.placements[tk] !== 'bridge') continue;
                if (work[tk]) continue;
                work[tk] = resId;
                spawnedThisTick.add(tk);
                spawns.push({ from: key, to: tk, itemId: resId });
            }
        }
    }

    const deposits = [];
    const sorterPulls = [];
    const bridgeMoves = [];
    const movesTTCandidates = [];
    const movesToEmptyCombinerCandidates = [];
    const movesTT = [];
    const movesToEmptyCombiner = [];
    const combinerFeeds = [];

    for (const [sorterKey, p] of Object.entries(state.placements || {})) {
        if (p !== 'sorter') continue;
        if (work[sorterKey]) continue;
        const sc = factoryKeyToColRow(sorterKey);
        if (!Number.isFinite(sc.col) || !Number.isFinite(sc.row)) continue;
        const sorterOutDir = getSorterDir(sorterKey);
        const filterId = typeof sorterItemFilters[sorterKey] === 'string' ? sorterItemFilters[sorterKey] : '';
        const picks = [];
        for (let dir = 0; dir < 4; dir++) {
            // Do not pull from the output side, prevents sorter self-feedback loops.
            if (dir === sorterOutDir) continue;
            const nb = factoryNeighborColRow(sc.col, sc.row, dir);
            if (!inBounds(nb.col, nb.row)) continue;
            const fromKey = factoryPlacementKey(nb.col, nb.row);
            if (state.placements[fromKey] !== 'transporter') continue;
            const itemId = work[fromKey];
            if (!itemId) continue;
            if (filterId && itemId !== filterId) continue;
            picks.push({ from: fromKey, itemId });
        }
        if (!picks.length) continue;
        picks.sort((a, b) => a.from.localeCompare(b.from));
        const start = rotateStart(sorterKey, picks.length, 0);
        let chosen = null;
        for (let i = 0; i < picks.length; i++) {
            const cand = picks[(start + i) % picks.length];
            if (!work[cand.from] || work[cand.from] !== cand.itemId) continue;
            chosen = cand;
            break;
        }
        if (!chosen) continue;
        delete work[chosen.from];
        work[sorterKey] = chosen.itemId;
        if (!filterId) sorterItemFilters[sorterKey] = chosen.itemId;
        sorterPulls.push({ from: chosen.from, to: sorterKey, itemId: chosen.itemId });
    }

    for (const [key, p] of Object.entries(state.placements || {})) {
        if (p !== 'transporter' && p !== 'sorter') continue;
        // Keep extractor output on its belt cell for one full tick to maintain visible spacing.
        if (spawnedThisTick.has(key)) continue;
        const itemId = work[key];
        if (!itemId) continue;
        const cell = factoryKeyToColRow(key);
        const outDir = p === 'sorter' ? getSorterDir(key) : getTransporterDir(key);
        const nb = factoryNeighborColRow(cell.col, cell.row, outDir);
        if (!inBounds(nb.col, nb.row)) continue;
        const destKey = factoryPlacementKey(nb.col, nb.row);
        const destPl = state.placements[destKey];
        if (destPl === 'storage') {
            deposits.push({ from: key, to: destKey, itemId });
        } else if (destPl === 'transporter' || destPl === 'sorter') {
            movesTTCandidates.push({ from: key, to: destKey, itemId });
        } else if (destPl === 'combiner') {
            if (state.combinerDiscovery && state.combinerDiscovery[destKey]) continue;
            if (!canCombinerAcceptFrom(destKey, key, getCombinerDir)) continue;
            if (!work[destKey]) movesToEmptyCombinerCandidates.push({ from: key, to: destKey, itemId });
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
    const acceptedFromByDest = {};
    const conflictInputs = state._ttConflictInputs && typeof state._ttConflictInputs === 'object' ? state._ttConflictInputs : {};
    const cursorMap = state._ttInputCursor && typeof state._ttInputCursor === 'object' ? state._ttInputCursor : {};
    for (const destKey of Object.keys(conflictInputs)) {
        const dirs = Array.isArray(conflictInputs[destKey]) ? conflictInputs[destKey] : [];
        if (!dirs.length) continue;
        const d = factoryKeyToColRow(destKey);
        if (!Number.isFinite(d.col) || !Number.isFinite(d.row)) continue;
        const startDir = ((Number(cursorMap[destKey] || 0) | 0) + 4) % 4;
        const skipDir = inputDirFromTransporterOutputDir(getTransporterDir(destKey));
        for (let i = 0; i < 4; i++) {
            const dir = (startDir + i) % 4;
            if (dir === skipDir) continue;
            if (!dirs.includes(dir)) continue;
            const src = sourceColRowFromInputDir(d.col, d.row, dir);
            const srcKey = factoryPlacementKey(src.col, src.row);
            if (state.placements[srcKey] !== 'transporter') continue;
            const nb = factoryNeighborColRow(src.col, src.row, getTransporterDir(srcKey));
            if (factoryPlacementKey(nb.col, nb.row) !== destKey) continue;
            const itemId = work[srcKey];
            if (!itemId) continue;
            if (spawnedThisTick.has(srcKey)) continue;
            acceptedFromByDest[destKey] = srcKey;
            break;
        }
    }

    movesTTCandidates.sort((a, b) => a.from.localeCompare(b.from));
    for (const m of movesTTCandidates) {
        if (claimedDest.has(m.to) || claimedFrom.has(m.from)) continue;
        const acceptedFrom = acceptedFromByDest[m.to];
        if (acceptedFrom && acceptedFrom !== m.from) continue;
        if (work[m.to]) continue;
        if (!work[m.from] || work[m.from] !== m.itemId) continue;
        claimedDest.add(m.to);
        claimedFrom.add(m.from);
        delete work[m.from];
        work[m.to] = m.itemId;
        movesTT.push(m);
        // Advance accepted input direction only after successful receive into this transporter.
        if (acceptedFromByDest[m.to] && acceptedFromByDest[m.to] === m.from) {
            const skipDir = inputDirFromTransporterOutputDir(getTransporterDir(m.to));
            let next = (((Number(cursorMap[m.to] || 0) | 0) + 4) % 4 + 1) % 4;
            for (let i = 0; i < 4; i++) {
                if (next !== skipDir) break;
                next = (next + 1) % 4;
            }
            cursorMap[m.to] = next;
        }
    }
    state._ttInputCursor = cursorMap;

    movesToEmptyCombinerCandidates.sort((a, b) => a.from.localeCompare(b.from));
    const tcByDest = new Map();
    for (const m of movesToEmptyCombinerCandidates) {
        const arr = tcByDest.get(m.to);
        if (arr) arr.push(m);
        else tcByDest.set(m.to, [m]);
    }
    const tcDestKeys = Array.from(tcByDest.keys()).sort();
    for (let pass = 0; pass < movesToEmptyCombinerCandidates.length; pass++) {
        let progressed = false;
        for (const destKey of tcDestKeys) {
            if (claimedDest.has(destKey)) continue;
            if (work[destKey]) continue;
            if (state.combinerDiscovery && state.combinerDiscovery[destKey]) continue;
            const list = tcByDest.get(destKey);
            if (!list || list.length === 0) continue;
            const start = rotateStart(destKey, list.length, pass);
            for (let i = 0; i < list.length; i++) {
                const m = list[(start + i) % list.length];
                if (claimedFrom.has(m.from)) continue;
                if (!work[m.from] || work[m.from] !== m.itemId) continue;
                claimedDest.add(destKey);
                claimedFrom.add(m.from);
                delete work[m.from];
                work[destKey] = m.itemId;
                movesToEmptyCombiner.push(m);
                progressed = true;
                break;
            }
        }
        if (!progressed) break;
    }

    // Bridge: like transporter, but teleports to cell two steps ahead.
    // Run after normal transporter arbitration so it doesn't break regular queue/conflict resolution.
    // Deliberately does not use shared conflict arbitration (claimed sets / round-robin).
    const bridgeKeys = Object.entries(state.placements || {})
        .filter(([, p]) => p === 'bridge')
        .map(([k]) => k)
        .sort();
    for (const key of bridgeKeys) {
        if (spawnedThisTick.has(key)) continue;
        const itemId = work[key];
        if (!itemId) continue;
        const cell = factoryKeyToColRow(key);
        const dir = getBridgeDir(key);
        const n1 = factoryNeighborColRow(cell.col, cell.row, dir);
        const n2 = factoryNeighborColRow(n1.col, n1.row, dir);
        if (!inBounds(n2.col, n2.row)) continue;
        const destKey = factoryPlacementKey(n2.col, n2.row);
        const destPl = state.placements[destKey];
        if (destPl === 'storage') {
            if (work[key] && work[key] === itemId) {
                delete work[key];
                invDelta[itemId] = (invDelta[itemId] || 0) + 1;
                bridgeMoves.push({ from: key, to: destKey, itemId });
            }
            continue;
        }
        if (destPl !== 'transporter' && destPl !== 'sorter' && destPl !== 'bridge') continue;
        if (work[destKey]) continue;
        if (!work[key] || work[key] !== itemId) continue;
        delete work[key];
        work[destKey] = itemId;
        bridgeMoves.push({ from: key, to: destKey, itemId });
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
            if (state.placements[outKey] !== 'transporter' && state.placements[outKey] !== 'sorter') continue;
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
    return { invDelta, deposits, combined, spawns, sorterPulls, bridgeMoves, movesTT, movesToEmptyCombiner };
}
