@echo off
rem claude-best: Claude Code na koncie z najwiekszym zapasem limitu (szczegoly w claude-best.ps1).
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0claude-best.ps1" %*
