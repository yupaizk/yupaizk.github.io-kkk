// Undertone 本機伺服器：在自己的電腦上跑生成器。
// 送出 public/ 的網頁，並提供 claude-shim.js 用的 API：呼叫 Claude、存測試紀錄和圖片。
// 資料存在 data/ 資料夾；API 金鑰讀 settings.txt。只接受本機連線。
import http from "node:http";
import { readFile, writeFile, mkdir, readdir, rm, copyFile, rename, stat } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { exec } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Anthropic from "@anthropic-ai/sdk";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(ROOT, "public");
const DATA = path.join(ROOT, "data");
const OLD_DATA = path.join(ROOT, "undertone-old-data");
const PORT = 8787;
const NAME_RE = /^[A-Za-z0-9_-]{1,64}$/;
const BLOB_RE = /^[0-9a-f]{32}$/;
const MAX_IMAGES = 6;
const MAX_BODY = 30 * 1024 * 1024;

/* ---------- 設定 ---------- */

function loadSettings() {
  const file = path.join(ROOT, "settings.txt");
  const out = {};
  if (!existsSync(file)) return out;
  for (const line of readFileSync(file, "utf8").replace(/^﻿/, "").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*?)\s*$/);
    if (m && m[2]) out[m[1]] = m[2];
  }
  return out;
}
const settings = loadSettings();
const API_KEY = settings.ANTHROPIC_API_KEY && !settings.ANTHROPIC_API_KEY.includes("...") ? settings.ANTHROPIC_API_KEY : "";
const MODEL = settings.CLAUDE_MODEL || "claude-opus-5-5";
const EFFORT = settings.CLAUDE_EFFORT || "medium";
const DAILY_LIMIT = parseInt(settings.DAILY_AI_LIMIT || "300", 10);
// ANTHROPIC_BASE_URL 只在測試時接假的 API 用。
const client = API_KEY ? new Anthropic({ apiKey: API_KEY, baseURL: settings.ANTHROPIC_BASE_URL || undefined }) : null;

/* ---------- 路由 ---------- */

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, "http://localhost");
    const p = decodeURIComponent(url.pathname);
    if (p.startsWith("/api/")) return await api(req, res, p, url);
    if (p.startsWith("/_blob/")) return await getBlob(res, p.slice(7));
    return await serveStatic(res, p);
  } catch (e) {
    console.error(e);
    if (!res.headersSent) json(res, { error: "server_error" }, 500);
  }
});

async function api(req, res, p, url) {
  const method = req.method;
  if (p === "/api/me") return json(res, { ok: true });
  if (p === "/api/limits") return json(res, { images: true, maxImages: MAX_IMAGES });
  if (p === "/api/ai" && method === "POST") return ai(req, res);

  let m;
  if (p === "/api/blob" && method === "POST") return putBlob(req, res, randomBytes(16).toString("hex"));
  if ((m = p.match(/^\/api\/blob\/([0-9a-f]{32})$/))) {
    if (method === "PUT") return putBlob(req, res, m[1]);
    if (method === "DELETE") { await removeBlob(m[1]); return json(res, { ok: true }); }
  }
  if ((m = p.match(/^\/api\/db\/([^/]+)(?:\/([^/]+))?$/))) {
    const [, col, id] = m;
    if (!NAME_RE.test(col) || (id && !NAME_RE.test(id))) return json(res, { error: "bad_name" }, 400);
    return id ? docRoute(req, res, col, id) : collectionRoute(req, res, col, url);
  }
  return json(res, { error: "not_found" }, 404);
}

/* ---------- Claude ---------- */

async function ai(req, res) {
  if (!client) return json(res, { error: "no_api_key" }, 500);
  const body = JSON.parse((await readBody(req)).toString("utf8") || "null");
  if (!body || typeof body.prompt !== "string" || !body.prompt) return json(res, { error: "bad_request" }, 400);

  const usage = await readJson(path.join(DATA, "usage.json"), {});
  const day = new Date().toISOString().slice(0, 10);
  usage[day] = (usage[day] || 0) + 1;
  await writeJson(path.join(DATA, "usage.json"), usage);
  if (usage[day] > DAILY_LIMIT) return json(res, { error: "daily_limit" }, 429);

  const content = [];
  for (const im of Array.isArray(body.images) ? body.images.slice(0, MAX_IMAGES) : []) {
    if (!im || typeof im.data !== "string" || !/^image\/(png|jpeg|gif|webp)$/.test(im.media_type)) continue;
    content.push({ type: "image", source: { type: "base64", media_type: im.media_type, data: im.data } });
  }
  content.push({ type: "text", text: body.prompt });

  let msg;
  try {
    msg = await client.beta.messages.create({
      model: MODEL,
      max_tokens: 16000,
      output_config: { effort: EFFORT },
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      messages: [{ role: "user", content }],
    });
  } catch (e) {
    console.error("Claude API:", e.message);
    if (e instanceof Anthropic.RateLimitError) return json(res, { error: "rate_limited" }, 429);
    if (e instanceof Anthropic.AuthenticationError) return json(res, { error: "bad_api_key" }, 500);
    if (e instanceof Anthropic.BadRequestError) return json(res, { error: "bad_request", detail: e.message }, 400);
    if (e instanceof Anthropic.APIError) return json(res, { error: "api_error", detail: e.message }, 502);
    return json(res, { error: "network", detail: e.message }, 502);
  }

  if (msg.stop_reason === "refusal") return json(res, { error: "refused" }, 422);
  const text = msg.content.filter(b => b.type === "text").map(b => b.text).join("");
  const result = parseJson(text);
  if (result === undefined) return json(res, { error: "bad_json", text: text.slice(0, 2000) }, 502);
  return json(res, { result, stop_reason: msg.stop_reason });
}

// 回覆應該只有一個 JSON；容許前後多了說明文字或 ``` 圍起來。
function parseJson(text) {
  const t = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  try { return JSON.parse(t); } catch {}
  const starts = [t.indexOf("{"), t.indexOf("[")].filter(i => i >= 0);
  if (!starts.length) return undefined;
  const s = Math.min(...starts);
  const e = Math.max(t.lastIndexOf("}"), t.lastIndexOf("]"));
  if (e <= s) return undefined;
  try { return JSON.parse(t.slice(s, e + 1)); } catch { return undefined; }
}

/* ---------- 測試紀錄：data/db/<collection>/<id>.json ---------- */

const colDir = col => path.join(DATA, "db", col);
const docFile = (col, id) => path.join(colDir(col), id + ".json");

async function collectionRoute(req, res, col, url) {
  if (req.method === "GET") {
    const files = existsSync(colDir(col)) ? (await readdir(colDir(col))).filter(f => f.endsWith(".json")) : [];
    const docs = [];
    for (const f of files) {
      const data = await readJson(path.join(colDir(col), f), null);
      if (data) docs.push({ id: f.slice(0, -5), data });
    }
    const t = d => (typeof d.data.createdAt === "number" ? d.data.createdAt : 0);
    docs.sort((a, b) => t(a) - t(b) || a.id.localeCompare(b.id));
    if (url.searchParams.get("dir") === "desc") docs.reverse();
    return json(res, { docs });
  }
  if (req.method === "POST") {
    const data = JSON.parse((await readBody(req)).toString("utf8"));
    const id = [...randomBytes(20)].map(x => "abcdefghijklmnopqrstuvwxyz0123456789"[x % 36]).join("");
    await writeJson(docFile(col, id), data);
    return json(res, { id });
  }
  return json(res, { error: "method" }, 405);
}

async function docRoute(req, res, col, id) {
  const f = docFile(col, id);
  switch (req.method) {
    case "GET": {
      const data = await readJson(f, null);
      return data ? json(res, { id, data }) : json(res, { error: "not_found" }, 404);
    }
    case "PUT":
      await writeJson(f, JSON.parse((await readBody(req)).toString("utf8")));
      return json(res, { id });
    case "PATCH": {
      const data = await readJson(f, null);
      if (!data) return json(res, { error: "not_found" }, 404);
      await writeJson(f, { ...data, ...JSON.parse((await readBody(req)).toString("utf8")) });
      return json(res, { id });
    }
    case "DELETE":
      await rm(f, { force: true });
      return json(res, { ok: true });
  }
  return json(res, { error: "method" }, 405);
}

/* ---------- 圖片：data/blobs/<id>.png|jpg ---------- */

const EXT = { "image/png": ".png", "image/jpeg": ".jpg", "image/gif": ".gif", "image/webp": ".webp" };
const blobDir = path.join(DATA, "blobs");

async function findBlob(id) {
  for (const [type, ext] of Object.entries(EXT)) {
    const f = path.join(blobDir, id + ext);
    if (existsSync(f)) return { f, type };
  }
  return null;
}

async function putBlob(req, res, id) {
  const type = (req.headers["content-type"] || "").split(";")[0];
  if (!EXT[type]) return json(res, { error: "not_image" }, 415);
  const buf = await readBody(req);
  await removeBlob(id);
  await mkdir(blobDir, { recursive: true });
  await writeFile(path.join(blobDir, id + EXT[type]), buf);
  return json(res, { id });
}

async function removeBlob(id) {
  const b = await findBlob(id);
  if (b) await rm(b.f, { force: true });
}

async function getBlob(res, id) {
  const b = BLOB_RE.test(id) && (await findBlob(id));
  if (!b) return notFound(res);
  res.writeHead(200, { "Content-Type": b.type, "Cache-Control": "private, max-age=31536000, immutable" });
  res.end(await readFile(b.f));
}

/* ---------- 靜態檔案 ---------- */

const MIME = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
  ".gif": "image/gif", ".svg": "image/svg+xml", ".webp": "image/webp", ".ico": "image/x-icon",
  ".wasm": "application/wasm", ".data": "application/octet-stream", ".binarypb": "application/octet-stream",
  ".tflite": "application/octet-stream", ".txt": "text/plain; charset=utf-8",
};

async function serveStatic(res, p) {
  let f = path.normalize(path.join(PUBLIC, p));
  if (f !== PUBLIC && !f.startsWith(PUBLIC + path.sep)) return notFound(res);
  try {
    if ((await stat(f)).isDirectory()) {
      if (!p.endsWith("/")) { res.writeHead(301, { Location: p + "/" }); return res.end(); }
      f = path.join(f, "index.html");
    }
    const buf = await readFile(f);
    res.writeHead(200, { "Content-Type": MIME[path.extname(f).toLowerCase()] || "application/octet-stream", "Cache-Control": "no-cache" });
    res.end(buf);
  } catch {
    notFound(res);
  }
}

/* ---------- 共用 ---------- */

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let n = 0;
    req.on("data", c => {
      n += c.length;
      if (n > MAX_BODY) { reject(new Error("too_large")); req.destroy(); return; }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

async function readJson(f, fallback) {
  try { return JSON.parse(await readFile(f, "utf8")); } catch { return fallback; }
}

async function writeJson(f, data) {
  await mkdir(path.dirname(f), { recursive: true });
  const tmp = f + ".tmp";
  await writeFile(tmp, JSON.stringify(data, null, 1));
  await rename(tmp, f);
}

function json(res, obj, status = 200) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(JSON.stringify(obj));
}

function notFound(res) {
  res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
  res.end("Not found");
}

/* ---------- 第一次啟動：搬入 claude.ai 的舊紀錄 ---------- */

async function importOldData() {
  const recDir = path.join(OLD_DATA, "records");
  if (!existsSync(recDir) || existsSync(path.join(DATA, "imported.txt"))) return;
  let nb = 0, nr = 0;
  const srcBlobs = path.join(OLD_DATA, "blobs");
  if (existsSync(srcBlobs)) {
    await mkdir(blobDir, { recursive: true });
    for (const f of await readdir(srcBlobs)) {
      if (!/^[0-9a-f]{32}\.(png|jpg)$/.test(f)) continue;
      await copyFile(path.join(srcBlobs, f), path.join(blobDir, f));
      nb++;
    }
  }
  await mkdir(colDir("records"), { recursive: true });
  for (const f of await readdir(recDir)) {
    if (!/^[A-Za-z0-9_-]+\.json$/.test(f)) continue;
    await copyFile(path.join(recDir, f), path.join(colDir("records"), f));
    nr++;
  }
  await writeFile(path.join(DATA, "imported.txt"), `從 claude.ai 搬入 ${nr} 筆紀錄、${nb} 張圖片：${new Date().toLocaleString()}\n`);
  console.log(`已搬入舊的測試紀錄：${nr} 筆、圖片 ${nb} 張。`);
}

/* ---------- 啟動 ---------- */

await mkdir(DATA, { recursive: true });
await importOldData();
server.on("error", e => {
  if (e.code === "EADDRINUSE") {
    console.log(`Undertone 好像已經開著了（${PORT} 埠被占用），直接打開瀏覽器。`);
    openBrowser();
    setTimeout(() => process.exit(0), 1500);
  } else throw e;
});
server.listen(PORT, "127.0.0.1", () => {
  // 先開瀏覽器再印訊息：Windows 的命令視窗被點到進入「選取」模式時，印字會卡住整個程式。
  if (process.argv.includes("--open")) openBrowser();
  const link = `http://localhost:${PORT}/undertone/`;
  console.log(`\nUndertone 已啟動：${link}`);
  console.log(client ? `Claude 模型：${MODEL}（思考深度 ${EFFORT}，每天最多 ${DAILY_LIMIT} 次）` : "⚠ 還沒設定 API 金鑰（settings.txt），AI 功能不能用。");
  console.log("要關掉時，直接關這個視窗。\n");
});

function openBrowser() {
  const link = `http://localhost:${PORT}/undertone/`;
  const cmd = process.platform === "win32" ? `start "" "${link}"` : process.platform === "darwin" ? `open "${link}"` : `xdg-open "${link}"`;
  exec(cmd, () => {});
}
