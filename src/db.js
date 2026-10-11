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
    UNIQUE(event_id, user_id),
    FOREIGN KEY(event_id) REFERENCES events(id) ON DELETE CASCADE
  );
`);

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

export function getParticipantCount(eventId) {
  const row = db
    .prepare(`SELECT COUNT(*) AS count FROM participants WHERE event_id = ?`)
    .get(eventId);
  return Number(row?.count ?? 0);
}

export function isJoined(eventId, userId) {
  const row = db
    .prepare(
      `SELECT 1 AS ok FROM participants WHERE event_id = ? AND user_id = ?`
    )
    .get(eventId, userId);
  return Boolean(row);
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

  return { ok: true, participants: getParticipants(eventId), event };
}

export function closeDb() {
  db.close();
}
