# Undertone 網站

- `/`：Sweet Match（`public/index.html`）
- `/undertone/`：Undertone 美甲生成器（`public/undertone/index.html`）

網站跑在 Cloudflare Workers 上：靜態檔案在 `public/`，後端在 `worker/index.js`，資料存在 Cloudflare D1。

## 檔案在哪裡

| 檔案 | 用途 |
|---|---|
| `public/undertone/index.html` | 生成器本體（原本 claude.ai 上的 v25，只多載入 `claude-shim.js`） |
| `public/undertone/claude-shim.js` | 取代 `claude.use(...)`：AI 改呼叫自己的後端，存檔改存 D1，下載改成瀏覽器直接下載 |
| `public/undertone/kb/backend.json` | 生成器讀的後台資料（原本的 `kb/backend`） |
| `kb/backend.md` | 後台文件（素材庫），共編用；改完請 Claude 同步成 `backend.json` |
| `worker/index.js` | 後端：密碼登入、呼叫 Claude API、測試紀錄和圖片 |
| `schema.sql` | 資料庫結構 |
| `scripts/import-old-data.mjs` | 把 claude.ai 舊的測試紀錄搬進來 |

API 金鑰和密碼只存在 Cloudflare 的 Secret（本機是 `.dev.vars`），不會出現在網頁或 repo 裡。

## 本機測試

需要 Node.js 20 以上。

```bash
npm install
cp .dev.vars.example .dev.vars        # 打開 .dev.vars 填密碼和 Anthropic API 金鑰
npm run db:init:local                 # 建本機資料庫（只要一次）
npm run dev                           # 開 http://localhost:8787/undertone/
```

localhost 可以直接開鏡頭試戴。要把舊紀錄搬進本機資料庫，另開一個終端機：

```bash
node scripts/import-old-data.mjs ./undertone-old-data http://localhost:8787 你的密碼
```

## 上線（Cloudflare）

1. **建資料庫**：Cloudflare 後台 → Storage & databases → D1 → Create，名稱填 `undertone`。建好後複製 Database ID，貼到 `wrangler.jsonc` 的 `database_id`（或交給 Claude 改）。
2. **建表**：在 D1 的 `undertone` 資料庫裡打開 Console，把 `schema.sql` 的內容貼上執行。
3. **連 GitHub**：Workers & Pages → Create → Import a repository → 選這個 repo。Deploy command 用預設的 `npx wrangler deploy`，Build command 留空。之後推到 main 就會自動更新。
4. **設 Secret**：Worker → Settings → Variables and Secrets，加兩個 Secret 類型的變數：
   - `APP_PASSWORD`：網站的登入密碼
   - `ANTHROPIC_API_KEY`：Anthropic API 金鑰
5. **搬舊資料**：`node scripts/import-old-data.mjs ./undertone-old-data https://你的網址 你的密碼`

## 可以調的設定（`wrangler.jsonc` 的 `vars`）

| 名稱 | 預設 | 說明 |
|---|---|---|
| `CLAUDE_MODEL` | `claude-opus-5-5` | 用哪個 Claude 模型 |
| `CLAUDE_EFFORT` | `medium` | 思考深度：`low`／`medium`／`high`／`xhigh`／`max`，越高越慢越貴 |
| `DAILY_AI_LIMIT` | `300` | 每天最多呼叫幾次 Claude，避免意外花太多錢 |
