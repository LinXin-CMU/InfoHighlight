@echo off
chcp 65001 >nul
cd /d "%~dp0"
where node.exe >nul 2>nul
if errorlevel 1 (
  echo 未找到 Node.js。此原型需要 Node.js 22 或更新版本。
  echo 安装官方 Node.js 后，重新打开此文件。
  pause
  exit /b 1
)
node launcher.mjs
if errorlevel 1 pause
