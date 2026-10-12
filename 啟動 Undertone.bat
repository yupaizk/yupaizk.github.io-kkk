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

if not exist "settings.txt" (
  copy /y "settings.example.txt" "settings.txt" >nul
  echo 請在打開的記事本裡貼上 API 金鑰，存檔、關掉記事本後就會繼續。
  notepad "settings.txt"
)

"%NODE%" server.mjs --open
pause
