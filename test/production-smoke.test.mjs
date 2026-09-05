import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";

async function reservePort() {
  const socket = net.createServer();
  socket.listen(0, "127.0.0.1");
  await once(socket, "listening");
  const address = socket.address();
  const port = typeof address === "object" && address ? address.port : 0;
  socket.close();
  await once(socket, "close");
  return port;
}

async function waitForQueueToDrain(baseUrl, child) {
  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Compiled demo exited early with code ${child.exitCode}`);
    try {
      const response = await fetch(`${baseUrl}/health`);
      if (response.ok) {
        const body = await response.json();
        if (body.queues?.inboundQueued === 0 && body.queues?.outboundQueued === 0) return body;
      }
    } catch {
      // The server may still be binding. Retry until the bounded deadline.
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("Compiled demo did not become healthy and drain its queues");
}

async function stopChild(child) {
  if (child.exitCode !== null) return;
  const exited = once(child, "exit");
  child.kill();
  await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 3_000))]);
}

test("compiled mock demo starts and processes a signed webhook end to end", { timeout: 15_000 }, async () => {
  assert.equal(fs.existsSync(path.resolve("dist/index.js")), true, "production entrypoint must exist");
  assert.equal(fs.existsSync(path.resolve("dist/demo.js")), true, "safe demo entrypoint must exist");
  assert.equal(fs.existsSync(path.resolve("dist/test")), false, "production build must exclude tests");

  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "orderly-compiled-smoke-"));
  const port = await reservePort();
  const env = {
    ...process.env,
    PORT: String(port),
    LOG_LEVEL: "fatal",
    ORDERLY_DEMO_DATABASE_PATH: path.join(directory, "demo.db")
  };
  const service = spawn(process.execPath, [path.resolve("dist/demo.js")], {
    cwd: process.cwd(),
    env,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true
  });
  service.stdout.resume();
  service.stderr.resume();

  try {
    await waitForQueueToDrain(`http://127.0.0.1:${port}`, service);
    const sender = spawn(process.execPath, [path.resolve("dist/admin/send-demo-webhook.js")], {
      cwd: process.cwd(),
      env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true
    });
    const output = [];
    sender.stdout.on("data", (chunk) => output.push(chunk));
    sender.stderr.resume();
    const [code] = await once(sender, "exit");
    assert.equal(code, 0);
    assert.deepEqual(JSON.parse(Buffer.concat(output).toString("utf8")), {
      ok: true,
      mode: "mock",
      webhookAccepted: true
    });

    const health = await waitForQueueToDrain(`http://127.0.0.1:${port}`, service);
    assert.equal(health.ok, true);
    assert.equal(health.webhookReady, true);
    assert.equal(health.outboundReady, true);
    assert.equal(health.workersReady, true);
  } finally {
    await stopChild(service);
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
