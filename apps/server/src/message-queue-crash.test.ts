import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, it } from "vitest";

import { StateStore } from "./state/store";

it("keeps the complete accepted outbox after killing the Node process at HTTP 202", async () => {
  const directory = await mkdtemp(join(tmpdir(), "codexnest-node-crash-"));
  const statePath = join(directory, "state.json");
  const worker = `
    import { createServer } from 'node:http';
    import { StateStore } from ${JSON.stringify(new URL("./state/store.ts", import.meta.url).href)};
    import { MessageQueue } from ${JSON.stringify(new URL("./message-queue.ts", import.meta.url).href)};
    const store = new StateStore(process.env.DURABLE_TEST_STATE_PATH);
    await store.load();
    await store.update(state => { state.threadMeta.thread = { pinned: false, lastReadUpdatedAt: 0 }; });
    const queue = new MessageQueue(store, {
      paused: () => true, currentTurnId: () => null, shouldSteerQueuedMessage: () => false,
      start: async () => { throw new Error('unexpected delivery'); },
      steer: async () => { throw new Error('unexpected delivery'); },
      deliveredTurnId: async () => null, publish: () => {},
    });
    const server = createServer(async (request, response) => {
      let body = ''; for await (const chunk of request) body += chunk;
      const input = JSON.parse(body);
      await queue.enqueue('thread', input.input, input.images, input.clientMessageId, {
        replyToUserInput: input.replyToUserInput,
      });
      response.writeHead(202).end();
    });
    server.listen(0, '127.0.0.1', () => process.stdout.write(String(server.address().port) + '\\n'));
  `;
  let child: ChildProcessWithoutNullStreams | undefined;
  try {
    child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", worker], {
      env: { ...process.env, DURABLE_TEST_STATE_PATH: statePath },
    });
    let errors = "";
    child.stderr.on("data", (chunk) => {
      errors += String(chunk);
    });
    const port = await new Promise<number>((resolve, reject) => {
      child!.stdout.once("data", (chunk) => resolve(Number(String(chunk).trim())));
      child!.once("exit", (code) => reject(new Error(`Outbox worker exited ${code}: ${errors}`)));
    });
    const replyToUserInput = {
      turnId: "turn",
      itemId: "question",
      answers: { choice: ["Original answer"] },
    };
    const images = ["data:image/png;base64,AA=="];
    const response = await fetch(`http://127.0.0.1:${port}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        input: "Do not lose this answer",
        clientMessageId: "crash-message",
        images,
        replyToUserInput,
      }),
    });
    expect(response.status).toBe(202);
    const exited = once(child, "exit");
    child.kill("SIGKILL");
    await exited;
    const reopened = new StateStore(statePath);
    await reopened.load();
    expect(reopened.view().messageQueues?.thread).toEqual([
      {
        id: "crash-message",
        threadId: "thread",
        text: "Do not lose this answer",
        images,
        replyToUserInput,
        status: "queued",
        createdAt: expect.any(Number),
      },
    ]);
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) {
      const exited = once(child, "exit");
      child.kill("SIGKILL");
      await exited;
    }
    await rm(directory, { recursive: true, force: true });
  }
}, 20_000);
