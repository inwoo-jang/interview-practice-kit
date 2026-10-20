"""질문 md ⇄ questions.json 변환.

md 형식 (질문_템플릿.md 참고)
  ---
  제목: OO회사 1차 면접
  날짜: 2026-10-23
  ---
  # 카테고리
  ## 질문 문장
  - 시간: 60            (선택, 초 · 기본 60)
  - id: intro60         (선택 · 없으면 자동)
  - 키워드: 지원, 이유   (선택 · 첫 문장에서 찾을 말)
  - 꼬리질문: 질문1 / 질문2   (선택)
  ### 답변
  답변 스크립트
  ### 방향
  스크립트 대신 답 방향만 적을 때
  ### 팁
  말하기 팁
"""
import re

SEC = {"답변": "script", "스크립트": "script", "답변 스크립트": "script", "팁": "tip", "방향": "guide", "가이드": "guide"}
ORDER = ["id", "cat", "time", "q", "keys", "script", "guide", "tip", "followups", "check"]


def _tidy(q):
    return {k: q[k] for k in ORDER if k in q} | {k: v for k, v in q.items() if k not in ORDER}


def parse(md):
    lines = md.replace("\r\n", "\n").split("\n")
    meta, qs, cat, cur, sec, buf, i = {}, [], "기타", None, None, [], 0
    if lines and lines[0].strip() == "---":
        j = 1
        while j < len(lines) and lines[j].strip() != "---":
            if ":" in lines[j]:
                k, v = lines[j].split(":", 1)
                meta[{"제목": "title", "날짜": "date"}.get(k.strip(), k.strip())] = v.strip()
            j += 1
        i = j + 1

    def flush():
        if cur is not None and sec:
            t = "\n".join(buf).strip()
            if t:
                cur[SEC[sec]] = t
        buf.clear()

    for line in lines[i:]:
        s = line.rstrip()
        if s.startswith("# "):
            flush(); sec = None; cat = s[2:].strip() or "기타"; continue
        if s.startswith("## "):
            flush(); sec = None; cur = {"cat": cat, "q": s[3:].strip(), "time": 60}; qs.append(cur); continue
        if s.startswith("### "):
            flush(); name = s[4:].strip(); sec = name if name in SEC else None; continue
        if cur is None:
            continue
        if sec is None:
            m = re.match(r"^[-*]\s*(시간|id|키워드|꼬리질문|꼬리)\s*[:：]\s*(.+)$", s.strip())
            if m:
                k, v = m.groups()
                if k == "시간":
                    cur["time"] = int(re.sub(r"\D", "", v) or 60)
                elif k == "id":
                    cur["id"] = v.strip()
                elif k == "키워드":
                    cur["keys"] = [x.strip() for x in re.split(r"[,，]", v) if x.strip()]
                else:
                    cur["followups"] = [x.strip() for x in v.split("/") if x.strip()]
            continue
        buf.append(line)
    flush()
    return meta, assign_ids(qs)


def assign_ids(qs, used=None):
    used = set(used or ())
    for n, q in enumerate(qs, 1):
        qid = re.sub(r"[^A-Za-z0-9_\-]", "_", q.get("id") or "") or f"q{n:02d}"
        while qid in used:
            qid += "_"
        used.add(qid)
        q["id"] = qid
    return [_tidy(q) for q in qs]


def dump(meta, qs):
    out = []
    if meta.get("title") or meta.get("date"):
        out += ["---", f"제목: {meta.get('title', '')}", f"날짜: {meta.get('date', '')}", "---", ""]
    cats = list(dict.fromkeys(q.get("cat", "기타") for q in qs))
    for c in cats:
        out += [f"# {c}", ""]
        for q in (x for x in qs if x.get("cat", "기타") == c):
            out += [f"## {q['q']}", f"- id: {q['id']}", f"- 시간: {q.get('time', 60)}"]
            if q.get("keys"):
                out.append("- 키워드: " + ", ".join(q["keys"]))
            if q.get("followups"):
                out.append("- 꼬리질문: " + " / ".join(q["followups"]))
            out.append("")
            for k, name in (("script", "답변"), ("guide", "방향"), ("tip", "팁")):
                if q.get(k):
                    out += [f"### {name}", q[k].strip(), ""]
    return "\n".join(out).rstrip() + "\n"
