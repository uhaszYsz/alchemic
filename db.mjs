import Database from 'better-sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dbPath = path.join(__dirname, 'data', 'alchemic.db');

const SEED = [
    ['wood', '🪵', 'Wood'],
    ['stone', '🪨', 'Stone'],
    ['water', '💧', 'Water'],
    ['dirt', '🟫', 'Dirt']
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

function migrateItemsUniqueName(db) {
    db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_items_name_unique_nocase ON items(name COLLATE NOCASE)');
}

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
            created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE TABLE IF NOT EXISTS user_sessions (
            token_hash TEXT PRIMARY KEY NOT NULL,
            user_id INTEGER NOT NULL,
            created_at TEXT NOT NULL DEFAULT (datetime('now')),
            expires_at TEXT NOT NULL,
            FOREIGN KEY(user_id) REFERENCES users(id)
        );
        CREATE TABLE IF NOT EXISTS user_factory_state (
            user_id INTEGER PRIMARY KEY NOT NULL,
            state_json TEXT NOT NULL,
            updated_at TEXT NOT NULL DEFAULT (datetime('now')),
            FOREIGN KEY(user_id) REFERENCES users(id)
        );
    `);
    migrateItemsIconPath(db);
    migrateItemsDiscoveredBy(db);
    migrateItemsDiscoveredAt(db);
    migrateItemsNameColor(db);
    migrateItemsVotes(db);
    migrateItemsUniqueName(db);
    migrateDiscoveryProposalTables(db);
    const n = db.prepare('SELECT COUNT(*) AS c FROM items').get().c;
    if (n === 0) {
        const ins = db.prepare(
            'INSERT INTO items (id, emoji, name, ingredient_a, ingredient_b) VALUES (@id, @emoji, @name, NULL, NULL)'
        );
        const tx = db.transaction((rows) => {
            for (const [id, emoji, name] of rows) {
                ins.run({ id, emoji, name });
            }
        });
        tx(SEED);
    }
    return db;
}

/** @returns {Record<string, { emoji: string, name: string, nameColor?: string, a?: string, b?: string, iconPath?: string, discoveredBy?: number, discoveredAt?: string, upvotes?: number, downvotes?: number }>} */
export function getItemsMap(db) {
    const rows = db
        .prepare(
            'SELECT id, emoji, name, name_color, ingredient_a AS a, ingredient_b AS b, icon_path, discovered_by, discovered_at, upvotes, downvotes FROM items ORDER BY id'
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
        if (row.discovered_by != null) {
            entry.discoveredBy = Number(row.discovered_by);
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
        `INSERT INTO items (id, emoji, name, name_color, ingredient_a, ingredient_b, discovered_by, discovered_at)
         VALUES (@id, @emoji, @name, @name_color, @ingredient_a, @ingredient_b, @discovered_by, @discovered_at)
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
 */
export function setItemIconPath(db, id, iconPathRelative) {
    db.prepare('UPDATE items SET icon_path = @p WHERE id = @id').run({
        p: iconPathRelative,
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
                `INSERT INTO users (username, password_hash, password_salt)
                 VALUES (@username, @password_hash, @password_salt)`
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
 * @returns {{ id: number, username: string } | null}
 */
export function getUserById(db, userId) {
    const row = db.prepare('SELECT id, username FROM users WHERE id = ?').get(Number(userId));
    return row || null;
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
 * @param {string} stateJson
 */
export function saveUserFactoryState(db, userId, stateJson) {
    db.prepare(
        `INSERT INTO user_factory_state (user_id, state_json, updated_at)
         VALUES (@user_id, @state_json, datetime('now'))
         ON CONFLICT(user_id) DO UPDATE SET
            state_json = excluded.state_json,
            updated_at = datetime('now')`
    ).run({
        user_id: Number(userId),
        state_json: String(stateJson)
    });
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {number} userId
 * @returns {string | null}
 */
export function loadUserFactoryState(db, userId) {
    const row = db.prepare('SELECT state_json FROM user_factory_state WHERE user_id = ?').get(Number(userId));
    return row ? String(row.state_json) : null;
}
