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

## 調介面不花錢

點兩下 **`調介面（不花錢）.bat`**：流程、畫面、試戴都照常，但不會呼叫 Claude，提案和解析是隨機的假結果（右下角會標「示範模式」）。也可以在 `settings.txt` 寫 `AI_MODE=demo`，之後每次啟動都是示範模式；拿掉這行就恢復。要先關掉其他開著的黑色視窗。

## 展覽怎麼開

1. 先在 `settings.txt` 加一行 `EXPO_PIN=你的安全碼`（只有你知道的數字或文字），存檔。
2. 點兩下 **`展覽啟動.bat`**：瀏覽器會全螢幕打開（kiosk 模式），沒有網址列和分頁，觀眾按 F11 也退不出來。
3. 第一次用鏡頭時允許相機，之後會記住。
4. 展覽模式下畫面上沒有開關，測試紀錄也藏起來；閒置一段時間會自動回首頁。
5. 你要看紀錄或離開展覽模式：按 **Ctrl＋Shift＋L**，輸入安全碼。
6. 要關掉：按 **Alt＋F4** 關瀏覽器，再關掉黑色視窗。

**省錢模式：** `展覽啟動.bat` 預設是省錢模式。提案用後台風格和規則配，元素用素材庫的樣式，「再生一組」也不花錢；只有觀眾給照片（讀圖）或用文字修改時才呼叫 Claude，而且思考深度用最低。黑色視窗每呼叫一次會印「今天第幾次」。評圖要完整的 Claude 提案和即時手繪，用 `啟動 Undertone.bat`，或在 `settings.txt` 寫 `AI_MODE=full`。

**手機傳照片：** 第 1 步的照片只能用手機掃 QR code 傳（電腦上不能選檔案），QR code 直接顯示在頁面上，最多 3 張。啟動檔第一次會自動下載 Cloudflare 的通道程式 `cloudflared.exe`，之後啟動時會開一條臨時的公開網址，觀眾手機用自己的 4G／5G 就能傳，不用連同一個 Wi-Fi（展場電腦要能上網；這是 Cloudflare 的免費服務，沒有保證一定穩，每次啟動網址都不一樣）。通道開不起來時會自動改回「手機要連同一個 Wi-Fi」：第一次啟動時 Windows 問要不要允許 Node.js 連網，勾「私人網路」；也可以用電腦開行動熱點，把名稱和密碼填進 `settings.txt` 的 `PHONE_WIFI_SSID`、`PHONE_WIFI_PASS`。

每一次的成品圖、觀眾上傳或用鏡頭拍的參考照片、試戴拍下來的照片，都會存進 `data/`（紀錄在 `data/db/records/`，圖片在 `data/blobs/`），在測試紀錄頁可以看、可以下載。

展覽前記得把 Windows 的螢幕保護程式和自動睡眠關掉（設定 → 系統 → 電源）。

## 設定（`settings.txt`）

| 名稱 | 預設 | 說明 |
|---|---|---|
| `ANTHROPIC_API_KEY` | — | Anthropic API 金鑰 |
| `CLAUDE_MODEL` | `claude-opus-5-5` | 用哪個 Claude 模型 |
| `CLAUDE_EFFORT` | `medium` | 思考深度：`low`／`medium`／`high`／`xhigh`／`max`，越高越慢越貴 |
| `DAILY_AI_LIMIT` | `300` | 每天最多呼叫幾次 Claude |
| `EXPO_PIN` | — | 展覽安全碼：展覽時打開測試紀錄、離開展覽模式要輸入 |
| `PHONE_WIFI_SSID`／`PHONE_WIFI_PASS` | — | 手機上傳時一起顯示的 Wi-Fi（選填） |
| `PHONE_HOST` | 自動 | 手機上傳用哪個網路位址（選填） |

`settings.txt`、`data/` 不會放上 GitHub。

## 檔案

| 檔案 | 用途 |
|---|---|
| `server.mjs` | 本機伺服器：送出網頁、呼叫 Claude、存測試紀錄和圖片 |
| `public/undertone/claude-shim.js` | 取代 claude.ai 的 `claude.use(...)`，改接 `server.mjs` |
| `public/undertone/kb/backend.json` | 生成器讀的後台資料 |
| `public/undertone/vendor/` | p5.js 1.9.4、MediaPipe Hands 0.4.1675469240（離線用） |
| `啟動 Undertone.bat` | Windows 啟動檔 |
| `phone/upload.html` | 手機掃 QR code 後打開的上傳頁 |
| `調介面（不花錢）.bat` | 示範模式：不呼叫 Claude、不花錢，用來調介面 |
| `展覽啟動.bat` | 展覽用啟動檔：瀏覽器全螢幕（kiosk），開啟展覽模式 |

Mac 或已經裝好 Node.js 的電腦：`npm install` 之後執行 `npm start`。
