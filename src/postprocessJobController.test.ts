import { describe, expect, it, vi } from "vitest";
import { PostprocessJobController } from "./postprocessJobController";

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 8; i++) await Promise.resolve();
}

describe("PostprocessJobController", () => {
  it("完了結果を通知し、idle に戻る", async () => {
    const onCompleted = vi.fn();
    const controller = new PostprocessJobController<string>({ onCompleted });

    const result = await controller.start(({ jobId, signal, checkpoint }) => {
      expect(jobId).toBe(1);
      expect(signal.aborted).toBe(false);
      checkpoint();
      return "formatted";
    });

    expect(result).toBe("formatted");
    expect(onCompleted).toHaveBeenCalledOnce();
    expect(onCompleted).toHaveBeenCalledWith("formatted", 1);
    expect(controller.getState()).toEqual({ status: "idle" });
    expect(controller.isRunning()).toBe(false);
  });

  it("失敗を通知し、同じエラーで reject する", async () => {
    const failure = new Error("format failed");
    const onFailed = vi.fn();
    const controller = new PostprocessJobController({ onFailed });

    await expect(controller.start(() => Promise.reject(failure))).rejects.toBe(failure);

    expect(onFailed).toHaveBeenCalledOnce();
    expect(onFailed).toHaveBeenCalledWith(failure, 1);
    expect(controller.getState()).toEqual({ status: "idle" });
  });

  it("同時に二つの job を開始できない", async () => {
    const gate = deferred<void>();
    const controller = new PostprocessJobController<void>();
    const first = controller.start(() => gate.promise);

    expect(controller.getState()).toEqual({ status: "running", jobId: 1 });
    expect(() => controller.start(() => undefined)).toThrow(
      "A postprocess job is already running",
    );

    gate.resolve();
    await first;
  });

  it("cancel は多重通知せず、実行Promiseを直ちに AbortError にする", async () => {
    const gate = deferred<string>();
    const onCancelled = vi.fn();
    const onCompleted = vi.fn();
    const controller = new PostprocessJobController<string>({
      onCancelled,
      onCompleted,
    });
    const running = controller.start(() => gate.promise);
    await flushMicrotasks();

    expect(controller.cancel()).toBe(true);
    expect(controller.cancel()).toBe(false);
    await expect(running).rejects.toMatchObject({ name: "AbortError" });
    expect(onCancelled).toHaveBeenCalledOnce();
    expect(onCancelled).toHaveBeenCalledWith(1);
    expect(controller.getState()).toEqual({ status: "idle" });

    gate.resolve("late result");
    await flushMicrotasks();
    expect(onCompleted).not.toHaveBeenCalled();
    expect(controller.getState()).toEqual({ status: "idle" });
  });

  it("Abortを無視したexecutorでも、貼り付け直前のcheckpointが副作用を防ぐ", async () => {
    const gate = deferred<void>();
    const paste = vi.fn();
    const controller = new PostprocessJobController<void>();
    const running = controller.start(async ({ checkpoint }) => {
      await gate.promise;
      checkpoint();
      paste();
    });

    await flushMicrotasks();
    controller.cancel();
    await expect(running).rejects.toMatchObject({ name: "AbortError" });

    gate.resolve();
    await flushMicrotasks();
    expect(paste).not.toHaveBeenCalled();
  });

  it("取り消した旧jobの遅延完了が、新jobの完了通知を壊さない", async () => {
    const oldGate = deferred<string>();
    const onCompleted = vi.fn();
    const onCancelled = vi.fn();
    const controller = new PostprocessJobController<string>({
      onCompleted,
      onCancelled,
    });

    const oldJob = controller.start(() => oldGate.promise);
    await flushMicrotasks();
    controller.cancel();
    await expect(oldJob).rejects.toMatchObject({ name: "AbortError" });

    const newJob = controller.start(async ({ checkpoint }) => {
      checkpoint();
      return "new";
    });
    await expect(newJob).resolves.toBe("new");

    oldGate.resolve("old");
    await flushMicrotasks();
    expect(onCancelled).toHaveBeenCalledTimes(1);
    expect(onCompleted).toHaveBeenCalledTimes(1);
    expect(onCompleted).toHaveBeenCalledWith("new", 2);
    expect(controller.getState()).toEqual({ status: "idle" });
  });

  it("旧jobのcheckpointは新jobの実行中でもAbortErrorを投げる", async () => {
    const oldGate = deferred<void>();
    const newGate = deferred<void>();
    const staleCommit = vi.fn();
    const controller = new PostprocessJobController<void>();

    const oldJob = controller.start(async ({ checkpoint }) => {
      await oldGate.promise;
      checkpoint();
      staleCommit();
    });
    await flushMicrotasks();
    controller.cancel();
    await expect(oldJob).rejects.toMatchObject({ name: "AbortError" });

    const newJob = controller.start(() => newGate.promise);
    oldGate.resolve();
    await flushMicrotasks();
    expect(staleCommit).not.toHaveBeenCalled();
    expect(controller.getState()).toEqual({ status: "running", jobId: 2 });

    newGate.resolve();
    await newJob;
  });

  it("dispose は実行中jobを一度だけ取り消し、以後のstartを拒否する", async () => {
    const gate = deferred<void>();
    const onCancelled = vi.fn();
    const controller = new PostprocessJobController<void>({ onCancelled });
    const running = controller.start(() => gate.promise);
    await flushMicrotasks();

    controller.dispose();
    controller.dispose();

    await expect(running).rejects.toMatchObject({ name: "AbortError" });
    expect(onCancelled).toHaveBeenCalledOnce();
    expect(controller.getState()).toEqual({ status: "disposed" });
    expect(controller.isRunning()).toBe(false);
    expect(controller.cancel()).toBe(false);
    expect(() => controller.start(() => undefined)).toThrow(
      "PostprocessJobController is disposed",
    );
  });

  it("executor自身のAbortErrorも取消として一度だけ通知する", async () => {
    const onCancelled = vi.fn();
    const onFailed = vi.fn();
    const controller = new PostprocessJobController<void>({
      onCancelled,
      onFailed,
    });

    await expect(
      controller.start(() => {
        throw new DOMException("aborted", "AbortError");
      }),
    ).rejects.toMatchObject({ name: "AbortError" });

    expect(onCancelled).toHaveBeenCalledOnce();
    expect(onFailed).not.toHaveBeenCalled();
    expect(controller.getState()).toEqual({ status: "idle" });
  });
});
