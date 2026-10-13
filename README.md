# Undertone

在自己的電腦上跑的 Undertone 美甲生成器，評圖、展覽時開來用。

- `public/undertone/`：生成器（原本 claude.ai 上的 v25）
- `public/index.html`：Sweet Match
- `kb/backend.md`：後台文件（素材庫），共編用

## Windows 怎麼開

1. 解壓縮整包資料夾，放在桌面之類好找的地方。
2. 點兩下 **`啟動 Undertone.bat`**。
3. 第一次會跳出記事本：在 `ANTHROPIC_API_KEY=` 後面貼上 API 金鑰，存檔、關掉記事本。
4. 瀏覽器會自動打開生成器。鏡頭試戴可以直接用。

要關掉時，關掉那個黑色視窗就好。

啟動時黑色視窗會檢查金鑰：出現「✓ API 金鑰可以用」就沒問題；出現「✗ API 金鑰不對或已失效」就到 https://console.anthropic.com/settings/keys 重新建立一把金鑰，貼進 `settings.txt`（整串 `sk-ant-` 開頭、不要加引號），存檔後重新啟動。下次只要再點兩下 `啟動 Undertone.bat`。

- 測試紀錄和圖片都存在 `data/` 資料夾裡。換電腦時把整個資料夾一起帶走。
- 資料夾裡有 `undertone-old-data/` 的話，第一次啟動會自動搬入 claude.ai 舊的測試紀錄，只會搬一次。
- 只有這台電腦能開，同一個 Wi-Fi 的其他人連不進來。
- 要有網路 AI 才能用。p5.js 和手部偵測都放在資料夾裡，不用另外下載。

## 設定（`settings.txt`）

| 名稱 | 預設 | 說明 |
|---|---|---|
| `ANTHROPIC_API_KEY` | — | Anthropic API 金鑰 |
| `CLAUDE_MODEL` | `claude-opus-5-5` | 用哪個 Claude 模型 |
| `CLAUDE_EFFORT` | `medium` | 思考深度：`low`／`medium`／`high`／`xhigh`／`max`，越高越慢越貴 |
| `DAILY_AI_LIMIT` | `300` | 每天最多呼叫幾次 Claude |

`settings.txt`、`data/` 不會放上 GitHub。

## 檔案

| 檔案 | 用途 |
|---|---|
| `server.mjs` | 本機伺服器：送出網頁、呼叫 Claude、存測試紀錄和圖片 |
| `public/undertone/claude-shim.js` | 取代 claude.ai 的 `claude.use(...)`，改接 `server.mjs` |
| `public/undertone/kb/backend.json` | 生成器讀的後台資料 |
| `public/undertone/vendor/` | p5.js 1.9.4、MediaPipe Hands 0.4.1675469240（離線用） |
| `啟動 Undertone.bat` | Windows 啟動檔 |

Mac 或已經裝好 Node.js 的電腦：`npm install` 之後執行 `npm start`。
