import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { WebSocketServer, WebSocket } from "ws";

const PUBLIC_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "public");

const CONTENT_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".json": "application/json; charset=utf-8",
};

function send404(res) {
  res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
  res.end("Not Found");
}

async function serveStatic(req, res) {
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.writeHead(405, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Method Not Allowed");
    return;
  }

  let pathname;
  try {
    pathname = decodeURIComponent(new URL(req.url, "http://localhost").pathname);
  } catch {
    send404(res);
    return;
  }
  if (pathname === "/") pathname = "/index.html";

  // Normalize and ensure the resolved path stays inside PUBLIC_DIR (no traversal).
  const resolved = path.resolve(PUBLIC_DIR, "." + path.posix.normalize("/" + pathname));
  if (resolved !== PUBLIC_DIR && !resolved.startsWith(PUBLIC_DIR + path.sep)) {
    send404(res);
    return;
  }

  let info;
  try {
    info = await stat(resolved);
  } catch {
    send404(res);
    return;
  }
  if (!info.isFile()) {
    send404(res);
    return;
  }

  const contentType = CONTENT_TYPES[path.extname(resolved).toLowerCase()];
  if (!contentType) {
    send404(res);
    return;
  }

  res.writeHead(200, { "Content-Type": contentType, "Content-Length": info.size });
  if (req.method === "HEAD") {
    res.end();
    return;
  }
  const stream = createReadStream(resolved);
  stream.on("error", (err) => {
    console.error("[web-server] read error:", err.message);
    res.destroy();
  });
  stream.pipe(res);
}

export function startWebServer({ engine, port }) {
  const server = http.createServer((req, res) => {
    serveStatic(req, res).catch((err) => {
      console.error("[web-server] request error:", err);
      if (!res.headersSent) send404(res);
      else res.destroy();
    });
  });

  // maxPayload: 폰 클라이언트 메시지는 짧다(자유 입력 200자). 거대 프레임은 거부.
  const wss = new WebSocketServer({ server, maxPayload: 64 * 1024 });

  wss.on("connection", (ws) => {
    const state = engine.getState();
    ws.send(JSON.stringify({ type: "state", state }));
    if (state && state.scene != null) {
      ws.send(JSON.stringify({ type: "scene", scene: state.scene }));
    }

    ws.on("message", (data) => {
      let msg;
      try {
        msg = JSON.parse(data.toString());
      } catch (err) {
        console.error("[web-server] malformed WS message:", err.message);
        return;
      }
      try {
        handleMessage(msg);
      } catch (err) {
        console.error("[web-server] error handling WS message:", err);
      }
    });

    ws.on("error", (err) => {
      console.error("[web-server] ws client error:", err.message);
    });
  });

  wss.on("error", (err) => {
    console.error("[web-server] ws server error:", err.message);
  });

  function handleMessage(msg) {
    if (!msg || typeof msg !== "object") return;
    switch (msg.type) {
      case "choice": {
        const { player_id, choice_id } = msg;
        if (typeof player_id !== "string" || typeof choice_id !== "string") return;
        const choices = engine.getState()?.scene?.choices ?? [];
        const found = Array.isArray(choices) ? choices.find((c) => c && c.id === choice_id) : null;
        const label = found?.label ?? choice_id;
        engine.pushAction({ kind: "choice", player_id, choice_id, label });
        break;
      }
      case "free_text": {
        const { player_id, text } = msg;
        if (typeof player_id !== "string") return;
        if (typeof text !== "string" || text.trim() === "") return;
        // UI 입력창은 maxlength=200 — 그보다 훨씬 긴 텍스트는 잘라서 전달
        engine.pushAction({ kind: "free_text", player_id, text: text.slice(0, 500) });
        break;
      }
      case "roll": {
        engine.notifyRollTap(msg.request_id);
        break;
      }
      default:
        console.error("[web-server] unknown WS message type:", msg.type);
    }
  }

  function broadcast(msgObj) {
    const payload = JSON.stringify(msgObj);
    for (const client of wss.clients) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(payload);
      }
    }
  }

  function close() {
    for (const client of wss.clients) {
      client.close();
    }
    wss.close();
    server.close();
  }

  server.on("error", (err) => {
    console.error("[web-server] http server error:", err.message);
  });

  server.listen(port, () => {
    console.error(`[web-server] listening on http://localhost:${server.address().port}`);
  });

  return { broadcast, close };
}
