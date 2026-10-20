#!/usr/bin/env python3
"""연습 앱 로컬 서버: 정적 파일 + 스크립트 저장/음성 재생성 API.

  POST /api/save    {id, q?, script?, tip?, guide?, cat?, time?}  → questions.json 갱신
  POST /api/add     {cat, q}                 → 질문 추가
  POST /api/delete  {id}                     → 질문 삭제
  POST /api/import  {md, mode: replace|append} → md 질문을 한 번에 넣기
  POST /api/export                           → 지금 질문을 md로
  POST /api/meta    {title, date}            → 면접 이름·날짜 (홈 D-day)
  POST /api/tts     {id}                     → 그 문항 음성만 다시 생성
  POST /api/concat                           → 취침용·쉐도잉 파일 다시 합치기

questions.json이 없으면 questions.md → 질문_예시.md 순서로 읽어 새로 만든다.
"""
import json, subprocess, sys, threading
import qmd
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parent
QFILE = ROOT / "questions.json"
PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8765
lock = threading.Lock()


def ensure_qfile():
    if QFILE.exists():
        return
    src = next((p for p in (ROOT / "questions.md", ROOT / "질문_예시.md") if p.exists()), None)
    meta, qs = qmd.parse(src.read_text(encoding="utf-8")) if src else ({}, [])
    write({"meta": meta, "questions": qs})


def read():
    return json.loads(QFILE.read_text(encoding="utf-8"))


def write(data):
    QFILE.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def run_tts(*extra):
    r = subprocess.run([sys.executable, str(ROOT / "make_tts.py"), *extra], cwd=ROOT, capture_output=True, text=True)
    return r.returncode == 0, (r.stdout + r.stderr)[-1500:]


class H(SimpleHTTPRequestHandler):
    def __init__(self, *a, **k):
        super().__init__(*a, directory=str(ROOT), **k)

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def log_message(self, *a):
        pass

    def reply(self, code, obj):
        body = json.dumps(obj, ensure_ascii=False).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self):
        n = int(self.headers.get("Content-Length") or 0)
        try:
            req = json.loads(self.rfile.read(n) or b"{}")
        except json.JSONDecodeError:
            return self.reply(400, {"ok": False, "error": "JSON 아님"})

        if self.path == "/api/ping":
            return self.reply(200, {"ok": True})

        if self.path == "/api/save":
            with lock:
                data = read()
                q = next((x for x in data["questions"] if x["id"] == req.get("id")), None)
                if not q:
                    return self.reply(404, {"ok": False, "error": "없는 id"})
                for k in ("q", "script", "tip", "guide", "cat"):
                    if k in req:
                        v = str(req[k]).strip()
                        if v:
                            q[k] = v
                        elif k not in ("q", "cat"):
                            q.pop(k, None)
                if str(req.get("time", "")).strip().isdigit():
                    q["time"] = int(req["time"])
                write(data)
            return self.reply(200, {"ok": True, "item": q})

        if self.path == "/api/add":
            with lock:
                data = read()
                ids = {x["id"] for x in data["questions"]}
                n = len(data["questions"]) + 1
                while f"q{n:02d}" in ids:
                    n += 1
                q = {"id": f"q{n:02d}", "cat": (req.get("cat") or "기타").strip(), "time": 60, "q": (req.get("q") or "새 질문").strip()}
                data["questions"].append(q)
                write(data)
            return self.reply(200, {"ok": True, "item": q})

        if self.path == "/api/delete":
            with lock:
                data = read()
                data["questions"] = [x for x in data["questions"] if x["id"] != req.get("id")]
                write(data)
            return self.reply(200, {"ok": True})

        if self.path == "/api/import":
            meta, qs = qmd.parse(req.get("md") or "")
            if not qs:
                return self.reply(400, {"ok": False, "error": "md에서 질문(## 질문)을 찾지 못했습니다"})
            with lock:
                data = read() if QFILE.exists() else {"meta": {}, "questions": []}
                if req.get("mode") == "append":
                    data["questions"] += qmd.assign_ids(qs, {x["id"] for x in data["questions"]})
                else:
                    data["questions"] = qs
                if meta and (req.get("mode") != "append" or not data.get("meta", {}).get("title")):
                    data["meta"] = data.get("meta", {}) | meta
                write(data)
            return self.reply(200, {"ok": True, "count": len(qs)})

        if self.path == "/api/export":
            data = read()
            return self.reply(200, {"ok": True, "md": qmd.dump(data.get("meta", {}), data["questions"])})

        if self.path == "/api/meta":
            with lock:
                data = read()
                data["meta"] = {k: str(req.get(k, "")).strip() for k in ("title", "date")}
                write(data)
            return self.reply(200, {"ok": True})

        if self.path == "/api/key":
            kf = ROOT / "elevenlabs_key.local"
            if "key" in req:
                k = str(req["key"]).strip()
                kf.write_text(k) if k else kf.unlink(missing_ok=True)
            from make_tts import api_key
            return self.reply(200, {"ok": True, "has": bool(api_key())})

        if self.path == "/api/tts":
            with lock:
                ok, log = run_tts("--only", req.get("id", ""), "--no-concat")
            return self.reply(200 if ok else 500, {"ok": ok, "log": log})

        if self.path == "/api/concat":
            with lock:
                ok, log = run_tts()
            return self.reply(200 if ok else 500, {"ok": ok, "log": log})

        self.reply(404, {"ok": False})


if __name__ == "__main__":
    ensure_qfile()
    print(f"http://localhost:{PORT}  (종료: Ctrl+C)")
    ThreadingHTTPServer(("127.0.0.1", PORT), H).serve_forever()
