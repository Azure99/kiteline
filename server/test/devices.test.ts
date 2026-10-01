import { expect, test } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
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
