#!/usr/bin/env node
"use strict";

/*
 * mindmap-mcp
 * ------------------------------------------------------------------
 * A zero-dependency MCP server that generates editable tree / mind-map
 * diagrams. Each diagram is stored on disk and served by an embedded
 * HTTP server on a URL that is valid for exactly 3 days, after which
 * the URL stops working and the data is purged.
 *
 * HTTP-only: the MCP server itself speaks the Streamable HTTP transport at
 * POST /mcp, and the same process serves the editor URLs. One long-running
 * process does everything:
 *   node server.js            -> http://<host>/mcp  +  editor URLs
 */

const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { URL } = require("url");

// ---- configuration ----------------------------------------------------------
// Hosting platforms inject the listen port via PORT / MCP_HTTP_PORT (commonly
// 8080) and expect the process to bind 0.0.0.0. Honour those first, then our
// own MINDMAP_* overrides, then sensible defaults.
const PORT = parseInt(
  process.env.PORT || process.env.MCP_HTTP_PORT || process.env.MINDMAP_PORT || "8080",
  10
);
const HOST = process.env.HOST || process.env.MCP_HTTP_HOST || process.env.MINDMAP_HOST || "0.0.0.0";
const BASE_URL = (process.env.MINDMAP_BASE_URL || `http://localhost:${PORT}`).replace(/\/+$/, "");
const DATA_DIR = process.env.MINDMAP_DATA_DIR || path.join(__dirname, "data");
const PUBLIC_DIR = path.join(__dirname, "public");
const TTL_MS = 3 * 24 * 60 * 60 * 1000; // 3 days

fs.mkdirSync(DATA_DIR, { recursive: true });

// ---- storage ----------------------------------------------------------------
function tokenToFile(token) {
  // tokens are base64url; keep the filesystem safe
  if (!/^[A-Za-z0-9_-]{6,64}$/.test(token)) return null;
  return path.join(DATA_DIR, token + ".json");
}

function newToken() {
  return crypto.randomBytes(12).toString("base64url");
}

function saveDiagram(token, diagram) {
  const file = tokenToFile(token);
  fs.writeFileSync(file, JSON.stringify(diagram));
}

// Returns the diagram, or null if missing/expired. Expired files are purged.
function loadDiagram(token) {
  const file = tokenToFile(token);
  if (!file || !fs.existsSync(file)) return null;
  let diagram;
  try {
    diagram = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (_) {
    return null;
  }
  if (!diagram || typeof diagram.expiresAt !== "number" || Date.now() > diagram.expiresAt) {
    try { fs.unlinkSync(file); } catch (_) {}
    return null;
  }
  return diagram;
}

// Best-effort sweep of expired diagrams.
function sweep() {
  let files = [];
  try { files = fs.readdirSync(DATA_DIR); } catch (_) { return; }
  for (const f of files) {
    if (!f.endsWith(".json")) continue;
    loadDiagram(f.slice(0, -5)); // loadDiagram purges on expiry
  }
}

// ---- diagram helpers --------------------------------------------------------
function makeId() {
  return crypto.randomBytes(6).toString("hex");
}

// Normalise an arbitrary tree coming from the MCP caller into our node shape.
function normalizeNode(node) {
  if (node == null) return null;
  if (typeof node === "string") return { id: makeId(), text: node, collapsed: false, children: [] };
  const text = typeof node.text === "string" ? node.text
    : typeof node.title === "string" ? node.title
    : typeof node.name === "string" ? node.name
    : typeof node.label === "string" ? node.label
    : "";
  const rawChildren = Array.isArray(node.children) ? node.children
    : Array.isArray(node.nodes) ? node.nodes
    : [];
  return {
    id: makeId(),
    text,
    collapsed: !!node.collapsed,
    children: rawChildren.map(normalizeNode).filter(Boolean),
  };
}

function createDiagram({ title, root, tree }) {
  const source = root || tree;
  let rootNode;
  if (Array.isArray(source)) {
    rootNode = { id: makeId(), text: title || "Mind Map", collapsed: false, children: source.map(normalizeNode).filter(Boolean) };
  } else {
    rootNode = normalizeNode(source) || { id: makeId(), text: title || "Mind Map", collapsed: false, children: [] };
    if (!rootNode.text) rootNode.text = title || "Mind Map";
  }
  const now = Date.now();
  const token = newToken();
  const diagram = {
    token,
    title: title || rootNode.text || "Mind Map",
    root: rootNode,
    createdAt: now,
    expiresAt: now + TTL_MS,
    view: { x: 0, y: 0, scale: 1 },
  };
  saveDiagram(token, diagram);
  return diagram;
}

// ---- HTTP server ------------------------------------------------------------
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { "Content-Type": "application/json; charset=utf-8", "Content-Length": Buffer.byteLength(body) });
  res.end(body);
}

function serveStatic(res, rel) {
  const file = path.join(PUBLIC_DIR, rel);
  if (!file.startsWith(PUBLIC_DIR) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404); res.end("Not found"); return;
  }
  const ext = path.extname(file).toLowerCase();
  res.writeHead(200, { "Content-Type": MIME[ext] || "application/octet-stream" });
  fs.createReadStream(file).pipe(res);
}

function readBody(req, limit = 5 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > limit) { reject(new Error("payload too large")); req.destroy(); return; }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function handleHttp(req, res) {
  let parsed;
  try { parsed = new URL(req.url, BASE_URL); } catch (_) { res.writeHead(400); res.end(); return; }
  const pathname = parsed.pathname;

  // CORS (so browser-based MCP clients can reach /mcp)
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Mcp-Session-Id, Accept, Authorization");
  res.setHeader("Access-Control-Expose-Headers", "Mcp-Session-Id");
  if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }

  // MCP over Streamable HTTP transport
  if (pathname === "/mcp") { handleMcpHttp(req, res); return; }

  // Health check
  if (pathname === "/" || pathname === "/health") {
    sendJson(res, 200, { ok: true, service: "mindmap-mcp", mcp: `${BASE_URL}/mcp` });
    return;
  }

  // Editor page: /e/:token
  const editMatch = pathname.match(/^\/e\/([A-Za-z0-9_-]+)\/?$/);
  if (editMatch) {
    serveStatic(res, "editor.html");
    return;
  }

  // API: /api/d/:token
  const apiMatch = pathname.match(/^\/api\/d\/([A-Za-z0-9_-]+)$/);
  if (apiMatch) {
    const token = apiMatch[1];
    if (req.method === "GET") {
      const diagram = loadDiagram(token);
      if (!diagram) { sendJson(res, 404, { error: "not_found_or_expired" }); return; }
      sendJson(res, 200, diagram);
      return;
    }
    if (req.method === "PUT") {
      const existing = loadDiagram(token);
      if (!existing) { sendJson(res, 404, { error: "not_found_or_expired" }); return; }
      readBody(req).then((body) => {
        let incoming;
        try { incoming = JSON.parse(body); } catch (_) { sendJson(res, 400, { error: "bad_json" }); return; }
        // Only mutable fields are accepted; expiry is immutable.
        const updated = {
          ...existing,
          title: typeof incoming.title === "string" ? incoming.title : existing.title,
          root: incoming.root && typeof incoming.root === "object" ? incoming.root : existing.root,
          view: incoming.view && typeof incoming.view === "object" ? incoming.view : existing.view,
        };
        saveDiagram(token, updated);
        sendJson(res, 200, { ok: true, expiresAt: updated.expiresAt });
      }).catch(() => sendJson(res, 413, { error: "too_large" }));
      return;
    }
    res.writeHead(405); res.end(); return;
  }

  // Static assets (editor.js, editor.css, ...)
  if (/^\/[A-Za-z0-9_.-]+$/.test(pathname)) {
    serveStatic(res, pathname.slice(1));
    return;
  }

  res.writeHead(404); res.end("Not found");
}

let httpServer = null;
function startHttp() {
  if (httpServer) return;
  httpServer = http.createServer(handleHttp);
  httpServer.listen(PORT, HOST, () => {
    log(`HTTP server listening on ${HOST}:${PORT} (links use ${BASE_URL})`);
  });
  httpServer.on("error", (err) => {
    if (err.code === "EADDRINUSE") {
      log(`Port ${PORT} already in use — assuming another mindmap-mcp HTTP server is running.`);
    } else {
      log("HTTP server error: " + err.message);
    }
  });
  sweep();
  setInterval(sweep, 60 * 60 * 1000).unref();
}

function log(msg) {
  // MCP uses stdout for protocol; everything human-facing goes to stderr.
  process.stderr.write(`[mindmap-mcp] ${msg}\n`);
}

// ---- MCP (stdio JSON-RPC) ---------------------------------------------------
const SERVER_INFO = { name: "mindmap-mcp", version: "1.0.0" };
const PROTOCOL_VERSION = "2024-11-05";

const TOOLS = [
  {
    name: "create_mindmap",
    description:
      "Create a tree / mind-map diagram and get a shareable, editable URL that is valid for 3 days. " +
      "Pass a nested tree of nodes. The URL opens a dark-themed editor (pink curved connectors) where " +
      "the diagram can be edited directly; edits auto-save. After 3 days the URL stops working.",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string", description: "Diagram title (also used as the root node label if no root text is given)." },
        root: {
          type: "object",
          description:
            "Root node of the tree. Each node is { text: string, children?: node[] }. " +
            "A node may also be given as a plain string. If omitted, each item of `tree` becomes a top-level branch.",
        },
        tree: {
          type: "array",
          description: "Alternative to `root`: an array of top-level branches (each a node object or string) under a root named after `title`.",
          items: {},
        },
      },
      required: [],
    },
  },
  {
    name: "get_mindmap_url",
    description: "Given an existing diagram token, return its editor URL and remaining lifetime (or report that it has expired).",
    inputSchema: {
      type: "object",
      properties: { token: { type: "string", description: "The diagram token (the last path segment of its URL)." } },
      required: ["token"],
    },
  },
];

function toolCreateMindmap(args) {
  const diagram = createDiagram(args || {});
  const url = `${BASE_URL}/e/${diagram.token}`;
  const expires = new Date(diagram.expiresAt).toISOString();
  return {
    content: [
      {
        type: "text",
        text:
          `✅ Mind map created.\n\n` +
          `Editable URL (valid 3 days): ${url}\n` +
          `Expires: ${expires}\n` +
          `Token: ${diagram.token}\n\n` +
          `Open the URL to view and edit. Edits auto-save. The link stops working after it expires.`,
      },
    ],
    structuredContent: { url, token: diagram.token, expiresAt: diagram.expiresAt, expiresAtISO: expires },
  };
}

function toolGetUrl(args) {
  const token = args && args.token;
  const diagram = token ? loadDiagram(token) : null;
  if (!diagram) {
    return { content: [{ type: "text", text: `❌ No active diagram for that token (not found or expired).` }], isError: false };
  }
  const url = `${BASE_URL}/e/${diagram.token}`;
  const msLeft = diagram.expiresAt - Date.now();
  const hoursLeft = Math.max(0, Math.round(msLeft / (60 * 60 * 1000)));
  return {
    content: [{ type: "text", text: `URL: ${url}\nExpires in ~${hoursLeft}h (${new Date(diagram.expiresAt).toISOString()})` }],
    structuredContent: { url, token: diagram.token, expiresAt: diagram.expiresAt, hoursLeft },
  };
}

function handleRpc(msg) {
  const { id, method, params } = msg;
  const isRequest = id !== undefined && id !== null;

  try {
    if (method === "initialize") {
      return reply(id, {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER_INFO,
      });
    }
    if (method === "tools/list") {
      return reply(id, { tools: TOOLS });
    }
    if (method === "tools/call") {
      const name = params && params.name;
      const args = (params && params.arguments) || {};
      let result;
      if (name === "create_mindmap") result = toolCreateMindmap(args);
      else if (name === "get_mindmap_url") result = toolGetUrl(args);
      else return replyError(id, -32602, `Unknown tool: ${name}`);
      return reply(id, result);
    }
    if (method === "ping") {
      return reply(id, {});
    }
    // Notifications (initialized, cancelled, ...) need no response.
    if (!isRequest) return null;
    return replyError(id, -32601, `Method not found: ${method}`);
  } catch (err) {
    if (!isRequest) return null;
    return replyError(id, -32603, "Internal error: " + (err && err.message));
  }
}

function reply(id, result) { return { jsonrpc: "2.0", id, result }; }
function replyError(id, code, message) { return { jsonrpc: "2.0", id, error: { code, message } }; }

// MCP over Streamable HTTP transport.
// POST /mcp  -> JSON-RPC request(s); respond with application/json (or 202 for
//              notification-only payloads). GET/DELETE are accepted but no-op
//              since this server never initiates messages and keeps no session.
function handleMcpHttp(req, res) {
  if (req.method === "GET") {
    // No server-initiated SSE stream is offered.
    res.writeHead(405, { Allow: "POST, DELETE, OPTIONS" });
    res.end();
    return;
  }
  if (req.method === "DELETE") {
    // Session termination: nothing to clean up (stateless).
    res.writeHead(204); res.end();
    return;
  }
  if (req.method !== "POST") { res.writeHead(405).end(); return; }

  readBody(req).then((body) => {
    let msg;
    try { msg = JSON.parse(body); } catch (_) {
      sendJson(res, 400, { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
      return;
    }

    let out, hasInitialize = false;
    if (Array.isArray(msg)) {
      out = msg.map(handleRpc).filter(Boolean);
      hasInitialize = msg.some((m) => m && m.method === "initialize");
    } else {
      hasInitialize = msg && msg.method === "initialize";
      const r = handleRpc(msg);
      out = r ? [r] : [];
    }

    // Issue a session id on initialize (clients may echo it back; we don't enforce it).
    if (hasInitialize) res.setHeader("Mcp-Session-Id", newToken());

    if (out.length === 0) {
      // Only notifications/responses were sent -> no body to return.
      res.writeHead(202); res.end();
      return;
    }
    const payload = Array.isArray(msg) ? out : out[0];
    sendJson(res, 200, payload);
  }).catch(() => {
    sendJson(res, 400, { jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid request" } });
  });
}

// ---- entrypoint -------------------------------------------------------------
startHttp();
log(`MCP endpoint: ${BASE_URL}/mcp`);
