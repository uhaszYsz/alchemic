import Database from 'better-sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dbPath = path.join(__dirname, 'data', 'alchemic.db');

const SEED = [
    ['wood', '🪵', 'Wood'],
    ['stone', '🪨', 'Stone'],
    ['flint', '🗿', 'Flint'],
    ['plants', '🌿', 'Plants']
];

function migrateItemsIconPath(db) {
    const cols = db.prepare('PRAGMA table_info(items)').all();
    if (!cols.some((c) => c.name === 'icon_path')) {
        db.exec('ALTER TABLE items ADD COLUMN icon_path TEXT');
    }
}

function migrateItemsDiscoveredBy(db) {
    const cols = db.prepare('PRAGMA table_info(items)').all();
    if (!cols.some((c) => c.name === 'discovered_by')) {
        db.exec('ALTER TABLE items ADD COLUMN discovered_by INTEGER');
    }
}

function migrateItemsDiscoveredAt(db) {
    const cols = db.prepare('PRAGMA table_info(items)').all();
    if (!cols.some((c) => c.name === 'discovered_at')) {
        db.exec("ALTER TABLE items ADD COLUMN discovered_at TEXT");
    }
}

function migrateItemsNameColor(db) {
    const cols = db.prepare('PRAGMA table_info(items)').all();
    if (!cols.some((c) => c.name === 'name_color')) {
        db.exec('ALTER TABLE items ADD COLUMN name_color TEXT');
    }
}

function migrateItemsVotes(db) {
    const cols = db.prepare('PRAGMA table_info(items)').all();
    if (!cols.some((c) => c.name === 'upvotes')) {
        db.exec('ALTER TABLE items ADD COLUMN upvotes INTEGER NOT NULL DEFAULT 0');
    }
    if (!cols.some((c) => c.name === 'downvotes')) {
        db.exec('ALTER TABLE items ADD COLUMN downvotes INTEGER NOT NULL DEFAULT 0');
    }
}

function migrateItemsIconSizeBytes(db) {
    const cols = db.prepare('PRAGMA table_info(items)').all();
    if (!cols.some((c) => c.name === 'icon_size_bytes')) {
        db.exec('ALTER TABLE items ADD COLUMN icon_size_bytes INTEGER NOT NULL DEFAULT 0');
    }
}

function migrateItemsUniqueName(db) {
    db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_items_name_unique_nocase ON items(name COLLATE NOCASE)');
}

function migrateItemsItemType(db) {
    const cols = db.prepare('PRAGMA table_info(items)').all();
    if (!cols.some((c) => c.name === 'item_type')) {
        db.exec('ALTER TABLE items ADD COLUMN item_type TEXT');
    }
}

/** Allowed `item_type` values (exposed as `type` in JSON). */
export const ITEM_TYPE_VALUES = [
    'TransportGround',
    'TransportWater',
    'TransportAir',
    'ArmyAir',
    'ArmyGround',
    'ArmyWater'
];

function migrateDiscoveryProposalTables(db) {
    db.exec(`
        CREATE TABLE IF NOT EXISTS discovery_proposals (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            item_id TEXT NOT NULL,
            proposal_type TEXT NOT NULL,
            proposed_name TEXT,
            proposed_image_path TEXT,
            created_by INTEGER NOT NULL,
            created_at TEXT NOT NULL DEFAULT (datetime('now')),
            FOREIGN KEY(item_id) REFERENCES items(id),
            FOREIGN KEY(created_by) REFERENCES users(id)
        );
        CREATE TABLE IF NOT EXISTS discovery_proposal_votes (
            proposal_id INTEGER NOT NULL,
            user_id INTEGER NOT NULL,
            vote_value INTEGER NOT NULL,
            created_at TEXT NOT NULL DEFAULT (datetime('now')),
            updated_at TEXT NOT NULL DEFAULT (datetime('now')),
            PRIMARY KEY (proposal_id, user_id),
            FOREIGN KEY(proposal_id) REFERENCES discovery_proposals(id),
            FOREIGN KEY(user_id) REFERENCES users(id)
        );
        CREATE INDEX IF NOT EXISTS idx_discovery_proposals_item_created
            ON discovery_proposals(item_id, created_at DESC);
        CREATE INDEX IF NOT EXISTS idx_discovery_proposal_votes_proposal
            ON discovery_proposal_votes(proposal_id);
    `);
}

function migrateUsersLastSeenAt(db) {
    const cols = db.prepare('PRAGMA table_info(users)').all();
    if (!cols.some((c) => c.name === 'last_seen_at')) {
        db.exec("ALTER TABLE users ADD COLUMN last_seen_at TEXT");
    }
}

/**
 * Remove legacy base items water/dirt and any discoveries that used them in recipes.
 */
function migrateRemoveWaterDirt(db) {
    const delOne = (targetId) => {
        const id = String(targetId || '').trim();
        if (!id) return;
        const tx = db.transaction((tid) => {
            db.prepare(
                `DELETE FROM discovery_proposal_votes
                 WHERE proposal_id IN (SELECT id FROM discovery_proposals WHERE item_id = @id)`
            ).run({ id: tid });
            db.prepare('DELETE FROM discovery_proposals WHERE item_id = @id').run({ id: tid });
            db.prepare('DELETE FROM rejectedCrafts WHERE item_a_id = @id OR item_b_id = @id').run({ id: tid });
            db.prepare('DELETE FROM items WHERE id = @id').run({ id: tid });
        });
        tx(id);
    };
    let changed = true;
    while (changed) {
        changed = false;
        const rows = db
            .prepare(
                `SELECT id FROM items WHERE ingredient_a IN ('water','dirt') OR ingredient_b IN ('water','dirt')`
            )
            .all();
        for (const r of rows) {
            delOne(String(r.id));
            changed = true;
        }
    }
    db.prepare(`DELETE FROM user_inventory WHERE item_id IN ('water','dirt')`).run();
    delOne('water');
    delOne('dirt');
}

/**
 * Base catalog starters (wood/stone/flint/plants). INSERT OR IGNORE so
 * existing rows are untouched; missing ids are added (fixes DBs that only got flint+plants
 * from an older migration that ran before the empty-DB seed block).
 */
function ensureSeedBaseItems(db) {
    const ins = db.prepare(
        'INSERT OR IGNORE INTO items (id, emoji, name, ingredient_a, ingredient_b) VALUES (@id, @emoji, @name, NULL, NULL)'
    );
    for (const [id, emoji, name] of SEED) {
        ins.run({ id, emoji, name });
    }
    db.prepare("UPDATE items SET emoji = '🗿' WHERE id = 'flint'").run();
}

export function openDb() {
    const db = new Database(dbPath);
    db.pragma('journal_mode = WAL');
    db.exec(`
        CREATE TABLE IF NOT EXISTS items (
            id TEXT PRIMARY KEY NOT NULL,
            emoji TEXT NOT NULL,
            name TEXT NOT NULL,
            name_color TEXT,
            ingredient_a TEXT,
            ingredient_b TEXT,
            icon_path TEXT,
            icon_size_bytes INTEGER NOT NULL DEFAULT 0,
            discovered_by INTEGER,
            discovered_at TEXT,
            upvotes INTEGER NOT NULL DEFAULT 0,
            downvotes INTEGER NOT NULL DEFAULT 0
        );
        CREATE TABLE IF NOT EXISTS rejectedCrafts (
            item_a_id TEXT NOT NULL,
            item_b_id TEXT NOT NULL,
            explanation TEXT,
            created_at TEXT NOT NULL DEFAULT (datetime('now')),
            PRIMARY KEY (item_a_id, item_b_id)
        );
        CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            username TEXT NOT NULL UNIQUE,
            password_hash TEXT NOT NULL,
            password_salt TEXT NOT NULL,
            created_at TEXT NOT NULL DEFAULT (datetime('now')),
            last_seen_at TEXT
        );
        CREATE TABLE IF NOT EXISTS user_sessions (
            token_hash TEXT PRIMARY KEY NOT NULL,
            user_id INTEGER NOT NULL,
            created_at TEXT NOT NULL DEFAULT (datetime('now')),
            expires_at TEXT NOT NULL,
            FOREIGN KEY(user_id) REFERENCES users(id)
        );
        CREATE TABLE IF NOT EXISTS user_inventory (
            user_id INTEGER NOT NULL,
            item_id TEXT NOT NULL,
            qty INTEGER NOT NULL DEFAULT 0,
            updated_at TEXT NOT NULL DEFAULT (datetime('now')),
            PRIMARY KEY (user_id, item_id),
            FOREIGN KEY(user_id) REFERENCES users(id)
        );
        CREATE TABLE IF NOT EXISTS user_factories (
            user_id INTEGER NOT NULL,
            factory_id INTEGER NOT NULL,
            world_col INTEGER NOT NULL,
            world_row INTEGER NOT NULL,
            state_json TEXT NOT NULL,
            updated_at TEXT NOT NULL DEFAULT (datetime('now')),
            PRIMARY KEY (user_id, factory_id),
            FOREIGN KEY(user_id) REFERENCES users(id),
            UNIQUE (world_col, world_row)
        );
        CREATE TABLE IF NOT EXISTS snapshoots (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL,
            factory_id INTEGER NOT NULL DEFAULT 1,
            state_json TEXT NOT NULL,
            created_at TEXT NOT NULL DEFAULT (datetime('now')),
            FOREIGN KEY(user_id) REFERENCES users(id)
        );
        CREATE INDEX IF NOT EXISTS idx_snapshoots_user_created
            ON snapshoots(user_id, created_at DESC);
    `);
    migrateItemsIconPath(db);
    migrateItemsDiscoveredBy(db);
    migrateItemsDiscoveredAt(db);
    migrateItemsNameColor(db);
    migrateItemsVotes(db);
    migrateItemsIconSizeBytes(db);
    migrateItemsUniqueName(db);
    migrateItemsItemType(db);
    migrateDiscoveryProposalTables(db);
    migrateUsersLastSeenAt(db);
    migrateRemoveWaterDirt(db);
    migrateLegacyUserFactoryState(db);
    migrateSnapshootsFactoryId(db);
    ensureSeedBaseItems(db);
    return db;
}

/**
 * Copy legacy single-factory table into user_factories (one row per user at world 0,user_id).
 */
function migrateLegacyUserFactoryState(db) {
    const legacy = db
        .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='user_factory_state'`)
        .get();
    if (!legacy) return;
    const tx = db.transaction(() => {
        const rows = db.prepare('SELECT user_id, state_json, updated_at FROM user_factory_state').all();
        const ins = db.prepare(
            `INSERT OR IGNORE INTO user_factories (user_id, factory_id, world_col, world_row, state_json, updated_at)
             VALUES (@user_id, 1, 0, @world_row, @state_json, @updated_at)`
        );
        for (const row of rows) {
            const uid = Number(row.user_id) | 0;
            if (!uid) continue;
            ins.run({
                user_id: uid,
                world_row: uid,
                state_json: String(row.state_json || '{}'),
                updated_at: String(row.updated_at || new Date().toISOString())
            });
        }
        db.exec('DROP TABLE user_factory_state');
    });
    try {
        tx();
    } catch (e) {
        console.warn('[db] migrateLegacyUserFactoryState', e);
    }
}

function migrateSnapshootsFactoryId(db) {
    const cols = db.prepare('PRAGMA table_info(snapshoots)').all();
    if (cols.some((c) => c.name === 'factory_id')) return;
    try {
        db.exec('ALTER TABLE snapshoots ADD COLUMN factory_id INTEGER NOT NULL DEFAULT 1');
    } catch {
        /* ignore */
    }
}

/** @returns {Record<string, { emoji: string, name: string, nameColor?: string, a?: string, b?: string, iconPath?: string, iconSizeBytes?: number, discoveredBy?: number, discoveredByUsername?: string, discoveredAt?: string, upvotes?: number, downvotes?: number }>} */
export function getItemsMap(db) {
    const rows = db
        .prepare(
            `SELECT
                i.id,
                i.emoji,
                i.name,
                i.name_color,
                i.ingredient_a AS a,
                i.ingredient_b AS b,
                i.icon_path,
                i.icon_size_bytes,
                i.discovered_by,
                i.discovered_at,
                i.upvotes,
                i.downvotes,
                i.item_type,
                u.username AS discovered_by_username
             FROM items AS i
             LEFT JOIN users AS u
               ON u.id = i.discovered_by
             ORDER BY i.id`
        )
        .all();
    const out = {};
    for (const row of rows) {
        const entry = { emoji: row.emoji, name: row.name };
        if (row.name_color != null && row.name_color !== '') {
            entry.nameColor = String(row.name_color);
        }
        if (row.a != null && row.b != null && row.a !== '' && row.b !== '') {
            entry.a = row.a;
            entry.b = row.b;
        }
        if (row.icon_path != null && row.icon_path !== '') {
            entry.iconPath = row.icon_path;
        }
        if (Number.isFinite(Number(row.icon_size_bytes)) && Number(row.icon_size_bytes) > 0) {
            entry.iconSizeBytes = Number(row.icon_size_bytes) | 0;
        }
        if (row.discovered_by != null) {
            entry.discoveredBy = Number(row.discovered_by);
        }
        if (row.discovered_by_username != null && row.discovered_by_username !== '') {
            entry.discoveredByUsername = String(row.discovered_by_username);
        }
        if (row.discovered_at != null && row.discovered_at !== '') {
            entry.discoveredAt = String(row.discovered_at);
        }
        if (row.upvotes != null && Number(row.upvotes) > 0) {
            entry.upvotes = Number(row.upvotes) | 0;
        }
        if (row.downvotes != null && Number(row.downvotes) > 0) {
            entry.downvotes = Number(row.downvotes) | 0;
        }
        if (row.item_type != null && String(row.item_type).trim() !== '') {
            entry.type = String(row.item_type).trim();
        }
        out[row.id] = entry;
    }
    return out;
}

/**
 * Insert or update a catalog item (discoveries). Preserves existing icon_path when not provided.
 * @param {import('better-sqlite3').Database} db
 * @param {{ id: string, emoji: string, name: string, name_color?: string | null, ingredient_a: string, ingredient_b: string, discovered_by?: number | null, discovered_at?: string | null }} row
 */
export function upsertItem(db, row) {
    const { id, emoji, name, name_color, ingredient_a, ingredient_b, discovered_by, discovered_at } = row;
    const normalizedName = String(name || '').trim();
    const normalizedColor =
        typeof name_color === 'string' && /^#[0-9a-fA-F]{6}$/.test(name_color.trim())
            ? name_color.trim().toLowerCase()
            : null;
    db.prepare(
        `INSERT INTO items (id, emoji, name, name_color, ingredient_a, ingredient_b, discovered_by, discovered_at, item_type)
         VALUES (@id, @emoji, @name, @name_color, @ingredient_a, @ingredient_b, @discovered_by, @discovered_at, NULL)
         ON CONFLICT(id) DO UPDATE SET
           emoji = excluded.emoji,
           name = excluded.name,
           name_color = excluded.name_color,
           ingredient_a = excluded.ingredient_a,
           ingredient_b = excluded.ingredient_b,
           discovered_by = COALESCE(items.discovered_by, excluded.discovered_by),
           discovered_at = COALESCE(items.discovered_at, excluded.discovered_at)`
    ).run({
        id,
        emoji,
        name: normalizedName,
        name_color: normalizedColor,
        ingredient_a,
        ingredient_b,
        discovered_by: discovered_by ?? null,
        discovered_at: discovered_at ?? null
    });
}

/**
 * Set optional gameplay `item_type` (stored column `item_type`, API field `type`).
 * Pass `null` or `''` to clear.
 * @param {import('better-sqlite3').Database} db
 * @param {string} itemId
 * @param {string | null | undefined} itemType
 * @returns {{ ok: boolean, error?: string }}
 */
export function setItemItemType(db, itemId, itemType) {
    const id = String(itemId || '').trim();
    if (!id) return { ok: false, error: 'missing id' };
    if (!itemIdExists(db, id)) return { ok: false, error: 'item not found' };
    let v = null;
    if (itemType != null && String(itemType).trim() !== '') {
        const s = String(itemType).trim();
        if (!ITEM_TYPE_VALUES.includes(s)) return { ok: false, error: 'invalid type' };
        v = s;
    }
    db.prepare('UPDATE items SET item_type = @v WHERE id = @id').run({ id, v });
    return { ok: true };
}

const ITEM_DISPLAY_NAME_MAX_LEN = 40;

/**
 * Rename catalog item display name (unique case-insensitive).
 * @param {import('better-sqlite3').Database} db
 * @param {string} itemId
 * @param {string} newName
 * @returns {{ ok: boolean, error?: string }}
 */
export function setItemDisplayName(db, itemId, newName) {
    const id = String(itemId || '').trim();
    const normalized = String(newName || '').trim();
    if (!id) return { ok: false, error: 'missing id' };
    if (!normalized) return { ok: false, error: 'name required' };
    if (normalized.length > ITEM_DISPLAY_NAME_MAX_LEN) {
        return { ok: false, error: `name too long (max ${ITEM_DISPLAY_NAME_MAX_LEN})` };
    }
    if (!itemIdExists(db, id)) return { ok: false, error: 'item not found' };
    const conflict = findItemByName(db, normalized);
    if (conflict && conflict.id !== id) {
        return { ok: false, error: 'another item already uses this name' };
    }
    try {
        db.prepare('UPDATE items SET name = @name WHERE id = @id').run({ id, name: normalized });
    } catch (e) {
        const msg = e && typeof e.message === 'string' ? e.message : String(e);
        if (/unique constraint failed:\s*items\.name/i.test(msg)) {
            return { ok: false, error: 'another item already uses this name' };
        }
        return { ok: false, error: msg || 'update failed' };
    }
    return { ok: true };
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {string} name
 * @returns {{ id: string } | null}
 */
export function findItemByName(db, name) {
    const normalized = String(name || '').trim();
    if (!normalized) return null;
    const row = db
        .prepare('SELECT id FROM items WHERE name = ? COLLATE NOCASE LIMIT 1')
        .get(normalized);
    return row || null;
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {string} id
 * @returns {boolean}
 */
export function itemIdExists(db, id) {
    const row = db.prepare('SELECT 1 FROM items WHERE id = ? LIMIT 1').get(String(id || '').trim());
    return !!row;
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {string} query
 * @param {number} limit
 * @returns {{ id: string, emoji: string, name: string }[]}
 */
export function searchItemsByNameSubstring(db, query, limit = 40) {
    const q = String(query || '').trim();
    if (!q) return [];
    const lim = Math.max(1, Math.min(100, Number(limit) | 0 || 40));
    const esc = q.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_');
    const pat = `%${esc}%`;
    const rows = db
        .prepare(
            `SELECT id, emoji, name FROM items
             WHERE name LIKE @pat ESCAPE '\\'
             ORDER BY name COLLATE NOCASE
             LIMIT @lim`
        )
        .all({ pat, lim });
    return rows.map((r) => ({
        id: String(r.id || ''),
        emoji: String(r.emoji || '✨'),
        name: String(r.name || '')
    }));
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {string} itemId
 * @returns {{ ingredient_a: string, ingredient_b: string } | null}
 */
export function getItemIngredientIds(db, itemId) {
    const row = db
        .prepare('SELECT ingredient_a, ingredient_b FROM items WHERE id = ?')
        .get(String(itemId || '').trim());
    if (!row) return null;
    return {
        ingredient_a: String(row.ingredient_a || '').trim(),
        ingredient_b: String(row.ingredient_b || '').trim()
    };
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {string} ingredientA
 * @param {string} ingredientB
 * @param {string} excludeItemId
 * @returns {string | null} other item id if collision
 */
export function findOtherItemWithSameRecipe(db, ingredientA, ingredientB, excludeItemId) {
    const a = String(ingredientA || '').trim();
    const b = String(ingredientB || '').trim();
    const ex = String(excludeItemId || '').trim();
    if (!a || !b || !ex) return null;
    const row = db
        .prepare(
            `SELECT id FROM items
             WHERE id != @ex
               AND TRIM(COALESCE(ingredient_a, '')) != ''
               AND TRIM(COALESCE(ingredient_b, '')) != ''
               AND (
                 (ingredient_a = @a AND ingredient_b = @b)
                 OR (ingredient_a = @b AND ingredient_b = @a)
               )
             LIMIT 1`
        )
        .get({ ex, a, b });
    return row && row.id != null ? String(row.id) : null;
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {string} itemId
 * @param {string} ingredient_a
 * @param {string} ingredient_b
 * @returns {{ ok: boolean, error?: string, otherId?: string }}
 */
export function updateDiscoveryIngredients(db, itemId, ingredient_a, ingredient_b) {
    const id = String(itemId || '').trim();
    const a = String(ingredient_a || '').trim();
    const b = String(ingredient_b || '').trim();
    if (!id || !a || !b) return { ok: false, error: 'missing id or ingredients' };
    if (!itemIdExists(db, id)) return { ok: false, error: 'item not found' };
    if (!itemIdExists(db, a) || !itemIdExists(db, b)) return { ok: false, error: 'ingredient item not found' };
    const curRow = db.prepare('SELECT ingredient_a, ingredient_b FROM items WHERE id = ?').get(id);
    if (
        curRow &&
        String(curRow.ingredient_a || '').trim() === a &&
        String(curRow.ingredient_b || '').trim() === b
    ) {
        return { ok: true };
    }
    const other = findOtherItemWithSameRecipe(db, a, b, id);
    if (other) return { ok: false, error: 'another item already uses this recipe pair', otherId: other };
    const out = db.prepare('UPDATE items SET ingredient_a = @a, ingredient_b = @b WHERE id = @id').run({ id, a, b });
    return out.changes > 0 ? { ok: true } : { ok: false, error: 'update failed' };
}

/**
 * List items that require a given item as an ingredient.
 * @param {import('better-sqlite3').Database} db
 * @param {string} itemId
 * @returns {{ id: string, name: string, emoji: string }[]}
 */
export function listDependentItems(db, itemId) {
    const id = String(itemId || '').trim();
    if (!id) return [];
    const rows = db
        .prepare(
            `SELECT id, name, emoji
             FROM items
             WHERE ingredient_a = @id OR ingredient_b = @id
             ORDER BY name COLLATE NOCASE, id`
        )
        .all({ id });
    return rows.map((r) => ({
        id: String(r.id),
        name: String(r.name || r.id),
        emoji: String(r.emoji || '✨')
    }));
}

/**
 * Top discoveries by vote activity for one user.
 * @param {import('better-sqlite3').Database} db
 * @param {number} userId
 * @param {number} limit
 * @returns {{ id: string, emoji: string, name: string, iconPath?: string, upvotes: number, downvotes: number, totalVotes: number }[]}
 */
export function listTopDiscoveriesByUser(db, userId, limit = 20) {
    const uid = Number(userId) | 0;
    if (!uid) return [];
    const lim = Math.max(1, Math.min(100, Number(limit || 20) | 0));
    const rows = db
        .prepare(
            `SELECT
                id,
                emoji,
                name,
                icon_path,
                COALESCE(upvotes, 0) AS upvotes,
                COALESCE(downvotes, 0) AS downvotes,
                (COALESCE(upvotes, 0) + COALESCE(downvotes, 0)) AS total_votes
             FROM items
             WHERE discovered_by = @uid
             ORDER BY total_votes DESC, upvotes DESC, discovered_at DESC, name COLLATE NOCASE
             LIMIT @lim`
        )
        .all({ uid, lim });
    return rows.map((r) => {
        const out = {
            id: String(r.id || ''),
            emoji: String(r.emoji || '✨'),
            name: String(r.name || ''),
            upvotes: Number(r.upvotes || 0) | 0,
            downvotes: Number(r.downvotes || 0) | 0,
            totalVotes: Number(r.total_votes || 0) | 0
        };
        if (r.icon_path) out.iconPath = String(r.icon_path);
        return out;
    });
}

/**
 * Delete an item and related proposal/rejected-craft rows.
 * @param {import('better-sqlite3').Database} db
 * @param {string} itemId
 * @returns {boolean}
 */
export function deleteItemById(db, itemId) {
    const id = String(itemId || '').trim();
    if (!id) return false;
    const tx = db.transaction((targetId) => {
        db.prepare(
            `DELETE FROM discovery_proposal_votes
             WHERE proposal_id IN (SELECT id FROM discovery_proposals WHERE item_id = @id)`
        ).run({ id: targetId });
        db.prepare('DELETE FROM discovery_proposals WHERE item_id = @id').run({ id: targetId });
        db.prepare('DELETE FROM rejectedCrafts WHERE item_a_id = @id OR item_b_id = @id').run({ id: targetId });
        const out = db.prepare('DELETE FROM items WHERE id = @id').run({ id: targetId });
        return out.changes > 0;
    });
    return tx(id);
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {string} id
 * @param {string} iconPathRelative project-relative path e.g. images/foo.png
 * @param {number} iconSizeBytes
 */
export function setItemIconPath(db, id, iconPathRelative, iconSizeBytes = 0) {
    db.prepare('UPDATE items SET icon_path = @p, icon_size_bytes = @sz WHERE id = @id').run({
        p: iconPathRelative,
        sz: Math.max(0, Math.floor(Number(iconSizeBytes) || 0)),
        id: String(id)
    });
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {string} itemId
 * @returns {boolean}
 */
function isDiscoveryItem(db, itemId) {
    const row = db
        .prepare(
            `SELECT id
             FROM items
             WHERE id = ?
               AND ingredient_a IS NOT NULL AND ingredient_a != ''
               AND ingredient_b IS NOT NULL AND ingredient_b != ''
             LIMIT 1`
        )
        .get(String(itemId || '').trim());
    return !!row;
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {{ itemId: string, proposalType: 'name'|'image', proposedName?: string | null, proposedImagePath?: string | null, createdBy: number }} input
 * @returns {{ id: number } | null}
 */
export function createDiscoveryProposal(db, input) {
    const itemId = String(input.itemId || '').trim();
    const proposalType = input.proposalType === 'image' ? 'image' : input.proposalType === 'name' ? 'name' : '';
    const proposedName =
        proposalType === 'name' && typeof input.proposedName === 'string' ? String(input.proposedName).trim() : null;
    const proposedImagePath =
        proposalType === 'image' && typeof input.proposedImagePath === 'string'
            ? String(input.proposedImagePath).trim()
            : null;
    if (!itemId || !proposalType) return null;
    if (proposalType === 'name' && !proposedName) return null;
    if (proposalType === 'image' && !proposedImagePath) return null;
    if (!isDiscoveryItem(db, itemId)) return null;
    const out = db
        .prepare(
            `INSERT INTO discovery_proposals (item_id, proposal_type, proposed_name, proposed_image_path, created_by)
             VALUES (@item_id, @proposal_type, @proposed_name, @proposed_image_path, @created_by)`
        )
        .run({
            item_id: itemId,
            proposal_type: proposalType,
            proposed_name: proposedName,
            proposed_image_path: proposedImagePath,
            created_by: Number(input.createdBy)
        });
    return { id: Number(out.lastInsertRowid) };
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {number} proposalId
 * @param {number} userId
 * @param {'up'|'down'} direction
 * @returns {{ upvotes: number, downvotes: number, myVote: number } | null}
 */
export function voteOnDiscoveryProposal(db, proposalId, userId, direction) {
    const dir = direction === 'down' ? -1 : direction === 'up' ? 1 : 0;
    if (!dir) return null;
    const p = db
        .prepare(
            `SELECT p.id
             FROM discovery_proposals p
             JOIN items i ON i.id = p.item_id
             WHERE p.id = ?
               AND i.ingredient_a IS NOT NULL AND i.ingredient_a != ''
               AND i.ingredient_b IS NOT NULL AND i.ingredient_b != ''
             LIMIT 1`
        )
        .get(Number(proposalId));
    if (!p) return null;
    db.prepare(
        `INSERT INTO discovery_proposal_votes (proposal_id, user_id, vote_value, created_at, updated_at)
         VALUES (@proposal_id, @user_id, @vote_value, datetime('now'), datetime('now'))
         ON CONFLICT(proposal_id, user_id) DO UPDATE SET
            vote_value = excluded.vote_value,
            updated_at = datetime('now')`
    ).run({
        proposal_id: Number(proposalId),
        user_id: Number(userId),
        vote_value: dir
    });
    const agg = db
        .prepare(
            `SELECT
                SUM(CASE WHEN vote_value = 1 THEN 1 ELSE 0 END) AS upvotes,
                SUM(CASE WHEN vote_value = -1 THEN 1 ELSE 0 END) AS downvotes
             FROM discovery_proposal_votes
             WHERE proposal_id = ?`
        )
        .get(Number(proposalId));
    return {
        upvotes: Number((agg && agg.upvotes) || 0) | 0,
        downvotes: Number((agg && agg.downvotes) || 0) | 0,
        myVote: dir
    };
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {string} itemId
 * @param {number} userId
 * @returns {{ id: number, itemId: string, proposalType: 'name'|'image', proposedName?: string, proposedImagePath?: string, createdBy: number, createdAt: string, upvotes: number, downvotes: number, myVote: number }[]}
 */
export function listDiscoveryProposalsByItem(db, itemId, userId) {
    const rows = db
        .prepare(
            `SELECT
                p.id,
                p.item_id,
                p.proposal_type,
                p.proposed_name,
                p.proposed_image_path,
                p.created_by,
                p.created_at,
                COALESCE(SUM(CASE WHEN v.vote_value = 1 THEN 1 ELSE 0 END), 0) AS upvotes,
                COALESCE(SUM(CASE WHEN v.vote_value = -1 THEN 1 ELSE 0 END), 0) AS downvotes,
                COALESCE(MAX(CASE WHEN v.user_id = @uid THEN v.vote_value ELSE 0 END), 0) AS my_vote
             FROM discovery_proposals p
             LEFT JOIN discovery_proposal_votes v ON v.proposal_id = p.id
             WHERE p.item_id = @item_id
             GROUP BY p.id
             ORDER BY p.created_at DESC, p.id DESC`
        )
        .all({ item_id: String(itemId || '').trim(), uid: Number(userId) });
    return rows.map((row) => {
        const out = {
            id: Number(row.id),
            itemId: String(row.item_id),
            proposalType: row.proposal_type === 'image' ? 'image' : 'name',
            createdBy: Number(row.created_by),
            createdAt: String(row.created_at),
            upvotes: Number(row.upvotes || 0) | 0,
            downvotes: Number(row.downvotes || 0) | 0,
            myVote: Number(row.my_vote || 0) | 0
        };
        if (row.proposed_name) out.proposedName = String(row.proposed_name);
        if (row.proposed_image_path) out.proposedImagePath = String(row.proposed_image_path);
        return out;
    });
}

/**
 * Increment upvote/downvote counters for discoveries.
 * Returns null when item not found or not a discovery.
 * @param {import('better-sqlite3').Database} db
 * @param {string} id
 * @param {'up' | 'down'} direction
 * @returns {{ upvotes: number, downvotes: number } | null}
 */
export function voteOnItem(db, id, direction) {
    const dir = direction === 'down' ? 'down' : 'up';
    const result = db
        .prepare(
            `UPDATE items
             SET upvotes = upvotes + CASE WHEN @dir = 'up' THEN 1 ELSE 0 END,
                 downvotes = downvotes + CASE WHEN @dir = 'down' THEN 1 ELSE 0 END
             WHERE id = @id
               AND ingredient_a IS NOT NULL AND ingredient_a != ''
               AND ingredient_b IS NOT NULL AND ingredient_b != ''`
        )
        .run({ id: String(id || '').trim(), dir });
    if (!result || result.changes < 1) return null;
    const row = db.prepare('SELECT upvotes, downvotes FROM items WHERE id = ?').get(String(id || '').trim());
    if (!row) return null;
    return {
        upvotes: Number(row.upvotes || 0) | 0,
        downvotes: Number(row.downvotes || 0) | 0
    };
}

/**
 * Store a rejected pair (AI said combo does not make sense). IDs are stored in sorted order.
 * @param {import('better-sqlite3').Database} db
 * @param {string} idA
 * @param {string} idB
 */
export function recordRejectedCraft(db, idA, idB) {
    const [a, b] = [String(idA), String(idB)].sort();
    db.prepare(
        `INSERT INTO rejectedCrafts (item_a_id, item_b_id, explanation)
         VALUES (@a, @b, NULL)
         ON CONFLICT(item_a_id, item_b_id) DO UPDATE SET
           created_at = datetime('now')`
    ).run({ a, b });
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {string} idA
 * @param {string} idB
 * @returns {boolean}
 */
export function isRejectedCraft(db, idA, idB) {
    const [a, b] = [String(idA), String(idB)].sort();
    const row = db
        .prepare('SELECT 1 AS x FROM rejectedCrafts WHERE item_a_id = ? AND item_b_id = ?')
        .get(a, b);
    return row != null;
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {{ username: string, passwordHash: string, passwordSalt: string }} input
 * @returns {{ id: number, username: string } | null}
 */
export function createUser(db, input) {
    const name = String(input.username || '').trim().toLowerCase();
    if (!name) return null;
    try {
        const out = db
            .prepare(
                `INSERT INTO users (username, password_hash, password_salt, last_seen_at)
                 VALUES (@username, @password_hash, @password_salt, datetime('now'))`
            )
            .run({
                username: name,
                password_hash: String(input.passwordHash),
                password_salt: String(input.passwordSalt)
            });
        return { id: Number(out.lastInsertRowid), username: name };
    } catch {
        return null;
    }
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {string} username
 * @returns {{ id: number, username: string, password_hash: string, password_salt: string } | null}
 */
export function getUserByUsername(db, username) {
    const name = String(username || '').trim().toLowerCase();
    if (!name) return null;
    const row = db
        .prepare(
            `SELECT id, username, password_hash, password_salt
             FROM users
             WHERE username = ?`
        )
        .get(name);
    return row || null;
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {number} userId
 * @returns {{ id: number, username: string, last_seen_at?: string | null } | null}
 */
export function getUserById(db, userId) {
    const row = db.prepare('SELECT id, username, last_seen_at FROM users WHERE id = ?').get(Number(userId));
    return row || null;
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {number} userId
 */
export function touchUserLastSeen(db, userId) {
    db.prepare("UPDATE users SET last_seen_at = datetime('now') WHERE id = ?").run(Number(userId));
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {{ tokenHash: string, userId: number, expiresAtIso: string }} input
 */
export function upsertSession(db, input) {
    db.prepare(
        `INSERT INTO user_sessions (token_hash, user_id, expires_at)
         VALUES (@token_hash, @user_id, @expires_at)
         ON CONFLICT(token_hash) DO UPDATE SET
            user_id = excluded.user_id,
            expires_at = excluded.expires_at`
    ).run({
        token_hash: String(input.tokenHash),
        user_id: Number(input.userId),
        expires_at: String(input.expiresAtIso)
    });
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {string} tokenHash
 * @returns {{ user_id: number, expires_at: string } | null}
 */
export function getSessionByTokenHash(db, tokenHash) {
    const row = db
        .prepare(
            `SELECT user_id, expires_at
             FROM user_sessions
             WHERE token_hash = ?`
        )
        .get(String(tokenHash));
    return row || null;
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {string} tokenHash
 */
export function deleteSessionByTokenHash(db, tokenHash) {
    db.prepare('DELETE FROM user_sessions WHERE token_hash = ?').run(String(tokenHash));
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {number} userId
 * @param {number} factoryId
 * @param {string} stateJson
 */
export function saveUserFactoryState(db, userId, factoryId, stateJson) {
    const uid = Number(userId) | 0;
    const fid = Number(factoryId) | 0;
    if (!uid || fid < 1) return;
    const n = db.prepare('SELECT 1 FROM user_factories WHERE user_id = ? AND factory_id = ?').get(uid, fid);
    if (!n) return;
    db.prepare(
        `UPDATE user_factories SET state_json = @state_json, updated_at = datetime('now')
         WHERE user_id = @user_id AND factory_id = @factory_id`
    ).run({
        user_id: uid,
        factory_id: fid,
        state_json: String(stateJson)
    });
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {number} userId
 * @param {number} factoryId
 * @returns {string | null}
 */
export function loadUserFactoryState(db, userId, factoryId) {
    const row = db
        .prepare('SELECT state_json FROM user_factories WHERE user_id = ? AND factory_id = ?')
        .get(Number(userId), Number(factoryId));
    return row ? String(row.state_json) : null;
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {number} userId
 * @returns {{ factoryId: number, worldCol: number, worldRow: number }[]}
 */
export function listUserFactories(db, userId) {
    const uid = Number(userId) | 0;
    if (!uid) return [];
    const rows = db
        .prepare(
            `SELECT factory_id, world_col, world_row FROM user_factories
             WHERE user_id = @uid ORDER BY factory_id ASC`
        )
        .all({ uid });
    return rows.map((r) => ({
        factoryId: Number(r.factory_id) | 0,
        worldCol: Number(r.world_col) | 0,
        worldRow: Number(r.world_row) | 0
    }));
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {number} userId
 * @param {number} col
 * @param {number} row
 * @param {string} stateJson
 * @returns {{ ok: boolean, factoryId?: number, error?: string }}
 */
export function claimWorldMapCellForNewFactory(db, userId, col, row, stateJson) {
    const uid = Number(userId) | 0;
    const c = Math.trunc(Number(col));
    const r = Math.trunc(Number(row));
    if (!uid) return { ok: false, error: 'bad user' };
    if (!Number.isFinite(c) || !Number.isFinite(r)) return { ok: false, error: 'bad coordinates' };
    const occ = db.prepare('SELECT 1 FROM user_factories WHERE world_col = ? AND world_row = ?').get(c, r);
    if (occ) return { ok: false, error: 'cell occupied' };
    const maxRow = db.prepare('SELECT MAX(factory_id) AS m FROM user_factories WHERE user_id = ?').get(uid);
    const next = (Number(maxRow && maxRow.m) || 0) + 1;
    try {
        db.prepare(
            `INSERT INTO user_factories (user_id, factory_id, world_col, world_row, state_json, updated_at)
             VALUES (@user_id, @factory_id, @world_col, @world_row, @state_json, datetime('now'))`
        ).run({
            user_id: uid,
            factory_id: next,
            world_col: c,
            world_row: r,
            state_json: String(stateJson)
        });
    } catch (e) {
        const msg = e && typeof e.message === 'string' ? e.message : String(e);
        if (/unique/i.test(msg)) return { ok: false, error: 'cell occupied' };
        return { ok: false, error: msg || 'insert failed' };
    }
    return { ok: true, factoryId: next };
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {number} minCol
 * @param {number} minRow
 * @param {number} maxCol
 * @param {number} maxRow
 * @returns {{ col: number, row: number, userId: number, factoryId: number, username: string }[]}
 */
export function listWorldMapCellsInRect(db, minCol, minRow, maxCol, maxRow) {
    const minC = Math.trunc(Number(minCol));
    const minR = Math.trunc(Number(minRow));
    const maxC = Math.trunc(Number(maxCol));
    const maxR = Math.trunc(Number(maxRow));
    if (!Number.isFinite(minC) || !Number.isFinite(maxC) || !Number.isFinite(minR) || !Number.isFinite(maxR)) return [];
    const rows = db
        .prepare(
            `SELECT f.world_col AS col, f.world_row AS row, f.user_id AS userId, f.factory_id AS factoryId,
                    u.username AS username
             FROM user_factories f
             JOIN users u ON u.id = f.user_id
             WHERE f.world_col >= @minC AND f.world_col <= @maxC
               AND f.world_row >= @minR AND f.world_row <= @maxR
             ORDER BY f.world_row, f.world_col`
        )
        .all({ minC, maxC, minR, maxR });
    return rows.map((x) => ({
        col: Number(x.col) | 0,
        row: Number(x.row) | 0,
        userId: Number(x.userId) | 0,
        factoryId: Number(x.factoryId) | 0,
        username: String(x.username || '')
    }));
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {number} userId
 * @param {number} factoryId
 * @param {string} stateJson
 */
export function addFactorySnapshoot(db, userId, factoryId, stateJson) {
    db.prepare(
        `INSERT INTO snapshoots (user_id, factory_id, state_json, created_at)
         VALUES (@user_id, @factory_id, @state_json, datetime('now'))`
    ).run({
        user_id: Number(userId),
        factory_id: Math.max(1, Number(factoryId) | 0),
        state_json: String(stateJson)
    });
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {number} userId
 * @param {number} factoryId
 * @returns {string | null}
 */
export function loadLatestFactorySnapshoot(db, userId, factoryId) {
    const uid = Number(userId) | 0;
    const fid = Math.max(1, Number(factoryId) | 0);
    if (!uid) return null;
    const row = db
        .prepare(
            `SELECT state_json
             FROM snapshoots
             WHERE user_id = @user_id AND factory_id = @factory_id
             ORDER BY created_at DESC, id DESC
             LIMIT 1`
        )
        .get({ user_id: uid, factory_id: fid });
    return row ? String(row.state_json) : null;
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {number} userId
 * @returns {Record<string, number>}
 */
export function getUserInventoryMap(db, userId) {
    const uid = Number(userId) | 0;
    if (!uid) return {};
    const rows = db
        .prepare(
            `SELECT item_id, qty
             FROM user_inventory
             WHERE user_id = @uid
               AND qty > 0`
        )
        .all({ uid });
    const out = {};
    for (const row of rows) {
        const id = String(row.item_id || '').trim();
        const qty = Number(row.qty || 0) | 0;
        if (!id || qty <= 0) continue;
        out[id] = qty;
    }
    return out;
}

/**
 * Add positive deltas to a user's inventory.
 * @param {import('better-sqlite3').Database} db
 * @param {number} userId
 * @param {Record<string, number>} deltas
 */
export function addToUserInventory(db, userId, deltas) {
    const uid = Number(userId) | 0;
    if (!uid || !deltas || typeof deltas !== 'object') return;
    const upsert = db.prepare(
        `INSERT INTO user_inventory (user_id, item_id, qty, updated_at)
         VALUES (@user_id, @item_id, @qty, datetime('now'))
         ON CONFLICT(user_id, item_id) DO UPDATE SET
            qty = qty + excluded.qty,
            updated_at = datetime('now')`
    );
    const tx = db.transaction((changes) => {
        for (const [itemId, rawQty] of Object.entries(changes)) {
            const id = String(itemId || '').trim();
            const qty = Math.floor(Number(rawQty));
            if (!id || !Number.isFinite(qty) || qty <= 0) continue;
            upsert.run({ user_id: uid, item_id: id, qty });
        }
    });
    tx(deltas);
}
