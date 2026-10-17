@echo off
chcp 65001 >nul
cd /d "%~dp0"
title Undertone

set "NODE=node"
if exist "runtime\node.exe" set "NODE=runtime\node.exe"
"%NODE%" -v >nul 2>&1
if errorlevel 1 (
  echo 找不到 Node.js。請到 https://nodejs.org 下載安裝 LTS 版，再點一次這個檔案。
  pause
  exit /b 1
)

if not exist "node_modules\@anthropic-ai\sdk" (
  echo 第一次啟動，正在安裝需要的套件……
  call npm install --omit=dev
  if errorlevel 1 (
    echo 安裝失敗，請確認有連上網路。
    pause
    exit /b 1
  )
)

rem 解壓縮到新資料夾時，先把舊版資料夾的 settings.txt 和 data 複製過來
"%NODE%" server.mjs --migrate
if not exist "settings.txt" (
  copy /y "settings.example.txt" "settings.txt" >nul
  echo 請在打開的記事本裡貼上 API 金鑰，存檔、關掉記事本後就會繼續。
  notepad "settings.txt"
)

rem 手機掃 QR code 傳照片：下載 Cloudflare 的通道程式，手機用自己的網路就能傳，不用連同一個 Wi-Fi（只下載一次）
if not exist "cloudflared.exe" (
  echo 正在下載手機上傳用的通道程式（cloudflared，第一次才需要）……
  curl -fsSL -o "cloudflared.exe" "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe" || (
    if exist "cloudflared.exe" del "cloudflared.exe"
    echo 沒有下載成功，手機上傳先只能用同一個 Wi-Fi。下次啟動會再試。
  )
)

rem 展覽用（完整模式：Claude 提案、即時手繪；要省錢在 settings.txt 寫 AI_MODE=save）：瀏覽器全螢幕（kiosk），沒有網址列和分頁。要關掉按 Alt+F4，再關掉黑色視窗。
rem 關掉這個視窗的「快速編輯」，點到視窗時程式才不會暫停（只影響標題叫 Undertone 的視窗）。
reg add "HKCU\Console\Undertone" /v QuickEdit /t REG_DWORD /d 0 /f >nul 2>&1
start "Undertone" cmd /k ""%NODE%" server.mjs --open --kiosk"
exit /b 0
