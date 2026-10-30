import { expect, test, vi } from "vitest";
import { adaptTouchGestures } from "../src/terminal/touch-selection";

function point(identifier = 1, clientX = 10) {
  return { identifier, clientX, clientY: 10 };
}

function touch(
  document: EventTarget,
  type: string,
  time: number,
  touches: ReturnType<typeof point>[],
  changed = point(),
) {
  const event = new Event(type, { cancelable: true });
  Object.defineProperties(event, {
    touches: { value: touches },
    changedTouches: { value: [changed] },
    timeStamp: { value: time },
  });
  document.dispatchEvent(event);
}

function createGestures() {
  const document = new EventTarget();
  const container = Object.assign(new EventTarget(), { ownerDocument: document });
  const state = { inBody: true, selecting: false };
  const onTap = vi.fn();
  const screen = { contains: () => state.inBody };
  const adapter = adaptTouchGestures(
    container as HTMLElement,
    screen as unknown as HTMLElement,
    () => state.selecting,
    onTap,
  );
  return { document, container, state, onTap, adapter };
}

test("a single stationary body tap requests input", () => {
  const { document, onTap } = createGestures();

  touch(document, "touchstart", 0, [point()]);
  touch(document, "touchend", 100, []);

  expect(onTap).toHaveBeenCalledOnce();
});

test("moving and returning to the start does not request input", () => {
  const { document, onTap } = createGestures();

  touch(document, "touchstart", 0, [point()]);
  touch(document, "touchmove", 10, [point(1, 12)]);
  touch(document, "touchmove", 20, [point()]);
  touch(document, "touchend", 100, []);

  expect(onTap).not.toHaveBeenCalled();
});

test("an xterm scrolling gesture cancels the body tap", () => {
  const { document, container, onTap } = createGestures();

  touch(document, "touchstart", 0, [point()]);
  const gesture = new Event("-xterm-gesturechange", { cancelable: true });
  container.dispatchEvent(gesture);
  touch(document, "touchend", 100, []);

  expect(gesture.defaultPrevented).toBe(false);
  expect(onTap).not.toHaveBeenCalled();
});

test("holding the body does not request input", () => {
  const { document, onTap } = createGestures();

  touch(document, "touchstart", 0, [point()]);
  touch(document, "touchend", 550, []);

  expect(onTap).not.toHaveBeenCalled();
});

test("a cancelled touch does not request input on a later touchend", () => {
  const { document, onTap } = createGestures();

  touch(document, "touchstart", 0, [point()]);
  touch(document, "touchcancel", 50, []);
  touch(document, "touchend", 100, []);

  expect(onTap).not.toHaveBeenCalled();
});

test("a tap that starts during selection stays blocked after selection ends", () => {
  const { document, container, state, onTap } = createGestures();
  state.selecting = true;

  touch(document, "touchstart", 0, [point()]);
  state.selecting = false;
  touch(document, "touchend", 100, []);
  const gesture = new Event("-xterm-gesturecontextmenu", { cancelable: true });
  container.dispatchEvent(gesture);

  expect(gesture.defaultPrevented).toBe(true);
  expect(onTap).not.toHaveBeenCalled();
});

test("selection beginning before release cancels the body tap", () => {
  const { document, state, onTap } = createGestures();

  touch(document, "touchstart", 0, [point()]);
  state.selecting = true;
  touch(document, "touchend", 100, []);

  expect(onTap).not.toHaveBeenCalled();
});

test("a second finger outside the body invalidates the original body tap", () => {
  const { document, state, onTap } = createGestures();

  touch(document, "touchstart", 0, [point()]);
  state.inBody = false;
  touch(document, "touchstart", 20, [point(), point(2)], point(2));
  touch(document, "touchend", 30, [point()], point(2));
  state.inBody = true;
  touch(document, "touchend", 100, []);

  expect(onTap).not.toHaveBeenCalled();
});

test("a tap outside the body does not request input", () => {
  const { document, state, onTap } = createGestures();
  state.inBody = false;

  touch(document, "touchstart", 0, [point()]);
  touch(document, "touchend", 100, []);

  expect(onTap).not.toHaveBeenCalled();
});

test("xterm's tap is prevented while a later body tap still requests input", () => {
  const { document, container, onTap } = createGestures();
  const gesture = new Event("-xterm-gesturetap", { cancelable: true });

  container.dispatchEvent(gesture);
  touch(document, "touchstart", 0, [point()]);
  touch(document, "touchend", 100, []);

  expect(gesture.defaultPrevented).toBe(true);
  expect(onTap).toHaveBeenCalledOnce();
});

test("dispose stops body taps from requesting input", () => {
  const { document, onTap, adapter } = createGestures();
  adapter.dispose();

  touch(document, "touchstart", 0, [point()]);
  touch(document, "touchend", 100, []);
  expect(onTap).not.toHaveBeenCalled();
});
