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

export function openDb() {
    const db = new Database(dbPath);
    db.pragma('journal_mode = WAL');
    db.exec(`
        CREATE TABLE IF NOT EXISTS items (
            id TEXT PRIMARY KEY NOT NULL,
            emoji TEXT NOT NULL,
            name TEXT NOT NULL,
            ingredient_a TEXT,
            ingredient_b TEXT,
            discovered_by INTEGER,
            discovered_at TEXT
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

/** @returns {Record<string, { emoji: string, name: string, a?: string, b?: string, iconPath?: string, discoveredBy?: number, discoveredAt?: string }>} */
export function getItemsMap(db) {
    const rows = db
        .prepare(
            'SELECT id, emoji, name, ingredient_a AS a, ingredient_b AS b, icon_path, discovered_by, discovered_at FROM items ORDER BY id'
        )
        .all();
    const out = {};
    for (const row of rows) {
        const entry = { emoji: row.emoji, name: row.name };
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
        out[row.id] = entry;
    }
    return out;
}

/**
 * Insert or update a catalog item (discoveries). Preserves existing icon_path when not provided.
 * @param {import('better-sqlite3').Database} db
 * @param {{ id: string, emoji: string, name: string, ingredient_a: string, ingredient_b: string, discovered_by?: number | null, discovered_at?: string | null }} row
 */
export function upsertItem(db, row) {
    const { id, emoji, name, ingredient_a, ingredient_b, discovered_by, discovered_at } = row;
    db.prepare(
        `INSERT INTO items (id, emoji, name, ingredient_a, ingredient_b, discovered_by, discovered_at)
         VALUES (@id, @emoji, @name, @ingredient_a, @ingredient_b, @discovered_by, @discovered_at)
         ON CONFLICT(id) DO UPDATE SET
           emoji = excluded.emoji,
           name = excluded.name,
           ingredient_a = excluded.ingredient_a,
           ingredient_b = excluded.ingredient_b,
           discovered_by = COALESCE(items.discovered_by, excluded.discovered_by),
           discovered_at = COALESCE(items.discovered_at, excluded.discovered_at)`
    ).run({
        id,
        emoji,
        name,
        ingredient_a,
        ingredient_b,
        discovered_by: discovered_by ?? null,
        discovered_at: discovered_at ?? null
    });
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
