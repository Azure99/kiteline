import { expect, test } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { execFileSync } from "node:child_process";
import { Store } from "../src/store.js";

async function withStore(run: (store: Store) => void) {
  const root = await mkdtemp("/var/tmp/kiteline-device-delete-");
  const store = new Store(root);
  try {
    run(store);
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
}

test("device deletion removes its associations and preserves other devices and pending bindings", async () => {
  await withStore((store) => {
    const binding = store.newBinding();
    const first = store.bind(binding.code, "First");
    const otherBinding = store.newBinding();
    const other = store.bind(otherBinding.code, "Other");
    const pending = store.newBinding();
    store.taskSnapshot(first.deviceId, { revision: 1, items: [] });
    store.taskSnapshot(other.deviceId, { revision: 2, items: [] });

    store.deleteDevice(first.deviceId);

    expect(store.devices().map((device) => device.id)).toEqual([other.deviceId]);
    expect(store.taskSummaries()).toMatchObject([
      { deviceId: other.deviceId, snapshot: { revision: 2 } },
    ]);
    expect(() => store.binding(binding.bindingId)).toThrow("Binding record not found");
    expect(store.binding(otherBinding.bindingId)).toMatchObject({
      status: "consumed",
      deviceId: other.deviceId,
    });
    expect(store.binding(pending.bindingId)).toMatchObject({ status: "pending" });
    expect(() => store.deleteDevice(first.deviceId)).toThrow("Device not found");
  });
});

test("unsupported device records preserve an uncheckpointed WAL", async () => {
  const root = await mkdtemp("/var/tmp/kiteline-device-wal-");
  const path = join(root, "kiteline.sqlite");
  try {
    execFileSync(process.execPath, [
      "--input-type=module",
      "-e",
      `import { DatabaseSync } from 'node:sqlite';
       const db = new DatabaseSync(process.argv[1]);
       db.exec("PRAGMA journal_mode=WAL; CREATE TABLE devices (id TEXT, revoked INTEGER); INSERT INTO devices VALUES('retained-record', 1)");
       process.exit(0);`,
      path,
    ]);
    const before = await readFile(path);
    const wal = await readFile(path + "-wal");
    expect(wal.length).toBeGreaterThan(0);

    expect(() => new Store(root)).toThrow("Unsupported device database format");

    expect(await readFile(path)).toEqual(before);
    expect(await readFile(path + "-wal")).toEqual(wal);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a failed device deletion rolls back its binding and task summary together", async () => {
  await withStore((store) => {
    const binding = store.newBinding();
    const device = store.bind(binding.code, "Retained");
    store.taskSnapshot(device.deviceId, { revision: 1, items: [] });
    store.db.exec(`CREATE TRIGGER fail_delete BEFORE DELETE ON devices
      BEGIN SELECT RAISE(ABORT, 'fixture write failure'); END;`);

    expect(() => store.deleteDevice(device.deviceId)).toThrow("fixture write failure");

    expect(store.devices()).toHaveLength(1);
    expect(store.taskSummaries()).toHaveLength(1);
    expect(store.binding(binding.bindingId)).toMatchObject({ deviceId: device.deviceId });
    store.db.exec("DROP TRIGGER fail_delete");
    store.deleteDevice(device.deviceId);
    expect(store.devices()).toEqual([]);
  });
});

test("unsupported device records fail before changing the original database", async () => {
  const root = await mkdtemp("/var/tmp/kiteline-device-format-");
  const path = join(root, "kiteline.sqlite");
  try {
    const db = new DatabaseSync(path);
    db.exec("CREATE TABLE devices (id TEXT PRIMARY KEY, revoked INTEGER NOT NULL)");
    db.prepare("INSERT INTO devices VALUES(?,?)").run("retained-record", 1);
    db.close();
    const before = await readFile(path);

    expect(() => new Store(root)).toThrow("Unsupported device database format");

    expect(await readFile(path)).toEqual(before);
    const retained = new DatabaseSync(path, { readOnly: true });
    try {
      expect(retained.prepare("SELECT * FROM devices").all()).toEqual([
        { id: "retained-record", revoked: 1 },
      ]);
      expect(retained.prepare("PRAGMA journal_mode").get()).toEqual({ journal_mode: "delete" });
      expect(retained.prepare("SELECT name FROM sqlite_schema WHERE type='table'").all()).toEqual([
        { name: "devices" },
      ]);
    } finally {
      retained.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
