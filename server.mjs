// Undertone 本機伺服器：在自己的電腦上跑生成器。
// 送出 public/ 的網頁，並提供 claude-shim.js 用的 API：呼叫 Claude、存測試紀錄和圖片。
// 資料存在 data/ 資料夾；API 金鑰讀 settings.txt。生成器只接受本機連線；
// 另外開一個手機上傳用的小伺服器（同一個 Wi-Fi 的手機掃 QR code 傳照片），只收照片、不給看任何資料。
import http from "node:http";
import { readFile, writeFile, mkdir, readdir, rm, copyFile, rename, stat } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { exec, spawn } from "node:child_process";
import path from "node:path";
import os from "node:os";
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
// 貼上時常多了引號、空白或換行，先清掉
const rawKey = (settings.ANTHROPIC_API_KEY || "").replace(/["'“”‘’\s]/g, "");
const API_KEY = rawKey && !rawKey.includes("...") ? rawKey : "";
const MODEL = settings.CLAUDE_MODEL || "claude-opus-5-5";
const EFFORT = settings.CLAUDE_EFFORT || "medium";
const DAILY_LIMIT = parseInt(settings.DAILY_AI_LIMIT || "300", 10);
// 展覽安全碼：展覽時打開測試紀錄、離開展覽模式都要輸入
const EXPO_PIN = (settings.EXPO_PIN || "").trim();
const KIOSK = process.argv.includes("--kiosk");
// 示範模式：不呼叫 Claude、不花錢，回假的設計結果，用來調介面。用「調介面（不花錢）.bat」開，或 settings.txt 寫 AI_MODE=demo
const DEMO = process.argv.includes("--demo") || /^demo$/i.test((settings.AI_MODE || "").trim());
// 省錢模式：展覽用（展覽啟動.bat 預設開）。生成器的提案改用規則、元素用素材庫，只有讀照片和用說的修改才呼叫 Claude，
// 而且思考深度用 SAVE_EFFORT（預設 low）。settings.txt 寫 AI_MODE=full 可以關掉。
const SAVE = !DEMO && (process.argv.includes("--save") || /^save$/i.test((settings.AI_MODE || "").trim())) && !/^full$/i.test((settings.AI_MODE || "").trim());
const SAVE_EFFORT = settings.SAVE_EFFORT || "low";
// 手機上傳：用哪個埠、電腦的區網位址（不填就自動找）、要不要在 QR 旁邊放 Wi-Fi 的 QR
const PHONE_PORT = parseInt(settings.PHONE_PORT || "8788", 10);
const PHONE_HOST = (settings.PHONE_HOST || "").trim();
const PHONE_WIFI = settings.PHONE_WIFI_SSID ? { ssid: settings.PHONE_WIFI_SSID, pass: settings.PHONE_WIFI_PASS || "" } : null;
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
  let m0;
  if (p === "/api/me") return json(res, { ok: true });
  if (p === "/api/limits") return json(res, { images: true, maxImages: MAX_IMAGES, demo: DEMO, save: SAVE });
  if (p === "/api/ai" && method === "POST") return ai(req, res);
  if (p === "/api/unlock" && method === "POST") return unlock(req, res);
  if (p === "/api/phone" && method === "POST") return phoneStart(res);
  if ((m0 = p.match(/^\/api\/phone\/([0-9a-f]{32})(?:\/(\d+))?$/))) return phoneRoute(req, res, m0[1], m0[2]);

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
  if (DEMO) return demoReply(req, res);
  if (!client) return json(res, { error: "no_api_key" }, 500);
  const body = JSON.parse((await readBody(req)).toString("utf8") || "null");
  if (!body || typeof body.prompt !== "string" || !body.prompt) return json(res, { error: "bad_request" }, 400);

  const usage = await readJson(path.join(DATA, "usage.json"), {});
  const day = new Date().toISOString().slice(0, 10);
  usage[day] = (usage[day] || 0) + 1;
  await writeJson(path.join(DATA, "usage.json"), usage);
  if (usage[day] > DAILY_LIMIT) return json(res, { error: "daily_limit" }, 429);
  console.log(`Claude 呼叫：今天第 ${usage[day]} 次（上限 ${DAILY_LIMIT}）`);

  const content = [];
  for (const im of Array.isArray(body.images) ? body.images.slice(0, MAX_IMAGES) : []) {
    if (!im || typeof im.data !== "string" || !/^image\/(png|jpeg|gif|webp)$/.test(im.media_type)) continue;
    content.push({ type: "image", source: { type: "base64", media_type: im.media_type, data: im.data } });
  }
  content.push({ type: "text", text: body.prompt });

  // 用串流接收：圖多、想得久的時候不會因為連線太久被切斷。
  // 回覆被截斷或不是 JSON 時自動再試一次。
  const ask = () => client.beta.messages.stream({
    model: MODEL,
    max_tokens: SAVE ? 16000 : 32000,
    output_config: { effort: SAVE ? SAVE_EFFORT : EFFORT },
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    messages: [{ role: "user", content }],
  }).finalMessage();

  let last = null;
  for (let attempt = 1; attempt <= 2; attempt++) {
    let msg;
    try {
      msg = await ask();
    } catch (e) {
      console.error(`Claude API 錯誤（第 ${attempt} 次）：`, e.message);
      if (e instanceof Anthropic.AuthenticationError) return json(res, { error: "bad_api_key", detail: e.message }, 500);
      if (e instanceof Anthropic.PermissionDeniedError) return json(res, { error: "no_permission", detail: e.message }, 500);
      if (e instanceof Anthropic.BadRequestError) return json(res, { error: "bad_request", detail: e.message }, 400);
      last = { error: e instanceof Anthropic.RateLimitError ? "rate_limited" : e instanceof Anthropic.APIConnectionError || !(e instanceof Anthropic.APIError) ? "network" : "api_error", detail: e.message };
      continue;
    }
    if (msg.stop_reason === "refusal") { console.error("Claude 拒絕回答這個請求"); return json(res, { error: "refused" }, 422); }
    const text = msg.content.filter(b => b.type === "text").map(b => b.text).join("");
    const result = parseJson(text);
    if (result !== undefined) return json(res, { result, stop_reason: msg.stop_reason });
    console.error(`Claude 回覆不是完整的 JSON（第 ${attempt} 次，stop_reason=${msg.stop_reason}）：`, text.slice(0, 300));
    last = { error: msg.stop_reason === "max_tokens" ? "too_long" : "bad_json", detail: text.slice(0, 500) };
  }
  return json(res, last, last.error === "rate_limited" ? 429 : 502);
}

// 展覽安全碼：比對 settings.txt 的 EXPO_PIN。打錯會等一下才回，避免一直亂猜。
async function unlock(req, res) {
  const body = JSON.parse((await readBody(req)).toString("utf8") || "null") || {};
  if (!EXPO_PIN) return json(res, { error: "no_pin" }, 400);
  const a = Buffer.from(String(body.pin || "")), b = Buffer.from(EXPO_PIN);
  if (a.length === b.length && timingSafeEqual(a, b)) return json(res, { ok: true });
  await new Promise(r => setTimeout(r, 1500));
  return json(res, { error: "wrong_pin" }, 403);
}

/* ---------- 手機上傳 ---------- */
// 生成器按「用手機上傳」→ 開一個 20 分鐘有效的上傳碼，QR code 指到 http://電腦區網位址:8788/u/上傳碼。
// 手機傳上來的照片先放 data/phone/<上傳碼>/，生成器每隔一下來拿，拿到後和本機上傳的照片一樣處理。
const PHONE_DIR = path.join(DATA, "phone");
const PHONE_TTL = 20 * 60 * 1000, PHONE_MAX = 3, PHONE_MAX_BYTES = 15 * 1024 * 1024;
const phoneSessions = new Map();

function lanAddress() {
  if (PHONE_HOST) return PHONE_HOST;
  const found = [];
  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    if (/vethernet|vmware|virtualbox|hyper-v|wsl|loopback|docker|tailscale|zerotier/i.test(name)) continue;
    for (const a of list || []) {
      if (a.family !== "IPv4" || a.internal || a.address.startsWith("169.254.")) continue;
      const rank = a.address.startsWith("192.168.") ? 0 : a.address.startsWith("10.") ? 1 : /^172\.(1[6-9]|2\d|3[01])\./.test(a.address) ? 2 : 3;
      found.push([rank, a.address]);
    }
  }
  found.sort((x, y) => x[0] - y[0]);
  return found.length ? found[0][1] : null;
}

function phoneStart(res) {
  const host = lanAddress();
  if (!host || !phoneServerUp) return json(res, { error: "no_lan" }, 503);
  const token = randomBytes(16).toString("hex");
  phoneSessions.set(token, { created: Date.now(), items: [] });
  json(res, { token, url: `http://${host}:${PHONE_PORT}/u/${token}`, wifi: PHONE_WIFI, max: PHONE_MAX });
}

async function phoneRoute(req, res, token, n) {
  const ses = phoneSessions.get(token);
  if (req.method === "DELETE") { phoneSessions.delete(token); await rm(path.join(PHONE_DIR, token), { recursive: true, force: true }); return json(res, { ok: true }); }
  if (!ses) return json(res, { error: "expired" }, 404);
  if (n === undefined) return json(res, { items: ses.items.map((it, i) => ({ n: i, type: it.type })) });
  const it = ses.items[+n];
  if (!it) return notFound(res);
  res.writeHead(200, { "Content-Type": it.type, "Cache-Control": "no-store" });
  res.end(await readFile(it.file));
}

// 過期的上傳碼和照片定時清掉
setInterval(() => {
  const now = Date.now();
  for (const [t, ses] of phoneSessions) if (now - ses.created > PHONE_TTL) { phoneSessions.delete(t); rm(path.join(PHONE_DIR, t), { recursive: true, force: true }).catch(() => {}); }
}, 60 * 1000).unref();

// 區網上的手機只能用這個伺服器：打開上傳頁、送照片，其他一律 404
let phoneServerUp = false;
const PHONE_PAGE = path.join(ROOT, "phone", "upload.html");
const phoneServer = http.createServer(async (req, res) => {
  try {
    const pn = new URL(req.url, "http://x").pathname;
    const m = pn.match(/^\/u\/([0-9a-f]{32})$/);
    const ses = m && phoneSessions.get(m[1]);
    if (!m) return notFound(res);
    if (req.method === "GET") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
      return res.end(await readFile(PHONE_PAGE));
    }
    if (req.method !== "POST") return notFound(res);
    if (!ses || Date.now() - ses.created > PHONE_TTL) return json(res, { error: "expired" }, 410);
    if (ses.items.length >= PHONE_MAX) return json(res, { error: "full" }, 409);
    const type = (req.headers["content-type"] || "").split(";")[0];
    if (!/^image\/(jpeg|png|webp|gif)$/.test(type)) return json(res, { error: "bad_type" }, 415);
    const body = await readBody(req);
    if (!body.length || body.length > PHONE_MAX_BYTES) return json(res, { error: "too_large" }, 413);
    await mkdir(path.join(PHONE_DIR, m[1]), { recursive: true });
    const file = path.join(PHONE_DIR, m[1], `${ses.items.length}.${type.split("/")[1]}`);
    await writeFile(file, body);
    ses.items.push({ type, file });
    json(res, { ok: true, count: ses.items.length, max: PHONE_MAX });
  } catch (e) {
    console.error("手機上傳：", e.message);
    if (!res.headersSent) json(res, { error: "server_error" }, 500);
  }
});
phoneServer.on("error", e => console.log(`手機上傳沒有開成（${e.code}），用手機傳照片的功能不能用。`));

// 示範模式的假回覆：欄位和真的一樣，內容隨機挑，等一下才回，看得到等待畫面
const pick = a => a[Math.floor(Math.random() * a.length)];
async function demoReply(req, res) {
  await readBody(req);
  await new Promise(r => setTimeout(r, 1200 + Math.random() * 1200));
  const pal = pick([["#F2C6D0", "#FFFFFF", "#C9A0FF", "#E8D7D0"], ["#141414", "#C9CDD3", "#6E7278", "#E8D7D0"], ["#F3E3C3", "#9CC3E6", "#A8C3A0", "#B07A3C"], ["#2B2B3A", "#8FD3FF", "#D7B8FF", "#E9EEF4"]]);
  json(res, { result: {
    summary: "（示範模式）這是假的解析，用來調介面，沒有呼叫 Claude。",
    colors: pal, bgColors: [], aes: pick(["韓系", "日系", "黑金屬", "未來感"]), fits: true,
    elements: [...new Set([pick(["heart", "star", "pearl", "bow"]), pick(["chain", "drip", "stud", "cross"])])], others: [], keywords: ["示範"],
    say: pick(["（示範模式）今天用透亮的果凍底配一點銀色小飾品，乾淨又有亮點。", "（示範模式）黑色亮面加液態銀，短方圓甲，酷一點但不會太重。", "（示範模式）奶白底配淡淡的星星和小珍珠，輕快不甜膩。"]),
    why: {}, basis: ["示範模式"], newTry: [],
  }, stop_reason: "end_turn", demo: true });
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
    if (DEMO) console.log("⚠ 已經開著的那個不是示範模式，會花到 API。要調介面不花錢，先關掉另一個黑色視窗再開一次。");
    openBrowser();
    setTimeout(() => process.exit(0), 1500);
  } else throw e;
});
server.listen(PORT, "127.0.0.1", () => {
  // 先開瀏覽器再印訊息：Windows 的命令視窗被點到進入「選取」模式時，印字會卡住整個程式。
  if (process.argv.includes("--open")) openBrowser();
  const link = `http://localhost:${PORT}/undertone/`;
  console.log(`\nUndertone 已啟動：${link}`);
  if (DEMO) console.log("示範模式：不會呼叫 Claude，不花錢。設計結果是假的，只用來調介面。");
  if (SAVE) console.log(`省錢模式：提案用後台規則、元素用素材庫，只有讀照片和用說的修改才呼叫 Claude（思考深度 ${SAVE_EFFORT}）。`);
  else console.log(client ? `Claude 模型：${MODEL}（思考深度 ${EFFORT}，每天最多 ${DAILY_LIMIT} 次）` : "⚠ 還沒設定 API 金鑰（settings.txt），AI 功能不能用。");
  // 開啟時先確認金鑰能不能用（查模型資料，不花錢）
  if (client && !DEMO) client.models.retrieve(MODEL).then(
    () => console.log("✓ API 金鑰可以用"),
    e => console.error(e instanceof Anthropic.AuthenticationError
      ? `✗ API 金鑰不對或已失效（開頭 ${API_KEY.slice(0, 10)}…，共 ${API_KEY.length} 個字）。到 https://console.anthropic.com/settings/keys 重新建立一把，貼進 settings.txt 後重新啟動。`
      : e instanceof Anthropic.NotFoundError ? `✗ 找不到模型 ${MODEL}，檢查 settings.txt 的 CLAUDE_MODEL。`
      : `✗ 檢查金鑰時出錯：${e.message}`));
  rm(PHONE_DIR, { recursive: true, force: true }).catch(() => {});
  phoneServer.listen(PHONE_PORT, "0.0.0.0", () => {
    phoneServerUp = true;
    const host = lanAddress();
    console.log(host ? `手機上傳：同一個 Wi-Fi 的手機掃生成器上的 QR code 就能傳照片（${host}:${PHONE_PORT}）。Windows 問要不要允許時，勾「私人網路」。` : "手機上傳：這台電腦沒有連上 Wi-Fi 或區網，用手機傳照片的功能暫時不能用。");
  });
  console.log("要關掉時，直接關這個視窗。\n");
});

function openBrowser() {
  const link = `http://localhost:${PORT}/undertone/`;
  if (KIOSK && process.platform === "win32") return openKiosk(link + "?expo=1");
  const cmd = process.platform === "win32" ? `start "" "${link}"` : process.platform === "darwin" ? `open "${link}"` : `xdg-open "${link}"`;
  exec(cmd, () => {});
}

// 展覽用：全螢幕、沒有網址列和分頁（kiosk）。用獨立的瀏覽器設定檔（data/kiosk-browser），
// 平常開著的瀏覽器不受影響，鏡頭權限允許一次之後就會記住。
function openKiosk(link) {
  const env = process.env, cands = [
    [path.join(env.ProgramFiles || "C:\\Program Files", "Google\\Chrome\\Application\\chrome.exe"), false],
    [path.join(env["ProgramFiles(x86)"] || "C:\\Program Files (x86)", "Google\\Chrome\\Application\\chrome.exe"), false],
    [path.join(env.LOCALAPPDATA || "", "Google\\Chrome\\Application\\chrome.exe"), false],
    [path.join(env["ProgramFiles(x86)"] || "C:\\Program Files (x86)", "Microsoft\\Edge\\Application\\msedge.exe"), true],
    [path.join(env.ProgramFiles || "C:\\Program Files", "Microsoft\\Edge\\Application\\msedge.exe"), true],
  ];
  const found = cands.find(([f]) => existsSync(f));
  if (!found) { console.log("找不到 Chrome 或 Edge，改用一般視窗打開（可以按 F11 全螢幕）。"); exec(`start "" "${link}"`, () => {}); return; }
  const [exe, edge] = found;
  const args = [`--kiosk`, link, `--user-data-dir=${path.join(DATA, "kiosk-browser")}`, "--no-first-run", "--no-default-browser-check",
    "--disable-pinch", "--overscroll-history-navigation=0", "--disable-features=Translate", "--disable-session-crashed-bubble"];
  if (edge) args.push("--edge-kiosk-type=fullscreen");
  spawn(exe, args, { detached: true, stdio: "ignore" }).unref();
}
