import { Database } from "bun:sqlite";
import { homedir } from "node:os";
import { join } from "node:path";
import type { MessageJson, CursorState } from "./types.js";

type MessageRow = {
  id: string;
  session_id: string;
  time_created: number;
  data: string;
};

export type SessionInfo = {
  id: string;
  title: string;
  slug: string;
  parentId: string | null;
  agent: string | null;
};

export function getOpenCodeStoragePath(): string {
  const xdgDataHome =
    process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share");
  return join(xdgDataHome, "opencode");
}

function openDb(dataPath: string): Database {
  return new Database(join(dataPath, "opencode.db"), { readonly: true });
}

function rowToMessage(row: MessageRow): MessageJson {
  const data = JSON.parse(row.data) as Omit<MessageJson, "id" | "sessionID">;
  return {
    id: row.id,
    sessionID: row.session_id,
    ...data,
  };
}

function isValidMessage(msg: MessageJson, providerFilter?: string): boolean {
  if (msg.role === "user") return false;
  if (!msg.tokens) return false;

  if (providerFilter) {
    const providerId = msg.model?.providerID ?? msg.providerID ?? "unknown";
    if (providerId.toLowerCase() !== providerFilter) return false;
  }

  return true;
}

export async function loadRecentMessages(
  storagePath: string,
  hoursBack: number = 24,
  providerFilter?: string
): Promise<MessageJson[]> {
  const cutoffTime = Date.now() - hoursBack * 60 * 60 * 1000;

  try {
    const db = openDb(storagePath);
    try {
      const rows = db
        .query(
          `SELECT id, session_id, time_created, data FROM message WHERE time_created >= ?`
        )
        .all(cutoffTime) as MessageRow[];

      return rows
        .map(rowToMessage)
        .filter((msg) => isValidMessage(msg, providerFilter));
    } finally {
      db.close();
    }
  } catch (err) {
    console.error(`Error reading recent messages: ${err}`);
    return [];
  }
}

export async function loadMessages(
  storagePath: string,
  providerFilter?: string
): Promise<MessageJson[]> {
  try {
    const db = openDb(storagePath);
    try {
      const rows = db
        .query(`SELECT id, session_id, time_created, data FROM message`)
        .all() as MessageRow[];

      return rows
        .map(rowToMessage)
        .filter((msg) => isValidMessage(msg, providerFilter));
    } finally {
      db.close();
    }
  } catch (err) {
    console.error(`Error reading messages from database: ${err}`);
    return [];
  }
}

export function createCursor(): CursorState {
  return { lastTimestamp: 0 };
}

export async function loadMessagesIncremental(
  storagePath: string,
  cursor: CursorState,
  providerFilter?: string
): Promise<{ messages: MessageJson[]; cursor: CursorState }> {
  try {
    const db = openDb(storagePath);
    try {
      const rows = db
        .query(
          `SELECT id, session_id, time_created, data FROM message WHERE time_created > ?`
        )
        .all(cursor.lastTimestamp) as MessageRow[];

      const messages = rows
        .map(rowToMessage)
        .filter((msg) => isValidMessage(msg, providerFilter));

      let maxTimestamp = cursor.lastTimestamp;
      for (const row of rows) {
        if (row.time_created > maxTimestamp) {
          maxTimestamp = row.time_created;
        }
      }

      return {
        messages,
        cursor: { lastTimestamp: maxTimestamp },
      };
    } finally {
      db.close();
    }
  } catch (err) {
    console.error(`Error in incremental load: ${err}`);
    return {
      messages: [],
      cursor: { lastTimestamp: cursor.lastTimestamp },
    };
  }
}

export function loadSessions(storagePath: string): Map<string, SessionInfo> {
  try {
    const db = openDb(storagePath);
    try {
      // Detect which columns the session table actually has so older DBs
      // without parent_id / agent keep working.
      const cols = new Set(
        (
          db.query(`PRAGMA table_info(session)`).all() as Array<{
            name: string;
          }>
        ).map((c) => c.name)
      );

      const selectCols = [
        "id",
        "title",
        "slug",
        cols.has("parent_id") ? "parent_id" : "NULL AS parent_id",
        cols.has("agent") ? "agent" : "NULL AS agent",
      ];

      const rows = db
        .query(`SELECT ${selectCols.join(", ")} FROM session`)
        .all() as Array<{
        id: string;
        title: string;
        slug: string;
        parent_id: string | null;
        agent: string | null;
      }>;

      const sessions = new Map<string, SessionInfo>();
      for (const row of rows) {
        sessions.set(row.id, {
          id: row.id,
          title: row.title,
          slug: row.slug,
          parentId: row.parent_id,
          agent: row.agent,
        });
      }
      return sessions;
    } finally {
      db.close();
    }
  } catch (err) {
    console.error(`Error loading sessions: ${err}`);
    return new Map();
  }
}
