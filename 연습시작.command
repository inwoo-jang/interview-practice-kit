#!/bin/zsh
# 더블클릭 → 로컬 서버(스크립트 저장·음성 생성 포함) 켜고 Chrome으로 열기
cd "$(dirname "$0")"
source ~/.zshrc >/dev/null 2>&1   # ELEVENLABS_API_KEY
PORT=8765
lsof -ti :$PORT -sTCP:LISTEN | xargs kill 2>/dev/null
PY=.venv/bin/python; [ -x "$PY" ] || PY=python3
nohup "$PY" server.py $PORT >/tmp/면접서버.log 2>&1 &
sleep 1
open -a "Google Chrome" "http://localhost:$PORT/"
