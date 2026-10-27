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
  type CliCredential,
} from "@kiteline/shared/protocol";

const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const secret = (bytes = 32) => randomBytes(bytes).toString("base64url");
type DeviceRow = {
  id: string;
  name: string;
  lastSeenAt: string | null;
  snapshot: string | null;
};
export type Login =
  | { kind: "owner"; id: string; expiresAt: string | null }
  | ({ kind: "cli" } & CliCredential);

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
      CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, expiresAt TEXT, name TEXT, deviceIds TEXT);
      CREATE TABLE IF NOT EXISTS devices (id TEXT PRIMARY KEY, name TEXT NOT NULL, tokenHash TEXT UNIQUE NOT NULL, lastSeenAt TEXT, snapshot TEXT);
      CREATE TABLE IF NOT EXISTS bindings (id TEXT PRIMARY KEY, hash TEXT UNIQUE NOT NULL, expiresAt TEXT NOT NULL, consumedDeviceId TEXT REFERENCES devices(id));
      CREATE TABLE IF NOT EXISTS taskSummaries (deviceId TEXT PRIMARY KEY REFERENCES devices(id), snapshot TEXT NOT NULL, observedAt TEXT NOT NULL);`);
      const columns = this.db.prepare("PRAGMA table_info(sessions)").all();
      if (!columns.some((column) => column.name === "deviceIds"))
        this.transaction(() => {
          this.db.exec(`ALTER TABLE sessions RENAME TO oldSessions;
            CREATE TABLE sessions (id TEXT PRIMARY KEY, expiresAt TEXT, name TEXT, deviceIds TEXT);
            INSERT INTO sessions (id,expiresAt) SELECT id,expiresAt FROM oldSessions;
            DROP TABLE oldSessions;`);
        });
    } catch (error) {
      this.db.close();
      throw error;
    }
  }
  private transaction<T>(run: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = run();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
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
    this.transaction(() => {
      const setup = this.db.prepare("SELECT hash,expiresAt FROM setup WHERE id=1").get() as
        | { hash: string; expiresAt: string }
        | undefined;
      if (this.initialized()) throw new AppError("conflict", "Already initialized");
      if (!setup || setup.hash !== digest(token) || setup.expiresAt <= new Date().toISOString())
        throw new AppError("forbidden", "Setup credentials are invalid or expired");
      this.db.prepare("INSERT INTO owner VALUES(1,?)").run(hash);
      this.db.exec("DELETE FROM setup");
    });
  }
  async verifyPassword(value: string) {
    const row = this.db.prepare("SELECT password FROM owner WHERE id=1").get() as
      | { password: string }
      | undefined;
    return !!row && (await bcrypt.compare(password(value), row.password));
  }
  createLogin(lifetime: number) {
    const token = secret();
    const expiresAt = new Date(Date.now() + lifetime).toISOString();
    this.db.prepare("INSERT INTO sessions(id,expiresAt) VALUES(?,?)").run(digest(token), expiresAt);
    return { kind: "owner" as const, token, id: digest(token), expiresAt };
  }
  ownerLogin(token: string | undefined): Extract<Login, { kind: "owner" }> | undefined {
    if (!token) return undefined;
    const row = this.db
      .prepare(
        `SELECT id,expiresAt FROM sessions WHERE id=? AND (expiresAt IS NULL OR expiresAt>?)
        AND deviceIds IS NULL`,
      )
      .get(digest(token), new Date().toISOString()) as
      | { id: string; expiresAt: string | null }
      | undefined;
    return row ? { kind: "owner", ...row } : undefined;
  }
  cliLogin(token: string | undefined): Extract<Login, { kind: "cli" }> | undefined {
    if (!token) return undefined;
    const row = this.db
      .prepare(
        `SELECT id,expiresAt,name,deviceIds FROM sessions WHERE id=? AND (expiresAt IS NULL OR expiresAt>?)
        AND deviceIds IS NOT NULL`,
      )
      .get(digest(token), new Date().toISOString()) as
      | (Omit<CliCredential, "deviceIds"> & { deviceIds: string })
      | undefined;
    return row
      ? { ...row, kind: "cli", deviceIds: JSON.parse(row.deviceIds) as string[] }
      : undefined;
  }
  createCredential(name: string, deviceIds: string[], expiresAt: string | null) {
    const known = new Set(this.devices().map((device) => device.id));
    if (deviceIds.some((id) => !known.has(id)))
      throw new AppError("not_found", "Selected device not found");
    const token = secret();
    const credential: CliCredential = { id: digest(token), name, deviceIds, expiresAt };
    this.db
      .prepare("INSERT INTO sessions VALUES(?,?,?,?)")
      .run(credential.id, expiresAt, name, JSON.stringify(deviceIds));
    return { token, credential };
  }
  credentials(): CliCredential[] {
    return (
      this.db
        .prepare("SELECT * FROM sessions WHERE deviceIds IS NOT NULL ORDER BY rowid DESC")
        .all() as (Omit<CliCredential, "deviceIds"> & { deviceIds: string })[]
    ).map((row) => ({ ...row, deviceIds: JSON.parse(row.deviceIds) as string[] }));
  }
  revokeCredential(id: string) {
    return !!this.db.prepare("DELETE FROM sessions WHERE id=? AND deviceIds IS NOT NULL").run(id)
      .changes;
  }
  logout(id: string) {
    this.db.prepare("DELETE FROM sessions WHERE id=?").run(id);
  }
  expiredLogins() {
    return this.db
      .prepare("SELECT id FROM sessions WHERE expiresAt<=?")
      .all(new Date().toISOString()) as { id: string }[];
  }
  async resetPassword(value: string) {
    if (!this.initialized()) throw new AppError("conflict", "Not initialized");
    const hash = await bcrypt.hash(password(value), 12);
    this.transaction(() => {
      this.db.prepare("UPDATE owner SET password=? WHERE id=1").run(hash);
      this.db.exec("DELETE FROM sessions");
    });
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
    return this.transaction(() => {
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
      return { deviceId, deviceToken };
    });
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
    this.transaction(() => {
      this.db.prepare("DELETE FROM bindings WHERE consumedDeviceId=?").run(id);
      this.db.prepare("DELETE FROM taskSummaries WHERE deviceId=?").run(id);
      if (!this.db.prepare("DELETE FROM devices WHERE id=?").run(id).changes)
        throw new AppError("not_found", "Device not found");
    });
  }
  saveSnapshot(id: string, snapshot: Metadata) {
    this.db.prepare("UPDATE devices SET snapshot=? WHERE id=?").run(JSON.stringify(snapshot), id);
  }
  recordConnectedAt(id: string) {
    this.db.prepare("UPDATE devices SET lastSeenAt=? WHERE id=?").run(new Date().toISOString(), id);
  }
  saveTaskSnapshot(id: string, snapshot: TaskSnapshot) {
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
