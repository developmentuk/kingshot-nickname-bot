const Database = require("better-sqlite3");

function initDb(path = "./bot.sqlite") {
  const db = new Database(path);
  db.pragma("journal_mode = WAL");

  db.exec(`
    CREATE TABLE IF NOT EXISTS alliances (
      guild_id TEXT NOT NULL,
      role_id TEXT NOT NULL,
      prefix TEXT NOT NULL,
      approval_channel_id TEXT NOT NULL,
      approver_role_ids TEXT DEFAULT '[]',
      enabled INTEGER DEFAULT 1,
      PRIMARY KEY (guild_id, role_id)
    );

    CREATE TABLE IF NOT EXISTS members (
      guild_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      ign TEXT,
      locked INTEGER DEFAULT 0,
      updated_at INTEGER DEFAULT (strftime('%s','now')),
      PRIMARY KEY (guild_id, user_id)
    );

    CREATE TABLE IF NOT EXISTS requests (
      guild_id TEXT NOT NULL,
      request_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      role_id TEXT NOT NULL,
      ign TEXT NOT NULL,
      status TEXT NOT NULL, -- PENDING/APPROVED/REJECTED
      created_at INTEGER DEFAULT (strftime('%s','now')),
      decided_by TEXT,
      decided_at INTEGER,
      PRIMARY KEY (guild_id, request_id)
    );
  `);

  return db;
}

module.exports = { initDb };
