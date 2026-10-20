#!/usr/bin/env python3
"""questions.json → 면접 음성 파일 생성.

  audio/q/<id>.mp3         면접관 질문 (연습 앱이 재생)
  audio/a/<id>.mp3         답변 스크립트(또는 답변 방향)
  audio/취침용/*.mp3        카테고리별 [질문 → 답변] 연속 재생 — 자기 전에 듣기
  audio/쉐도잉/*.mp3        [질문 → 20초 생각할 시간 → 답변] — 먼저 말해 보고 비교

사용:
  .venv/bin/python make_tts.py                  # 기본: 면접관 Yohan + 답변 연우3(톤 pause)
  .venv/bin/python make_tts.py --tone v3        # 톤 프리셋: basic | stable | pause | v3
  .venv/bin/python make_tts.py --only intro60,why_quit           # 일부만 다시
바뀐 텍스트만 다시 생성한다(.cache.json).
"""
import argparse, asyncio, hashlib, json, os, re, subprocess, sys, tempfile, urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent
AUDIO = ROOT / "audio"
CACHE_FILE = AUDIO / ".cache.json"
INTERVIEWER = "eleven:4JJwo477JUAx3HV0T7n7"   # 면접관: Yohan Koo (남성, 차분)

# 답변 톤 프리셋 (샘플 A~D와 같음)
TONES = {
    "basic":  dict(model="eleven_multilingual_v2", settings={"stability": 0.55, "similarity_boost": 0.75, "style": 0, "speed": 1.0}),
    "stable": dict(model="eleven_multilingual_v2", settings={"stability": 0.75, "similarity_boost": 0.8, "style": 0, "speed": 0.95, "use_speaker_boost": True}),
    "pause":  dict(model="eleven_multilingual_v2", settings={"stability": 0.75, "similarity_boost": 0.8, "style": 0, "speed": 0.95, "use_speaker_boost": True}, breaks=0.6),
    "v3":     dict(model="eleven_v3", settings={"stability": 0.5, "similarity_boost": 0.8}, prefix="[calm] [confident] "),
}
Q_TONE = dict(model="eleven_multilingual_v2", settings={"stability": 0.7, "similarity_boost": 0.8, "style": 0, "speed": 0.95})
CAT_ORDER = ["자기소개", "지원동기", "인성", "직무-AI", "약점방어", "직무조정", "돌발"]

# TTS가 잘못 읽는 표기 → 읽는 소리
READ_AS = [
    ("RAG", "래그"), ("Tool Calling", "툴 콜링"),
    ("Tool", "툴"), ("LLM", "엘엘엠"), ("API", "에이피아이"), ("AI", "에이아이"), ("SaaS", "사스"),
    ("PRD", "피알디"), ("PM", "피엠"), ("MVP", "엠브이피"), ("DB", "디비"), ("CLI", "씨엘아이"),
    ("SI", "에스아이"), ("Mock", "목업"),
    ("LangChain", "랭체인"), ("LangGraph", "랭그래프"),
    ("AX", "에이엑스"), ("2인분", "이인분"),
    ("%", " 퍼센트"), ("→", ", "), ("·", ", "),
]
# 개인 읽기 규칙 (회사명·프로젝트명 등) — read_as.local.json, git에는 안 올라감. 예: [["LG CNS", "엘지 씨엔에스"]]
_local = Path(__file__).resolve().parent / "read_as.local.json"
if _local.exists():
    READ_AS = [tuple(x) for x in json.loads(_local.read_text(encoding="utf-8"))] + READ_AS

def speakable(text: str) -> str:
    text = re.sub(r"📌[^.。]*[.。]?", "", text)
    text = re.sub(r"[🚨⚠️✅⬜🔶]", "", text)
    for a, b in READ_AS:
        text = text.replace(a, b)
    text = text.replace("'", "").replace("\"", "")
    return re.sub(r"\s+", " ", text).strip()

KEY_FILE = Path(__file__).resolve().parent / "elevenlabs_key.local"   # git에 안 올라감
ENV_FILES = ("elevenlabs.env", ".env")   # 받은 env 파일을 앱 폴더에 넣으면 됨 (git에 안 올라감)
def env_get(name):
    if os.environ.get(name):
        return os.environ[name]
    for fn in ENV_FILES:
        f = Path(__file__).resolve().parent / fn
        if f.exists():
            for line in f.read_text(encoding="utf-8").splitlines():
                k, _, v = line.partition("=")
                if k.strip() == name and v.strip():
                    return v.strip().strip('"').strip("'")
    return ""
def api_key():
    return env_get("ELEVENLABS_API_KEY") or (KEY_FILE.read_text().strip() if KEY_FILE.exists() else "")
# 답변 음성: 기본은 면접관과 같은 남성 음성. 개인 음성을 쓰려면 .env에 ELEVENLABS_ANSWER_VOICE=eleven:<voice_id>
ANSWER_VOICE = env_get("ELEVENLABS_ANSWER_VOICE") or INTERVIEWER

def sh(*args):
    subprocess.run(args, check=True, capture_output=True)

async def tts_edge(voice, text, out):
    import edge_tts
    await edge_tts.Communicate(text, voice, rate="-5%").save(str(out))

def tts_eleven(voice_id, text, out, tone):
    key = api_key() or sys.exit("ElevenLabs API 키가 없습니다 — 연습모드 [🔊 음성 설정]에서 넣거나 ELEVENLABS_API_KEY 환경변수로")
    if tone.get("breaks"):   # 문장 사이 쉼 → 차분하고 단정하게 들림
        text = re.sub(r"(니다\.)\s+", rf'\1 <break time="{tone["breaks"]}s" /> ', text)
    text = tone.get("prefix", "") + text
    req = urllib.request.Request(
        f"https://api.elevenlabs.io/v1/text-to-speech/{voice_id}",
        data=json.dumps({"text": text, "model_id": tone["model"], "voice_settings": tone["settings"]}).encode(),
        headers={"xi-api-key": key, "Content-Type": "application/json"})
    with urllib.request.urlopen(req) as r:
        out.write_bytes(r.read())

def synth(voice, text, out: Path, cache, tone=None):
    tone = tone or TONES["basic"]
    sig = hashlib.sha1(f"{voice}|{json.dumps(tone, sort_keys=True)}|{text}".encode()).hexdigest()
    if out.exists() and cache.get(str(out)) == sig:
        return False
    out.parent.mkdir(parents=True, exist_ok=True)
    engine, vid = voice.split(":", 1)
    if engine == "edge":
        asyncio.run(tts_edge(vid, text, out))
    elif engine == "eleven":
        tts_eleven(vid, text, out, tone)
    else:
        sys.exit(f"알 수 없는 voice: {voice}")
    cache[str(out)] = sig
    return True

def concat(parts, out: Path, tmp: Path):
    """parts: 파일 경로 또는 무음 초(float). 모두 44.1kHz mono로 맞춰 이어 붙인다."""
    lst = tmp / "list.txt"
    lines = []
    for i, p in enumerate(parts):
        w = tmp / f"{out.stem}_{i}.wav"
        if isinstance(p, (int, float)):
            sh("ffmpeg", "-y", "-f", "lavfi", "-i", "anullsrc=r=44100:cl=mono", "-t", str(p), str(w))
        else:
            sh("ffmpeg", "-y", "-i", str(p), "-ar", "44100", "-ac", "1", str(w))
        lines.append(f"file '{w}'")
    lst.write_text("\n".join(lines))
    out.parent.mkdir(parents=True, exist_ok=True)
    sh("ffmpeg", "-y", "-f", "concat", "-safe", "0", "-i", str(lst), "-b:a", "128k", str(out))

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--voice", default=ANSWER_VOICE, help="edge:<음성> 또는 eleven:<voice_id>")
    ap.add_argument("--tone", default="pause", choices=TONES, help="답변 톤 프리셋")
    ap.add_argument("--only", default="", help="쉼표로 구분한 질문 id")
    ap.add_argument("--think", type=float, default=20, help="쉐도잉 모드 생각 시간(초)")
    ap.add_argument("--no-concat", action="store_true", help="문항 음성만 만들고 취침용·쉐도잉 합치기는 건너뜀")
    args = ap.parse_args()

    qs = json.loads((ROOT / "questions.json").read_text())["questions"]
    only = set(filter(None, args.only.split(",")))
    cache = json.loads(CACHE_FILE.read_text()) if CACHE_FILE.exists() else {}

    for i, q in enumerate(qs, 1):
        if only and q["id"] not in only:
            continue
        body = q.get("script") or ("답변 방향입니다. " + q.get("guide", ""))
        made = synth(INTERVIEWER, speakable(q["q"]), AUDIO / "q" / f"{q['id']}.mp3", cache, Q_TONE)
        made |= synth(args.voice, speakable(body), AUDIO / "a" / f"{q['id']}.mp3", cache, TONES[args.tone])
        CACHE_FILE.write_text(json.dumps(cache, ensure_ascii=False, indent=1))
        print(f"[{i:2}/{len(qs)}] {'생성' if made else '유지'}  {q['id']}")

    if args.no_concat:
        return
    import shutil
    if not shutil.which("ffmpeg"):
        print("ffmpeg가 없어 취침용·쉐도잉 묶음 파일은 건너뜁니다 (문항 음성은 완료). 묶음이 필요하면: brew install ffmpeg")
        return
    print("취침용·쉐도잉 파일 합치는 중…")
    with tempfile.TemporaryDirectory() as t:
        tmp = Path(t)
        everything = []
        all_cats = CAT_ORDER + [c for c in dict.fromkeys(q["cat"] for q in qs) if c not in CAT_ORDER]
        for n, cat in enumerate(all_cats, 1):
            items = [q for q in qs if q["cat"] == cat]
            if not items:
                continue
            sleep, shadow = [], []
            for q in items:
                qa, aa = AUDIO / "q" / f"{q['id']}.mp3", AUDIO / "a" / f"{q['id']}.mp3"
                sleep += [qa, 1.5, aa, 3.5]
                shadow += [qa, args.think, aa, 3]
            concat(sleep, AUDIO / "취침용" / f"{n:02}_{cat}.mp3", tmp)
            concat(shadow, AUDIO / "쉐도잉" / f"{n:02}_{cat}.mp3", tmp)
            everything += sleep
            print(f"  ✓ {cat} ({len(items)}문항)")
        concat(everything, AUDIO / "취침용" / "00_전체.mp3", tmp)
    print(f"완료 → {AUDIO}")

if __name__ == "__main__":
    main()
