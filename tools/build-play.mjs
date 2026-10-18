// 由展覽版 public/undertone/index.html 產生公開版 public/undertone/play.html。
// 公開版只多一個 window.UT_PUBLIC=true，其餘功能和展覽版一樣；index.html 改完就跑一次：node tools/build-play.mjs
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "public", "undertone");
let html = readFileSync(path.join(dir, "index.html"), "utf8");
const tag = '<script src="claude-shim.js"></script>';
if (!html.includes(tag)) throw new Error("index.html 裡找不到 claude-shim.js，沒辦法產生 play.html");
html = html.replace(tag, "<script>window.UT_PUBLIC=true;</script>\n" + tag);
html = html.replace(/<!DOCTYPE html>/i, "<!DOCTYPE html>\n<!-- 這個檔案是 tools/build-play.mjs 從 index.html 產生的公開版，不要直接改：改 index.html 再跑一次 node tools/build-play.mjs -->");
writeFileSync(path.join(dir, "play.html"), html);
console.log("已產生 public/undertone/play.html");
