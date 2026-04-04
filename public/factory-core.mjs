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

function isBeltMergeDest(placement) {
    return placement === 'transporter' || placement === 'splitter';
}

function skipDirForBeltMergeDest(state, destKey, getTransporterDir, getSplitterDir) {
    const pl = state.placements[destKey];
    const d =
        pl === 'splitter'
            ? getSplitterDir(destKey)
            : pl === 'transporter'
              ? getTransporterDir(destKey)
              : 0;
    return inputDirFromTransporterOutputDir(d);
}

/**
 * Rebuild merge-arbitration metadata for transporter/splitter cells that receive from multiple sides.
 * @param {Record<string, string>} splitterTTPlanned splitterKey -> destKey for this wave's TT pushes
 */
function refreshBeltMergeConflicts(state, getTransporterDir, getSplitterDir, splitterTTPlanned) {
    const transporterKeys = Object.entries(state.placements || {})
        .filter(([, p]) => p === 'transporter')
        .map(([k]) => k)
        .sort();
    const incomingByDest = {};
    for (const srcKey of transporterKeys) {
        const s = factoryKeyToColRow(srcKey);
        if (!Number.isFinite(s.col) || !Number.isFinite(s.row)) continue;
        const nb = factoryNeighborColRow(s.col, s.row, getTransporterDir(srcKey));
        const destKey = factoryPlacementKey(nb.col, nb.row);
        if (!isBeltMergeDest(state.placements[destKey])) continue;
        const d = factoryKeyToColRow(destKey);
        const inDir = inputDirFromSourceToDest(s.col, s.row, d.col, d.row);
        if (inDir < 0) continue;
        if (!incomingByDest[destKey]) incomingByDest[destKey] = [];
        incomingByDest[destKey].push(inDir);
    }
    const planned = splitterTTPlanned && typeof splitterTTPlanned === 'object' ? splitterTTPlanned : {};
    for (const [sk, dk] of Object.entries(planned)) {
        if (!dk || state.placements[sk] !== 'splitter') continue;
        if (!isBeltMergeDest(state.placements[dk])) continue;
        const s = factoryKeyToColRow(sk);
        const d = factoryKeyToColRow(dk);
        if (
            !Number.isFinite(s.col) ||
            !Number.isFinite(s.row) ||
            !Number.isFinite(d.col) ||
            !Number.isFinite(d.row)
        ) {
            continue;
        }
        const inDir = inputDirFromSourceToDest(s.col, s.row, d.col, d.row);
        if (inDir < 0) continue;
        if (!incomingByDest[dk]) incomingByDest[dk] = [];
        incomingByDest[dk].push(inDir);
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
        const skipDir = skipDirForBeltMergeDest(state, destKey, getTransporterDir, getSplitterDir);
        let cur = prev;
        for (let i = 0; i < 4; i++) {
            if (cur !== skipDir) break;
            cur = (cur + 1) % 4;
        }
        nextCursor[destKey] = cur;
    }
    state._ttConflictInputs = conflictInputs;
    state._ttInputCursor = nextCursor;
}

/**
 * True if the belt at `beltKey` would send its next step into `targetKey` (e.g. transporter arrow aims at target).
 */
function beltOutputLeadsToCell(
    state,
    beltKey,
    targetKey,
    getTransporterDir,
    getSorterDir,
    getBridgeDir,
    getSplitterDir
) {
    const pl = state.placements[beltKey];
    const c = factoryKeyToColRow(beltKey);
    if (!Number.isFinite(c.col) || !Number.isFinite(c.row)) return false;
    if (pl === 'transporter') {
        const nb = factoryNeighborColRow(c.col, c.row, getTransporterDir(beltKey));
        return factoryPlacementKey(nb.col, nb.row) === targetKey;
    }
    if (pl === 'sorter') {
        const nb = factoryNeighborColRow(c.col, c.row, getSorterDir(beltKey));
        return factoryPlacementKey(nb.col, nb.row) === targetKey;
    }
    if (pl === 'splitter') {
        const nb = factoryNeighborColRow(c.col, c.row, getSplitterDir(beltKey));
        return factoryPlacementKey(nb.col, nb.row) === targetKey;
    }
    if (pl === 'bridge') {
        const d = getBridgeDir(beltKey);
        const n1 = factoryNeighborColRow(c.col, c.row, d);
        if (factoryPlacementKey(n1.col, n1.row) === targetKey) return true;
        const n2 = factoryNeighborColRow(n1.col, n1.row, d);
        return factoryPlacementKey(n2.col, n2.row) === targetKey;
    }
    return false;
}

/**
 * @param {Record<string, string>} outPlanned
 * @returns {number} number of TT moves added
 */
function emitSplitterOutbound(
    state,
    work,
    spawnedThisTick,
    inBounds,
    getTransporterDir,
    getSorterDir,
    getBridgeDir,
    getSplitterDir,
    movesTTCandidates,
    deposits,
    outPlanned
) {
    let ttAdded = 0;
    if (!state._splitterOutputCursor || typeof state._splitterOutputCursor !== 'object') {
        state._splitterOutputCursor = {};
    }
    if (!state._splitterChosenIdx || typeof state._splitterChosenIdx !== 'object') {
        state._splitterChosenIdx = {};
    }
    if (!state._splitterOptLen || typeof state._splitterOptLen !== 'object') {
        state._splitterOptLen = {};
    }
    if (!state._splitterHudDir || typeof state._splitterHudDir !== 'object') {
        state._splitterHudDir = {};
    }
    const curMap = state._splitterOutputCursor;
    for (const [key, p] of Object.entries(state.placements || {})) {
        if (p !== 'splitter') continue;
        delete state._splitterChosenIdx[key];
        delete state._splitterOptLen[key];
        delete state._splitterHudDir[key];
    }
    for (const [key, p] of Object.entries(state.placements || {})) {
        if (p !== 'splitter') continue;
        if (spawnedThisTick.has(key)) continue;
        const itemId = work[key];
        if (!itemId) continue;
        const cell = factoryKeyToColRow(key);
        if (!Number.isFinite(cell.col) || !Number.isFinite(cell.row)) continue;
        /** @type {{ kind: string, dir: number, destKey: string }[]} */
        const options = [];
        for (let d = 0; d < 4; d++) {
            const nb = factoryNeighborColRow(cell.col, cell.row, d);
            if (!inBounds(nb.col, nb.row)) continue;
            const destKey = factoryPlacementKey(nb.col, nb.row);
            const destPl = state.placements[destKey];
            if (destPl === 'storage') {
                options.push({ kind: 'dep', dir: d, destKey });
            } else if (
                destPl === 'transporter' ||
                destPl === 'sorter' ||
                destPl === 'bridge' ||
                destPl === 'splitter'
            ) {
                if (!work[destKey]) {
                    if (
                        beltOutputLeadsToCell(
                            state,
                            destKey,
                            key,
                            getTransporterDir,
                            getSorterDir,
                            getBridgeDir,
                            getSplitterDir
                        )
                    ) {
                        continue;
                    }
                    options.push({ kind: 'tt', dir: d, destKey });
                }
            }
        }
        if (!options.length) continue;
        options.sort((a, b) => a.destKey.localeCompare(b.destKey) || a.dir - b.dir);
        const optLen = options.length;
        const start = ((Number(curMap[key] || 0) | 0) + optLen * 256) % optLen;
        let chosen = null;
        let chosenIdx = 0;
        for (let i = 0; i < options.length; i++) {
            const idx = (start + i) % optLen;
            const o = options[idx];
            if (o.kind === 'tt' && !work[o.destKey]) {
                chosen = o;
                chosenIdx = idx;
                break;
            }
            if (o.kind === 'dep') {
                chosen = o;
                chosenIdx = idx;
                break;
            }
        }
        if (!chosen) continue;
        state._splitterHudDir[key] = chosen.dir;
        if (chosen.kind === 'dep') {
            deposits.push({ from: key, to: chosen.destKey, itemId });
            if (optLen >= 2) {
                curMap[key] = (chosenIdx + 1) % optLen;
            }
        } else {
            outPlanned[key] = chosen.destKey;
            movesTTCandidates.push({ from: key, to: chosen.destKey, itemId });
            ttAdded += 1;
            if (optLen >= 2) {
                state._splitterChosenIdx[key] = chosenIdx;
                state._splitterOptLen[key] = optLen;
            }
        }
    }
    return ttAdded;
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
    const getSplitterDir = typeof deps.getSplitterDir === 'function' ? deps.getSplitterDir : () => 0;

    const work = {};
    for (const [k, v] of Object.entries(state.cellItems || {})) {
        if (typeof v === 'string' && v) work[k] = v;
    }
    /** Only combiner cells use discovery; stale keys (e.g. after replacing combiner with belt) must not erase items. */
    const placements = state.placements || {};
    for (const k of Object.keys(state.combinerDiscovery || {})) {
        if (placements[k] === 'combiner') delete work[k];
    }

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
                if (
                    state.placements[tk] !== 'transporter' &&
                    state.placements[tk] !== 'bridge' &&
                    state.placements[tk] !== 'splitter'
                ) {
                    continue;
                }
                if (work[tk]) continue;
                work[tk] = resId;
                spawnedThisTick.add(tk);
                spawns.push({ from: key, to: tk, itemId: resId });
            }
        }
    }

    const sorterPulls = [];
    const bridgeMoves = [];
    const movesToEmptyCombiner = [];

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
            const fromPl = state.placements[fromKey];
            if (fromPl !== 'transporter' && fromPl !== 'splitter') continue;
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

    const invDelta = {};
    const deposits = [];
    const claimedDest = new Set();
    const claimedFrom = new Set();
    const movesTT = [];

    /** One belt-resolution wave per sim tick so items advance at most one transporter/sorter hop per tick. */
    const MAX_BELT_WAVES = 1;
    let cursorMap = state._ttInputCursor && typeof state._ttInputCursor === 'object' ? state._ttInputCursor : {};

    for (let beltWave = 0; beltWave < MAX_BELT_WAVES; beltWave++) {
        const movesTTCandidates = [];
        const depositsWave = [];

        for (const [key, p] of Object.entries(state.placements || {})) {
            if (p !== 'transporter' && p !== 'sorter') continue;
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
                depositsWave.push({ from: key, to: destKey, itemId });
            } else if (
                destPl === 'transporter' ||
                destPl === 'sorter' ||
                destPl === 'bridge' ||
                destPl === 'splitter'
            ) {
                movesTTCandidates.push({ from: key, to: destKey, itemId });
            }
        }

        const splitterTTPlanned = {};
        emitSplitterOutbound(
            state,
            work,
            spawnedThisTick,
            inBounds,
            getTransporterDir,
            getSorterDir,
            getBridgeDir,
            getSplitterDir,
            movesTTCandidates,
            depositsWave,
            splitterTTPlanned
        );

        if (movesTTCandidates.length === 0 && depositsWave.length === 0) break;

        refreshBeltMergeConflicts(state, getTransporterDir, getSplitterDir, splitterTTPlanned);

        const conflictInputs =
            state._ttConflictInputs && typeof state._ttConflictInputs === 'object' ? state._ttConflictInputs : {};
        cursorMap =
            state._ttInputCursor && typeof state._ttInputCursor === 'object' ? state._ttInputCursor : cursorMap;

        const acceptedFromByDest = {};
        for (const destKey of Object.keys(conflictInputs)) {
            const dirs = Array.isArray(conflictInputs[destKey]) ? conflictInputs[destKey] : [];
            if (!dirs.length) continue;
            const d = factoryKeyToColRow(destKey);
            if (!Number.isFinite(d.col) || !Number.isFinite(d.row)) continue;
            const startDir = ((Number(cursorMap[destKey] || 0) | 0) + 4) % 4;
            const skipDir = skipDirForBeltMergeDest(state, destKey, getTransporterDir, getSplitterDir);
            for (let i = 0; i < 4; i++) {
                const dir = (startDir + i) % 4;
                if (dir === skipDir) continue;
                if (!dirs.includes(dir)) continue;
                const src = sourceColRowFromInputDir(d.col, d.row, dir);
                const srcKey = factoryPlacementKey(src.col, src.row);
                const srcPl = state.placements[srcKey];
                if (srcPl === 'transporter') {
                    const nb = factoryNeighborColRow(src.col, src.row, getTransporterDir(srcKey));
                    if (factoryPlacementKey(nb.col, nb.row) !== destKey) continue;
                } else if (srcPl === 'splitter') {
                    if (splitterTTPlanned[srcKey] !== destKey) continue;
                } else continue;
                const itemId = work[srcKey];
                if (!itemId) continue;
                if (spawnedThisTick.has(srcKey)) continue;
                acceptedFromByDest[destKey] = srcKey;
                break;
            }
        }

        for (const dep of depositsWave) {
            if (!work[dep.from]) continue;
            delete work[dep.from];
            invDelta[dep.itemId] = (invDelta[dep.itemId] || 0) + 1;
            deposits.push(dep);
        }

        /**
         * Cells that received a belt item this wave cannot forward in the same wave (avoids multi-hop
         * when candidate sort order runs upstream→downstream in one pass).
         */
        const receivedThisWave = new Set();

        movesTTCandidates.sort((a, b) => a.from.localeCompare(b.from));
        for (let pass = 0; pass < movesTTCandidates.length; pass++) {
            let progressed = false;
            for (const m of movesTTCandidates) {
                if (claimedDest.has(m.to) || claimedFrom.has(m.from)) continue;
                if (receivedThisWave.has(m.from)) continue;
                const acceptedFrom = acceptedFromByDest[m.to];
                if (acceptedFrom && acceptedFrom !== m.from) continue;
                if (work[m.to]) continue;
                if (!work[m.from] || work[m.from] !== m.itemId) continue;
                claimedDest.add(m.to);
                claimedFrom.add(m.from);
                delete work[m.from];
                work[m.to] = m.itemId;
                receivedThisWave.add(m.to);
                movesTT.push(m);
                progressed = true;
                if (state.placements[m.from] === 'splitter' && state._splitterOptLen && state._splitterChosenIdx) {
                    const len = state._splitterOptLen[m.from];
                    if (len >= 2) {
                        const idx = state._splitterChosenIdx[m.from];
                        if (!state._splitterOutputCursor || typeof state._splitterOutputCursor !== 'object') {
                            state._splitterOutputCursor = {};
                        }
                        state._splitterOutputCursor[m.from] = (idx + 1) % len;
                    }
                }
                if (acceptedFromByDest[m.to] && acceptedFromByDest[m.to] === m.from) {
                    const skipDir = skipDirForBeltMergeDest(state, m.to, getTransporterDir, getSplitterDir);
                    let next = (((Number(cursorMap[m.to] || 0) | 0) + 4) % 4 + 1) % 4;
                    for (let i = 0; i < 4; i++) {
                        if (next !== skipDir) break;
                        next = (next + 1) % 4;
                    }
                    cursorMap[m.to] = next;
                }
            }
            if (!progressed) break;
        }

        state._ttInputCursor = cursorMap;
    }

    state._ttInputCursor = cursorMap;

    const movesToEmptyCombinerCandidates = [];
    const combinerFeeds = [];
    for (const [key, p] of Object.entries(state.placements || {})) {
        if (p !== 'transporter' && p !== 'sorter') continue;
        if (spawnedThisTick.has(key)) continue;
        const itemId = work[key];
        if (!itemId) continue;
        const cell = factoryKeyToColRow(key);
        const outDir = p === 'sorter' ? getSorterDir(key) : getTransporterDir(key);
        const nb = factoryNeighborColRow(cell.col, cell.row, outDir);
        if (!inBounds(nb.col, nb.row)) continue;
        const destKey = factoryPlacementKey(nb.col, nb.row);
        const destPl = state.placements[destKey];
        if (destPl !== 'combiner') continue;
        if (state.combinerDiscovery && state.combinerDiscovery[destKey]) continue;
        if (!canCombinerAcceptFrom(destKey, key, getCombinerDir)) continue;
        if (!work[destKey]) movesToEmptyCombinerCandidates.push({ from: key, to: destKey, itemId });
        else if (work[destKey] !== itemId) {
            combinerFeeds.push({ from: key, to: destKey, incoming: itemId });
        }
    }

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
        if (destPl !== 'transporter' && destPl !== 'sorter' && destPl !== 'bridge' && destPl !== 'splitter') {
            continue;
        }
        if (work[destKey]) continue;
        if (!work[key] || work[key] !== itemId) continue;
        delete work[key];
        work[destKey] = itemId;
        bridgeMoves.push({ from: key, to: destKey, itemId });
    }

    const combined = [];
    /** Second-item runs into an occupied combiner; used client-side for slide animation (combiner cell often has no cellItems after merge). */
    const combinerIntakeMoves = [];
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
            if (
                state.placements[outKey] !== 'transporter' &&
                state.placements[outKey] !== 'sorter' &&
                state.placements[outKey] !== 'bridge' &&
                state.placements[outKey] !== 'splitter'
            ) {
                continue;
            }
            if (work[outKey]) continue;
            if (claimedDest.has(outKey) || combinerOutClaimed.has(outKey)) continue;
            combinerDestClaimed.add(f.to);
            claimedFrom.add(f.from);
            claimedDest.add(outKey);
            combinerOutClaimed.add(outKey);
            combinerIntakeMoves.push({ from: f.from, to: f.to, itemId: f.incoming });
            delete work[f.from];
            delete work[f.to];
            work[outKey] = resultId;
            combined.push({ combinerKey: f.to, a: existing, b: f.incoming, resultId, outKey });
        } else {
            combinerDestClaimed.add(f.to);
            claimedFrom.add(f.from);
            combinerIntakeMoves.push({ from: f.from, to: f.to, itemId: f.incoming });
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
    return {
        invDelta,
        deposits,
        combined,
        spawns,
        sorterPulls,
        bridgeMoves,
        movesTT,
        movesToEmptyCombiner,
        combinerIntakeMoves
    };
}
