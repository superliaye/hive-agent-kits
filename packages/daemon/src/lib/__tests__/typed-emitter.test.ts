import { describe, expect, test } from "bun:test";
import { TypedEmitter } from "../typed-emitter.ts";

type Events = {
  ping: { msg: string };
  pong: { count: number };
};

describe("TypedEmitter", () => {
  test("dispatches to a subscribed listener", async () => {
    const e = new TypedEmitter<Events>();
    const received: string[] = [];
    e.on("ping", (ev) => {
      received.push(ev.msg);
    });
    await e.emit("ping", { msg: "hello" });
    expect(received).toEqual(["hello"]);
  });

  test("dispatches to multiple listeners in registration order", async () => {
    const e = new TypedEmitter<Events>();
    const order: number[] = [];
    e.on("ping", () => {
      order.push(1);
    });
    e.on("ping", () => {
      order.push(2);
    });
    await e.emit("ping", { msg: "x" });
    expect(order).toEqual([1, 2]);
  });

  test("awaits async listeners", async () => {
    const e = new TypedEmitter<Events>();
    let done = false;
    e.on("ping", async () => {
      await Bun.sleep(5);
      done = true;
    });
    await e.emit("ping", { msg: "x" });
    expect(done).toBe(true);
  });

  test("first throwing listener fails the emit (block-on-failure)", async () => {
    const e = new TypedEmitter<Events>();
    e.on("ping", () => {
      throw new Error("boom");
    });
    await expect(e.emit("ping", { msg: "x" })).rejects.toThrow("boom");
  });

  test("subsequent listeners do not run after a throw", async () => {
    const e = new TypedEmitter<Events>();
    let secondRan = false;
    e.on("ping", () => {
      throw new Error("boom");
    });
    e.on("ping", () => {
      secondRan = true;
    });
    await e.emit("ping", { msg: "x" }).catch(() => {});
    expect(secondRan).toBe(false);
  });

  test("returns a dispose function that unsubscribes", async () => {
    const e = new TypedEmitter<Events>();
    let calls = 0;
    const dispose = e.on("ping", () => {
      calls++;
    });
    await e.emit("ping", { msg: "x" });
    dispose();
    await e.emit("ping", { msg: "x" });
    expect(calls).toBe(1);
  });

  test("emit with no listeners is a no-op", async () => {
    const e = new TypedEmitter<Events>();
    await expect(e.emit("ping", { msg: "x" })).resolves.toBeUndefined();
  });

  test("listeners are isolated per event type", async () => {
    const e = new TypedEmitter<Events>();
    let pingCalls = 0;
    let pongCalls = 0;
    e.on("ping", () => {
      pingCalls++;
    });
    e.on("pong", () => {
      pongCalls++;
    });
    await e.emit("ping", { msg: "x" });
    expect(pingCalls).toBe(1);
    expect(pongCalls).toBe(0);
  });

  test("listener can dispose itself during emit without breaking iteration", async () => {
    const e = new TypedEmitter<Events>();
    let calls = 0;
    const dispose = e.on("ping", () => {
      calls++;
      dispose();
    });
    await e.emit("ping", { msg: "1" });
    await e.emit("ping", { msg: "2" });
    expect(calls).toBe(1);
  });
});
