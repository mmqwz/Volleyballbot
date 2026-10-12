import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dataDir = process.env.DATA_DIR
  ? path.resolve(process.env.DATA_DIR)
  : path.join(__dirname, "..", "data");
fs.mkdirSync(dataDir, { recursive: true });

const db = new DatabaseSync(path.join(dataDir, "volleyball.db"));

db.exec(`
  PRAGMA journal_mode = WAL;

  CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    event_time TEXT NOT NULL,
    place TEXT NOT NULL,
    payment_details TEXT NOT NULL,
    max_players INTEGER NOT NULL DEFAULT 0,
    created_by INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'active',
    announce_chat_id INTEGER,
    announce_message_id INTEGER,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS participants (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    event_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL,
    full_name TEXT NOT NULL,
    username TEXT,
    joined_at TEXT NOT NULL DEFAULT (datetime('now')),
    paid INTEGER NOT NULL DEFAULT 0,
    paid_by INTEGER,
    paid_at TEXT,
    UNIQUE(event_id, user_id),
    FOREIGN KEY(event_id) REFERENCES events(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS ephemeral_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    event_id INTEGER NOT NULL,
    chat_id INTEGER NOT NULL,
    message_id INTEGER NOT NULL,
    UNIQUE(chat_id, message_id)
  );
`);

function ensureColumn(table, column, ddl) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!cols.some((c) => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
  }
}

ensureColumn("participants", "paid", "INTEGER NOT NULL DEFAULT 0");
ensureColumn("participants", "paid_by", "INTEGER");
ensureColumn("participants", "paid_at", "TEXT");

export function createEvent({
  title,
  eventTime,
  place,
  paymentDetails,
  maxPlayers,
  createdBy,
}) {
  const result = db
    .prepare(
      `INSERT INTO events (title, event_time, place, payment_details, max_players, created_by)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .run(title, eventTime, place, paymentDetails, maxPlayers, createdBy);
  return getEvent(Number(result.lastInsertRowid));
}

export function getEvent(id) {
  return db.prepare(`SELECT * FROM events WHERE id = ?`).get(id) ?? null;
}

export function listActiveEvents() {
  return db
    .prepare(
      `SELECT * FROM events
       WHERE status = 'active'
       ORDER BY datetime(created_at) DESC`
    )
    .all();
}

export function setEventStatus(id, status) {
  db.prepare(`UPDATE events SET status = ? WHERE id = ?`).run(status, id);
}

export function setAnnounceMessage(eventId, chatId, messageId) {
  db.prepare(
    `UPDATE events SET announce_chat_id = ?, announce_message_id = ? WHERE id = ?`
  ).run(chatId, messageId, eventId);
}

export function getParticipants(eventId) {
  return db
    .prepare(
      `SELECT * FROM participants
       WHERE event_id = ?
       ORDER BY datetime(joined_at) ASC`
    )
    .all(eventId);
}

export function getParticipant(eventId, userId) {
  return (
    db
      .prepare(
        `SELECT * FROM participants WHERE event_id = ? AND user_id = ?`
      )
      .get(eventId, userId) ?? null
  );
}

export function getParticipantCount(eventId) {
  const row = db
    .prepare(`SELECT COUNT(*) AS count FROM participants WHERE event_id = ?`)
    .get(eventId);
  return Number(row?.count ?? 0);
}

export function isJoined(eventId, userId) {
  return Boolean(getParticipant(eventId, userId));
}

export function joinEvent(eventId, user) {
  const event = getEvent(eventId);
  if (!event || event.status !== "active") {
    return { ok: false, reason: "not_found" };
  }
  if (isJoined(eventId, user.id)) {
    return { ok: false, reason: "already" };
  }
  const count = getParticipantCount(eventId);
  if (event.max_players > 0 && count >= event.max_players) {
    return { ok: false, reason: "full" };
  }

  const fullName = [user.first_name, user.last_name].filter(Boolean).join(" ");
  db.prepare(
    `INSERT INTO participants (event_id, user_id, full_name, username)
     VALUES (?, ?, ?, ?)`
  ).run(eventId, user.id, fullName || `id${user.id}`, user.username ?? null);

  return { ok: true, participants: getParticipants(eventId), event };
}

export function leaveEvent(eventId, userId) {
  const event = getEvent(eventId);
  if (!event || event.status !== "active") {
    return { ok: false, reason: "not_found" };
  }
  if (!isJoined(eventId, userId)) {
    return { ok: false, reason: "not_joined" };
  }

  db.prepare(
    `DELETE FROM participants WHERE event_id = ? AND user_id = ?`
  ).run(eventId, userId);

  // убрать этого человека из чужих черновиков оплаты нельзя в БД — только в сессии
  return { ok: true, participants: getParticipants(eventId), event: getEvent(eventId) };
}

export function markPaid(eventId, targetUserIds, paidBy) {
  const event = getEvent(eventId);
  if (!event || event.status !== "active") {
    return { ok: false, reason: "not_found" };
  }
  if (!isJoined(eventId, paidBy)) {
    return { ok: false, reason: "payer_not_joined" };
  }

  const uniqueIds = [...new Set(targetUserIds.map(Number))];
  if (!uniqueIds.length) {
    return { ok: false, reason: "empty" };
  }

  const invalid = [];
  const alreadyPaid = [];
  const okIds = [];

  for (const uid of uniqueIds) {
    const p = getParticipant(eventId, uid);
    if (!p) {
      invalid.push(uid);
      continue;
    }
    if (Number(p.paid) === 1) {
      alreadyPaid.push(p);
      continue;
    }
    okIds.push(uid);
  }

  if (invalid.length) {
    return { ok: false, reason: "invalid_selection", invalid };
  }
  if (alreadyPaid.length && !okIds.length) {
    return { ok: false, reason: "already_paid", alreadyPaid };
  }
  if (!okIds.length) {
    return { ok: false, reason: "empty" };
  }

  const stmt = db.prepare(
    `UPDATE participants
     SET paid = 1, paid_by = ?, paid_at = datetime('now')
     WHERE event_id = ? AND user_id = ? AND paid = 0`
  );
  for (const uid of okIds) {
    stmt.run(paidBy, eventId, uid);
  }

  return {
    ok: true,
    paidIds: okIds,
    skippedPaid: alreadyPaid,
    participants: getParticipants(eventId),
    event: getEvent(eventId),
  };
}

export function trackEphemeral(eventId, chatId, messageId) {
  db.prepare(
    `INSERT OR IGNORE INTO ephemeral_messages (event_id, chat_id, message_id)
     VALUES (?, ?, ?)`
  ).run(eventId ?? 0, chatId, messageId);
}

export function listEphemeralByChat(chatId) {
  return db
    .prepare(
      `SELECT message_id FROM ephemeral_messages WHERE chat_id = ?`
    )
    .all(chatId)
    .map((r) => Number(r.message_id));
}

export function clearEphemeralByChat(chatId) {
  db.prepare(`DELETE FROM ephemeral_messages WHERE chat_id = ?`).run(chatId);
}

export function removeEphemeral(chatId, messageId) {
  db.prepare(
    `DELETE FROM ephemeral_messages WHERE chat_id = ? AND message_id = ?`
  ).run(chatId, messageId);
}

/** message_id карточек событий, которые нельзя удалять */
export function protectedMessageIds(chatId) {
  return new Set(
    db
      .prepare(
        `SELECT announce_message_id AS mid FROM events
         WHERE announce_chat_id = ? AND announce_message_id IS NOT NULL`
      )
      .all(chatId)
      .map((r) => Number(r.mid))
      .filter((n) => Number.isFinite(n))
  );
}

export function closeDb() {
  db.close();
}
