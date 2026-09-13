import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { JsonlTransport } from "./transport";

// Deliberately opt in: these tests kill only their own processes, with a fresh
// CODEX_HOME and a local model provider. No user session or account is involved.
const binary = process.env.CODEXNEST_DURABLE_CODEX_BIN;
describe.skipIf(!binary)("real Codex durable delivery", () => {
  let directory: string;
  let server: Server;
  let providerUrl: string;
  let modelRequests: number;
  let holdModel: Promise<void> | undefined;
  let releaseModel: (() => void) | undefined;
  let askQuestion: boolean;
  let receivedInputs: unknown[];
  const children: ChildProcessWithoutNullStreams[] = [];

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "codexnest-durable-"));
    modelRequests = 0;
    holdModel = undefined;
    releaseModel = undefined;
    askQuestion = false;
    receivedInputs = [];
    server = createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      if (!request.url?.endsWith("/responses")) {
        response.writeHead(404).end();
        return;
      }
      modelRequests += 1;
      receivedInputs.push(JSON.parse(Buffer.concat(chunks).toString()));
      if (holdModel) await holdModel;
      const id = `response-${modelRequests}`;
      const item = {
        id: `assistant-${modelRequests}`,
        type: "message",
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text: "ACK", annotations: [] }],
      };
      const events = [
        { type: "response.created", response: { id } },
        { type: "response.output_item.added", output_index: 0, item: { ...item, content: [] } },
        {
          type: "response.output_text.delta",
          item_id: item.id,
          output_index: 0,
          content_index: 0,
          delta: "ACK",
        },
        { type: "response.output_item.done", output_index: 0, item },
        {
          type: "response.completed",
          response: {
            id,
            status: "completed",
            output: [item],
            usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
          },
        },
      ];
      if (askQuestion && modelRequests === 1) {
        const question = {
          type: "function_call",
          id: "question-item",
          call_id: "question-call",
          name: "request_user_input",
          arguments: JSON.stringify({
            questions: [
              {
                id: "choice",
                header: "Choice",
                question: "Which option?",
                options: [
                  { label: "A", description: "Option A" },
                  { label: "B", description: "Option B" },
                ],
              },
            ],
          }),
        };
        events.splice(1, 3, {
          type: "response.output_item.done",
          output_index: 0,
          item: question,
        } as unknown as (typeof events)[number]);
      }
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end(
        events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""),
      );
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing local provider address");
    providerUrl = `http://127.0.0.1:${address.port}/v1`;
  });

  afterEach(async () => {
    releaseModel?.();
    await Promise.all(children.splice(0).map(kill));
    server?.closeAllConnections();
    await new Promise<void>((resolve) => server?.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  });

  async function connect() {
    const env = { ...process.env, CODEX_HOME: directory };
    delete env.OPENAI_API_KEY;
    delete env.CODEX_API_KEY;
    const config: Record<string, unknown> = {
      model: "gpt-5.4",
      model_provider: "durability_test",
      "model_providers.durability_test.name": "Local durability test",
      "model_providers.durability_test.base_url": providerUrl,
      "model_providers.durability_test.wire_api": "responses",
      "model_providers.durability_test.requires_openai_auth": false,
      "model_providers.durability_test.supports_websockets": false,
      "features.hooks": true,
    };
    const args = Object.entries(config).flatMap(([key, value]) => [
      "-c",
      `${key}=${JSON.stringify(value)}`,
    ]);
    const command =
      process.env.CODEXNEST_DURABLE_CODEX_KIND === "app-server"
        ? ["--session-source", "cli"]
        : ["app-server"];
    const child = spawn(binary!, [...args, ...command, "--listen", "stdio://"], {
      env,
      cwd: directory,
      detached: process.platform !== "win32",
    });
    children.push(child);
    child.stderr.resume();
    const rpc = new JsonlTransport(child);
    const initialization = await rpc.request(
      "initialize",
      {
        clientInfo: { name: "codexnest_durability_test", version: "1" },
        capabilities: { experimentalApi: true },
      },
      30_000,
    );
    rpc.notify("initialized");
    return { child, rpc, initialization };
  }

  function start(rpc: JsonlTransport, id = randomUUID()) {
    return rpc.request<{ thread: { id: string } }>(
      "thread/start",
      {
        cwd: directory,
        clientCreationId: id,
        approvalPolicy: "never",
        sandbox: "read-only",
      },
      30_000,
    );
  }

  function input(threadId: string, clientUserMessageId: string) {
    return {
      threadId,
      clientUserMessageId,
      input: [{ type: "text", text: "Reply ACK", text_elements: [] }],
    };
  }

  async function trustTestHooks() {
    const { rpc, child } = await connect();
    const listed = await rpc.request<{
      data: Array<{ hooks: Array<{ key: string; currentHash: string }> }>;
    }>("hooks/list", { cwds: [directory] });
    const hooks = listed.data.flatMap(({ hooks }) => hooks);
    expect(hooks.length).toBeGreaterThan(0);
    await writeFile(
      join(directory, "config.toml"),
      hooks
        .map(
          (hook) =>
            `[hooks.state.${JSON.stringify(hook.key)}]\ntrusted_hash = ${JSON.stringify(hook.currentHash)}\n`,
        )
        .join("\n"),
    );
    await kill(child);
  }

  async function complete(rpc: JsonlTransport, action: () => Promise<unknown>): Promise<void> {
    let cleanup = () => {};
    const completed = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error("Turn did not complete"));
      }, 30_000);
      const listener = (event: { method: string; params: { turn?: { status: string } } }) => {
        if (event.method !== "turn/completed") return;
        cleanup();
        if (event.params.turn?.status !== "completed") reject(new Error("Local model turn failed"));
        else resolve();
      };
      cleanup = () => {
        clearTimeout(timer);
        rpc.off("notification", listener);
      };
      rpc.on("notification", listener);
    });
    try {
      await Promise.all([completed, action()]);
    } finally {
      cleanup();
    }
  }

  it("keeps a newly created empty thread after SIGKILL and replays its creation", async () => {
    const creationId = randomUUID();
    const first = await connect();
    expect(first.initialization).toMatchObject({ durableDeliveryVersion: 1 });
    const created = await start(first.rpc, creationId);
    await kill(first.child);
    const second = await connect();
    const resumed = await second.rpc.request<{ thread: { id: string } }>("thread/resume", {
      threadId: created.thread.id,
      excludeTurns: true,
    });
    expect(resumed.thread.id).toBe(created.thread.id);
    expect((await start(second.rpc, creationId)).thread.id).toBe(created.thread.id);
    expect(modelRequests).toBe(0);
  }, 90_000);

  it("shares one durable outcome for concurrent repeats and rejects a changed intent", async () => {
    const { rpc } = await connect();
    const creationId = randomUUID();
    const created = await Promise.all(Array.from({ length: 3 }, () => start(rpc, creationId)));
    expect(new Set(created.map(({ thread }) => thread.id)).size).toBe(1);
    const params = input(created[0]!.thread.id, `message_with_underscore:${randomUUID()}`);
    let receipts: Array<{ turn: { id: string }; deliveryReceipt: unknown }> = [];
    await complete(rpc, async () => {
      receipts = await Promise.all(
        Array.from({ length: 3 }, () => rpc.request("turn/start", params)),
      );
    });
    expect(receipts).toHaveLength(3);
    expect(receipts[1]).toEqual(receipts[0]);
    expect(receipts[2]).toEqual(receipts[0]);
    expect(receivedInputs[0]).toMatchObject({
      input: expect.arrayContaining([
        expect.objectContaining({
          role: "user",
          id: expect.stringMatching(/^msg_[0-9a-f-]{36}$/),
          content: expect.arrayContaining([
            expect.objectContaining({ type: "input_text", text: "Reply ACK" }),
          ]),
        }),
      ]),
    });
    await expect(
      rpc.request("turn/start", {
        ...params,
        input: [{ type: "text", text: "Changed", text_elements: [] }],
      }),
    ).rejects.toThrow(/different input|CONFLICT/i);
    expect(modelRequests).toBe(1);
  }, 90_000);

  it("does not acknowledge a failed creation write and can recover using the same creation ID", async () => {
    const { rpc } = await connect();
    const creationId = randomUUID();
    const sessions = join(directory, "sessions");
    await mkdir(sessions, { recursive: true });
    await chmod(sessions, 0o500);
    try {
      await expect(start(rpc, creationId)).rejects.toThrow();
    } finally {
      await chmod(sessions, 0o700);
    }
    const recovered = await start(rpc, creationId);
    expect((await start(rpc, creationId)).thread.id).toBe(recovered.thread.id);
    expect(modelRequests).toBe(0);
  }, 90_000);

  it("does not execute a rejected prompt or rerun its hook when the error reply is replayed", async () => {
    const hook = join(directory, "reject.py");
    const log = join(directory, "hook-calls");
    await writeFile(
      hook,
      `import json\nfrom pathlib import Path\nwith Path(${JSON.stringify(log)}).open('a') as f: f.write('called\\n')\nprint(json.dumps({'decision':'block','reason':'blocked by test hook'}))\n`,
    );
    await writeFile(
      join(directory, "hooks.json"),
      JSON.stringify({
        hooks: { UserPromptSubmit: [{ hooks: [{ type: "command", command: `python3 ${hook}` }] }] },
      }),
    );
    await trustTestHooks();
    const first = await connect();
    const { thread } = await start(first.rpc);
    const params = input(thread.id, randomUUID());
    await expect(first.rpc.request("turn/start", params)).rejects.toThrow(/blocked|REJECTED/i);
    await kill(first.child);
    const second = await connect();
    await expect(second.rpc.request("turn/start", params)).rejects.toThrow(/blocked|REJECTED/i);
    expect(await readFile(log, "utf8")).toBe("called\n");
    expect(modelRequests).toBe(0);
  }, 90_000);

  it("allows interruption while a steered message is waiting for its persistence barrier", async () => {
    holdModel = new Promise<void>((resolve) => {
      releaseModel = resolve;
    });
    const { rpc } = await connect();
    const { thread } = await start(rpc);
    const started = await rpc.request<{ turn: { id: string } }>(
      "turn/start",
      input(thread.id, randomUUID()),
    );
    await vi.waitFor(() => expect(modelRequests).toBe(1));
    const params = { ...input(thread.id, randomUUID()), expectedTurnId: started.turn.id };
    const delivery = rpc.request("turn/steer", params).then(
      () => "accepted",
      () => "unconfirmed",
    );
    await vi.waitFor(() => {
      const database = new DatabaseSync(join(directory, "queue_1.sqlite"), { readOnly: true });
      try {
        const operation = database
          .prepare("SELECT ready FROM delivery_operations WHERE operation_id = ?")
          .get(`input:${thread.id}/${params.clientUserMessageId}`);
        expect(operation).toMatchObject({ ready: 0 });
      } finally {
        database.close();
      }
    });
    await rpc.request("turn/interrupt", { threadId: thread.id, turnId: started.turn.id }, 5_000);
    expect(await delivery).toBe("unconfirmed");
    await expect(rpc.request("turn/steer", params)).rejects.toThrow(/REJECTED/);
    await expect(rpc.request("turn/steer", params)).rejects.toThrow(/REJECTED/);
  }, 90_000);

  it("does not start another turn when a completed message is replayed after restart", async () => {
    const first = await connect();
    const { thread } = await start(first.rpc);
    const params = input(thread.id, randomUUID());
    let turnId: string | undefined;
    await complete(first.rpc, async () => {
      const result = await first.rpc.request<{ turn: { id: string } }>("turn/start", params);
      turnId = result.turn.id;
    });
    await kill(first.child);
    const second = await connect();
    await second.rpc.request("thread/resume", { threadId: thread.id, excludeTurns: true });
    const repeated = await second.rpc.request<{ turn: { id: string } }>("turn/start", params);
    expect(repeated.turn.id).toBe(turnId);
    const history = await second.rpc.request<{ data: unknown[] }>("thread/turns/list", {
      threadId: thread.id,
      itemsView: "full",
    });
    expect(history.data).toHaveLength(1);
    expect(modelRequests).toBe(1);
  }, 90_000);

  it("recovers an input killed before its persistence barrier with the reserved turn ID", async () => {
    const hook = join(directory, "wait.py");
    const entered = join(directory, "entered");
    const gate = join(directory, "continue");
    await writeFile(
      hook,
      `from pathlib import Path\nimport time\nPath(${JSON.stringify(entered)}).touch()\nwhile not Path(${JSON.stringify(gate)}).exists(): time.sleep(0.02)\n`,
    );
    await writeFile(
      join(directory, "hooks.json"),
      JSON.stringify({
        hooks: { UserPromptSubmit: [{ hooks: [{ type: "command", command: `python3 ${hook}` }] }] },
      }),
    );
    await trustTestHooks();
    const first = await connect();
    const { thread } = await start(first.rpc);
    const params = input(thread.id, randomUUID());
    const waiting = first.rpc.request("turn/start", params).then(
      () => "accepted",
      () => "unconfirmed",
    );
    await vi.waitFor(async () => expect(await readFile(entered, "utf8")).toBe(""));
    const db = new DatabaseSync(join(directory, "queue_1.sqlite"), { readOnly: true });
    const reservation = db
      .prepare("SELECT result_json FROM delivery_operations WHERE operation_id = ?")
      .get(`input:${thread.id}/${params.clientUserMessageId}`)!;
    db.close();
    const reserved = JSON.parse(String(reservation.result_json)).turn_id;
    await kill(first.child);
    expect(await waiting).toBe("unconfirmed");
    expect(modelRequests).toBe(0);
    await writeFile(gate, "continue");
    const second = await connect();
    await second.rpc.request("thread/resume", { threadId: thread.id, excludeTurns: true });
    await complete(second.rpc, async () => {
      const result = await second.rpc.request<{ turn: { id: string } }>("turn/start", params);
      expect(result.turn.id).toBe(reserved);
    });
    expect(modelRequests).toBe(1);
    const history = await second.rpc.request<{ data: unknown[] }>("thread/turns/list", {
      threadId: thread.id,
      itemsView: "full",
    });
    expect(history.data).toHaveLength(1);
  }, 90_000);

  it("does not resurrect a consumed native queue entry after restart", async () => {
    const first = await connect();
    const { thread } = await start(first.rpc);
    const imagePath = join(directory, "queued.png");
    await writeFile(
      imagePath,
      Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC",
        "base64",
      ),
    );
    const params = {
      ...input(thread.id, randomUUID()),
      input: [
        { type: "text", text: "Queue this image", text_elements: [] },
        { type: "localImage", path: imagePath },
      ],
    };
    let queued: unknown;
    await complete(first.rpc, async () => {
      queued = await first.rpc.request("thread/queue/add", params);
    });
    await vi.waitFor(async () =>
      expect(await first.rpc.request("thread/queue/list", { threadId: thread.id })).toMatchObject({
        data: [],
      }),
    );
    await rm(imagePath);
    await kill(first.child);
    const second = await connect();
    expect(await second.rpc.request("thread/queue/add", params)).toEqual(queued);
    expect(await second.rpc.request("thread/queue/list", { threadId: thread.id })).toMatchObject({
      data: [],
    });
    expect(modelRequests).toBe(1);
  }, 90_000);

  it("retains an acknowledged input when killed immediately after turn/start", async () => {
    const first = await connect();
    const { thread } = await start(first.rpc);
    await complete(first.rpc, () =>
      first.rpc.request("turn/start", input(thread.id, randomUUID())),
    );
    const params = input(thread.id, randomUUID());
    const accepted = await first.rpc.request<{ turn: { id: string } }>("turn/start", params);
    await kill(first.child);
    const second = await connect();
    const page = await second.rpc.request<{
      data: Array<{ id: string; items: Array<{ type: string; clientId?: string }> }>;
    }>("thread/turns/list", { threadId: thread.id, itemsView: "full" });
    expect(
      page.data
        .filter((turn) =>
          turn.items.some(
            (item) => item.type === "userMessage" && item.clientId === params.clientUserMessageId,
          ),
        )
        .map((turn) => turn.id),
    ).toEqual([accepted.turn.id]);
  }, 90_000);

  it.each([false, true])(
    "persists the whole answer to its original question (restart before answer: %s)",
    async (restart) => {
      askQuestion = true;
      let current = await connect();
      const { thread } = await start(current.rpc);
      const question = once(current.rpc, "request");
      const started = await current.rpc.request<{ turn: { id: string } }>("turn/start", {
        ...input(thread.id, randomUUID()),
        collaborationMode: {
          mode: "plan",
          settings: { model: "gpt-5.4", reasoning_effort: "low", developer_instructions: null },
        },
      });
      const [request] = await question;
      expect(request).toMatchObject({
        method: "item/tool/requestUserInput",
        params: { itemId: "question-call" },
      });
      if (restart) {
        await kill(current.child);
        current = await connect();
        await current.rpc.request("thread/resume", { threadId: thread.id, excludeTurns: true });
      }
      const imagePath = join(directory, "image.png");
      await writeFile(
        imagePath,
        Buffer.from(
          "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC",
          "base64",
        ),
      );
      const params = {
        ...input(thread.id, randomUUID()),
        expectedTurnId: started.turn.id,
        input: [
          { type: "text", text: "A, and consider the attached image", text_elements: [] },
          { type: "localImage", path: imagePath },
        ],
        userInputResponse: {
          itemId: "question-call",
          response: { answers: { choice: { answers: ["A"] } } },
        },
      };
      const accepted = await current.rpc.request("turn/steer", params);
      if (!restart) {
        await vi.waitFor(() => expect(modelRequests).toBe(2));
        const sent = JSON.stringify((receivedInputs[1] as { input: unknown }).input);
        expect(sent).toContain("A, and consider the attached image");
        expect(sent).toContain("input_image");
      }
      await kill(current.child);
      const recovered = await connect();
      expect(await recovered.rpc.request("turn/steer", params)).toEqual(accepted);
      const page = await recovered.rpc.request<{
        data: Array<{
          id: string;
          items: Array<{ type: string; clientId?: string; content?: unknown[] }>;
        }>;
      }>("thread/turns/list", { threadId: thread.id, itemsView: "full" });
      const messages = page.data.flatMap((turn) =>
        turn.items.filter(
          (item) => item.type === "userMessage" && item.clientId === params.clientUserMessageId,
        ),
      );
      expect(messages).toHaveLength(1);
      expect(JSON.stringify(messages[0])).toContain("A, and consider the attached image");
      expect(JSON.stringify(messages[0])).toContain("image");
    },
    90_000,
  );
});

async function kill(child: ChildProcessWithoutNullStreams): Promise<void> {
  const exited =
    child.exitCode === null && child.signalCode === null ? once(child, "exit") : undefined;
  try {
    if (process.platform !== "win32" && child.pid) process.kill(-child.pid, "SIGKILL");
    else child.kill("SIGKILL");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
  if (exited) await exited;
}
