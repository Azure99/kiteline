import { serverLimits } from "./limits.js";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { resolve } from "node:path";
import bcrypt from "bcryptjs";
import {
  AppError,
  type Device,
  type Metadata,
  type TaskSnapshot,
  type DeviceTaskSummary,
} from "@kiteline/shared/protocol";

export const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const secret = (bytes = 32) => randomBytes(bytes).toString("base64url");
type DeviceRow = {
  id: string;
  name: string;
  lastSeenAt: string | null;
  snapshot: string | null;
};
export interface Login {
  id: string;
  expiresAt: string;
}

export function password(value: unknown): string {
  if (typeof value !== "string" || Buffer.byteLength(value) < 8 || Buffer.byteLength(value) > 72)
    throw new AppError("invalid_argument", "Password must be 8 to 72 UTF-8 bytes");
  return value;
}
export class Store {
  readonly db: DatabaseSync;
  constructor(directory: string) {
    const path = resolve(directory, "kiteline.sqlite");
    this.db = new DatabaseSync(path);
    try {
      this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS owner (id INTEGER PRIMARY KEY CHECK(id=1), password TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS setup (id INTEGER PRIMARY KEY CHECK(id=1), hash TEXT NOT NULL, expiresAt TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, expiresAt TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS devices (id TEXT PRIMARY KEY, name TEXT NOT NULL, tokenHash TEXT UNIQUE NOT NULL, lastSeenAt TEXT, snapshot TEXT);
      CREATE TABLE IF NOT EXISTS bindings (id TEXT PRIMARY KEY, hash TEXT UNIQUE NOT NULL, expiresAt TEXT NOT NULL, consumedDeviceId TEXT REFERENCES devices(id));
      CREATE TABLE IF NOT EXISTS taskSummaries (deviceId TEXT PRIMARY KEY REFERENCES devices(id), snapshot TEXT NOT NULL, observedAt TEXT NOT NULL);`);
    } catch (error) {
      this.db.close();
      throw error;
    }
  }
  initialized() {
    return !!this.db.prepare("SELECT id FROM owner WHERE id=1").get();
  }
  newSetupToken() {
    if (this.initialized()) throw new AppError("conflict", "Already initialized");
    const token = secret();
    this.db
      .prepare("INSERT OR REPLACE INTO setup VALUES(1,?,?)")
      .run(digest(token), new Date(Date.now() + serverLimits.setupTokenLifetime).toISOString());
    return token;
  }
  ensureSetupToken() {
    if (this.initialized() || this.db.prepare("SELECT id FROM setup WHERE id=1").get())
      return undefined;
    return this.newSetupToken();
  }
  async setup(token: string, value: string) {
    const hash = await bcrypt.hash(password(value), 12);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const setup = this.db.prepare("SELECT hash,expiresAt FROM setup WHERE id=1").get() as
        | { hash: string; expiresAt: string }
        | undefined;
      if (this.initialized()) throw new AppError("conflict", "Already initialized");
      if (!setup || setup.hash !== digest(token) || setup.expiresAt <= new Date().toISOString())
        throw new AppError("forbidden", "Setup credentials are invalid or expired");
      this.db.prepare("INSERT INTO owner VALUES(1,?)").run(hash);
      this.db.exec("DELETE FROM setup; COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  async verifyPassword(value: string) {
    const row = this.db.prepare("SELECT password FROM owner WHERE id=1").get() as
      | { password: string }
      | undefined;
    return !!row && (await bcrypt.compare(password(value), row.password));
  }
  createSession(lifetime: number) {
    const token = secret();
    const expiresAt = new Date(Date.now() + lifetime).toISOString();
    this.db.prepare("INSERT INTO sessions VALUES(?,?)").run(digest(token), expiresAt);
    return { token, id: digest(token), expiresAt };
  }
  session(token: string | undefined): Login | undefined {
    if (!token) return undefined;
    return this.db
      .prepare("SELECT id,expiresAt FROM sessions WHERE id=? AND expiresAt>?")
      .get(digest(token), new Date().toISOString()) as Login | undefined;
  }
  logout(id: string) {
    this.db.prepare("DELETE FROM sessions WHERE id=?").run(id);
  }
  expiredSessions() {
    return this.db
      .prepare("SELECT id FROM sessions WHERE expiresAt<=?")
      .all(new Date().toISOString()) as { id: string }[];
  }
  async resetPassword(value: string) {
    if (!this.initialized()) throw new AppError("conflict", "Not initialized");
    const hash = await bcrypt.hash(password(value), 12);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare("UPDATE owner SET password=? WHERE id=1").run(hash);
      this.db.exec("DELETE FROM sessions; COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  newBinding() {
    const bindingId = randomUUID();
    const code = secret(16);
    const expiresAt = new Date(Date.now() + serverLimits.bindingLifetime).toISOString();
    this.db
      .prepare("DELETE FROM bindings WHERE consumedDeviceId IS NULL AND expiresAt<=?")
      .run(new Date().toISOString());
    this.db
      .prepare("INSERT INTO bindings VALUES(?,?,?,NULL)")
      .run(bindingId, digest(code), expiresAt);
    return { bindingId, code, expiresAt };
  }
  binding(id: string) {
    const row = this.db
      .prepare("SELECT expiresAt,consumedDeviceId FROM bindings WHERE id=?")
      .get(id) as { expiresAt: string; consumedDeviceId: string | null } | undefined;
    if (!row) throw new AppError("not_found", "Binding record not found");
    return {
      bindingId: id,
      expiresAt: row.expiresAt,
      status: row.consumedDeviceId
        ? "consumed"
        : row.expiresAt <= new Date().toISOString()
          ? "expired"
          : "pending",
      ...(row.consumedDeviceId ? { deviceId: row.consumedDeviceId } : {}),
    };
  }
  bind(code: string, name: string) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const row = this.db
        .prepare(
          "SELECT id FROM bindings WHERE hash=? AND consumedDeviceId IS NULL AND expiresAt>?",
        )
        .get(digest(code), new Date().toISOString()) as { id: string } | undefined;
      if (!row)
        throw new AppError("forbidden", "Binding code is invalid, expired, or already used");
      const deviceId = randomUUID();
      const deviceToken = secret();
      this.db
        .prepare("INSERT INTO devices(id,name,tokenHash) VALUES(?,?,?)")
        .run(deviceId, name, digest(deviceToken));
      this.db.prepare("UPDATE bindings SET consumedDeviceId=? WHERE id=?").run(deviceId, row.id);
      this.db.exec("COMMIT");
      return { deviceId, deviceToken };
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  authenticateAgent(token: string) {
    return this.db.prepare("SELECT id FROM devices WHERE tokenHash=?").get(digest(token)) as
      | { id: string }
      | undefined;
  }
  devices(): Device[] {
    return (
      this.db
        .prepare("SELECT id,name,lastSeenAt,snapshot FROM devices ORDER BY rowid")
        .all() as DeviceRow[]
    ).map((row) => ({
      id: row.id,
      name: row.name,
      status: "offline",
      lastSeenAt: row.lastSeenAt,
      ...(row.snapshot ? { snapshot: JSON.parse(row.snapshot) as Metadata } : {}),
    }));
  }
  renameDevice(id: string, name: string) {
    if (!this.db.prepare("UPDATE devices SET name=? WHERE id=?").run(name, id).changes)
      throw new AppError("not_found", "Device not found");
  }
  deleteDevice(id: string) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare("DELETE FROM bindings WHERE consumedDeviceId=?").run(id);
      this.db.prepare("DELETE FROM taskSummaries WHERE deviceId=?").run(id);
      if (!this.db.prepare("DELETE FROM devices WHERE id=?").run(id).changes)
        throw new AppError("not_found", "Device not found");
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  snapshot(id: string, snapshot: Metadata) {
    this.db.prepare("UPDATE devices SET snapshot=? WHERE id=?").run(JSON.stringify(snapshot), id);
  }
  connected(id: string) {
    this.db.prepare("UPDATE devices SET lastSeenAt=? WHERE id=?").run(new Date().toISOString(), id);
  }
  taskSnapshot(id: string, snapshot: TaskSnapshot) {
    this.db
      .prepare(
        "INSERT INTO taskSummaries(deviceId,snapshot,observedAt) VALUES(?,?,?) ON CONFLICT(deviceId) DO UPDATE SET snapshot=excluded.snapshot,observedAt=excluded.observedAt",
      )
      .run(id, JSON.stringify(snapshot), new Date().toISOString());
  }
  taskSummaries(deviceId?: string): Omit<DeviceTaskSummary, "current">[] {
    const rows = this.db
      .prepare(
        `SELECT devices.id AS deviceId,taskSummaries.snapshot,taskSummaries.observedAt
      FROM devices LEFT JOIN taskSummaries ON devices.id=taskSummaries.deviceId
      ${deviceId === undefined ? "" : "WHERE devices.id=?"} ORDER BY devices.rowid`,
      )
      .all(...(deviceId === undefined ? [] : [deviceId])) as {
      deviceId: string;
      snapshot: string | null;
      observedAt: string | null;
    }[];
    return rows.map((row) => ({
      ...row,
      snapshot: row.snapshot === null ? null : (JSON.parse(row.snapshot) as TaskSnapshot),
    }));
  }
  close() {
    this.db.close();
  }
}
