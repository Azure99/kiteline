import { expect, test } from "vitest";
import { adaptTouchGestures } from "../src/terminal/touch-selection";

test("only a single, stationary body tap requests input", () => {
  const document = new EventTarget();
  const container = Object.assign(new EventTarget(), { ownerDocument: document });
  let inBody = true;
  let selecting = false;
  let taps = 0;
  const screen = { contains: () => inBody };
  const adapter = adaptTouchGestures(
    container as HTMLElement,
    screen as unknown as HTMLElement,
    () => selecting,
    () => taps++,
  );
  const point = (identifier = 1, clientX = 10) => ({ identifier, clientX, clientY: 10 });
  const touch = (
    type: string,
    time: number,
    touches: ReturnType<typeof point>[],
    changed = point(),
  ) => {
    const event = new Event(type, { cancelable: true });
    Object.defineProperties(event, {
      touches: { value: touches },
      changedTouches: { value: [changed] },
      timeStamp: { value: time },
    });
    document.dispatchEvent(event);
  };
  const start = () => touch("touchstart", 0, [point()]);
  const end = (time = 100) => touch("touchend", time, []);
  start();
  end();
  expect(taps).toBe(1);

  start();
  touch("touchmove", 10, [point(1, 12)]);
  touch("touchmove", 20, [point()]);
  end();
  start();
  container.dispatchEvent(new Event("-xterm-gesturechange"));
  end();
  start();
  end(550);
  start();
  touch("touchcancel", 50, []);
  end();
  selecting = true;
  start();
  selecting = false;
  end();
  start();
  selecting = true;
  end();
  selecting = false;
  start();
  inBody = false;
  touch("touchstart", 20, [point(), point(2)], point(2));
  touch("touchend", 30, [point()], point(2));
  inBody = true;
  end();
  inBody = false;
  start();
  end();
  inBody = true;
  expect(taps).toBe(1);

  const tap = new Event("-xterm-gesturetap", { cancelable: true });
  container.dispatchEvent(tap);
  expect(tap.defaultPrevented).toBe(true);
  start();
  end();
  expect(taps).toBe(2);
  adapter.dispose();
  start();
  end();
  expect(taps).toBe(2);
});
