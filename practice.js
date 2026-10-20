const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
const esc = s => String(s ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const load = (k, d) => { try { return JSON.parse(localStorage.getItem(k)) ?? d } catch { return d } };
const save = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)) } catch { } };
const CAT_ORDER = ["자기소개", "지원동기", "인성", "직무-AI", "약점방어", "직무조정", "돌발"];
const SPM = 316;        // 연우3_C 실측 속도(음절/분)
const BREAK = 0.6;      // 문장 끝 쉼(초)

const S = { qs: [], cat: load("pr_cat", "전체"), q: "", playlist: [], idx: -1, run: 0, paused: false, playing: false,
  audio: new Audio(), ver: {}, server: false, editing: new Set(), dirtyConcat: load("pr_dirty", false), sleepEnd: 0, mic: null };

// ───────────────────────── 데이터·서버
async function loadQs() {
  const d = await fetch("questions.json", { cache: "no-store" }).then(r => r.json());
  S.qs = d.questions;
}
async function ping() {
  try { S.server = (await fetch("api/ping", { method: "POST" })).ok } catch { S.server = false }
}
async function api(path, body) {
  const r = await fetch("api/" + path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body || {}) });
  const j = await r.json().catch(() => ({ ok: false, log: "응답 없음" }));
  if (!j.ok) throw new Error(j.error || j.log || "실패");
  return j;
}
const qUrl = id => `audio/q/${id}.mp3?v=${S.ver[id] || 0}`;
const aUrl = id => `audio/a/${id}.mp3?v=${S.ver[id] || 0}`;

// ───────────────────────── 스크립트 통계 (편집 중 실시간)
const syl = t => (t.match(/[가-힣]/g) || []).length + (t.match(/\d/g) || []).length * 1.5;
const sentences = t => (t || "").split(/(?<=[.?!])\s+/).filter(Boolean);
const MARK = {
  문제: /(문제|어려|부족|불가능|걸렸|안 ?됐|누락|야근|제약|한계|틀리|부정확|당시)/,
  행동: /(그래서 ?저는|저는 .{0,30}(했|만들|정리|정하|확인|제안)|첫째|둘째|직접)/,
  결과: /(그 ?결과|결과적으로|덕분에|달성|줄였|올렸|출시|쓰이기|배웠|받았|마쳤)/,
  숫자: /\d|(한|두|세|네|다섯)\s?(명|개|건|곳|가지|번|배|시간|달|팀)/,
};
const BAD = /(것 ?같습니다|것 ?같아요|열심히|그런 |무언가|뭔가)/g;
function stats(text, limit) {
  const ss = sentences(text);
  const secs = syl(text) / SPM * 60 + Math.max(0, ss.length - 1) * BREAK;
  const first = syl(ss[0] || "");
  const out = [];
  out.push([`${text.length}자 · 약 ${Math.round(secs)}초 / ${limit}초`, secs > limit * 1.1 ? "no" : secs < limit * 0.5 ? "mid" : "ok"]);
  out.push([`첫 문장 ${Math.round(first)}음절`, first <= 40 ? "ok" : first <= 55 ? "mid" : "no"]);
  for (const [k, re] of Object.entries(MARK)) out.push([(re.test(text) ? "✓ " : "✗ ") + k, re.test(text) ? "ok" : "no"]);
  const bad = text.match(BAD); if (bad) out.push([`금지 표현 ${bad.length}회: ${[...new Set(bad)].join(", ")}`, "no"]);
  return out.map(([t, c]) => `<span class="st ${c}">${esc(t)}</span>`).join("");
}

// ───────────────────────── 목록
const allCats = () => [...CAT_ORDER, ...[...new Set(S.qs.map(q => q.cat))].filter(c => !CAT_ORDER.includes(c))];
function cats() { return allCats().filter(c => S.qs.some(q => q.cat === c)) }
function visible() {
  const k = S.q.trim();
  return S.qs.filter(q => (S.cat === "전체" || q.cat === S.cat) && (!k || (q.q + (q.script || "") + (q.guide || "")).includes(k)))
    .sort((a, b) => allCats().indexOf(a.cat) - allCats().indexOf(b.cat));
}
function renderChips() {
  $("#catChips").innerHTML = ["전체", ...cats()].map(c => `<button class="cchip ${c === S.cat ? "on" : ""}" data-c="${c}">${c}</button>`).join("");
}
function card(q) {
  const body = q.script || q.guide || "";
  const ed = S.editing.has(q.id);
  return `<div class="qc ${S.playlist[S.idx]?.id === q.id && S.playing ? "playing" : ""}" id="c-${q.id}">
    <div class="top"><div class="qt">${esc(q.q)}</div>
      <div class="badges"><span class="badge">${q.time}초</span>${q.script ? "" : '<span class="badge guide">방향만</span>'}${q.check ? '<span class="badge chk">📌 확인</span>' : ""}</div></div>
    ${ed ? "" : `<div class="body">${esc(q.script ? body : "방향: " + body)}</div>${q.tip ? `<div class="tip">💡 ${esc(q.tip)}</div>` : ""}`}
    <div class="acts">
      <button data-act="one" data-id="${q.id}">▶ 재생</button>
      <button data-act="play" data-id="${q.id}">여기서부터</button>
      <button data-act="edit" data-id="${q.id}" class="ghost">${ed ? "닫기" : "✎ 수정"}</button>
    </div>
    ${ed ? editor(q) : ""}
  </div>`;
}
function editor(q) {
  const text = q.script || "";
  return `<div class="ed" data-id="${q.id}">
    <label>질문</label><input data-f="q" value="${esc(q.q)}">
    <div class="grid2"><div><label>카테고리</label><input data-f="cat" value="${esc(q.cat)}" list="catList"></div>
      <div><label>답변 시간(초)</label><input data-f="time" type="number" min="10" max="300" value="${q.time}"></div></div>
    <label>답변 스크립트</label>
    <textarea data-f="script" placeholder="결론 → 문제 → 행동 → 결과·숫자">${esc(text)}</textarea>
    <div class="stats">${stats(text, q.time)}</div>
    <label>방향 (스크립트 대신 답 방향만 적을 때)</label><input data-f="guide" value="${esc(q.guide || "")}">
    <label>팁</label><input data-f="tip" value="${esc(q.tip || "")}">
    <datalist id="catList">${allCats().map(c => `<option value="${esc(c)}">`).join("")}</datalist>
    <div class="row2">
      <button data-act="save" data-id="${q.id}">저장</button>
      <button data-act="saveTts" data-id="${q.id}" class="primary" title="ElevenLabs 키가 있을 때만">저장 + 음성 생성</button>
      <span class="msg dim"></span>
      <button data-act="del" data-id="${q.id}" class="ghost danger">삭제</button>
    </div>
  </div>`;
}
function renderList() {
  const vs = visible(); let html = "", cur = "";
  for (const q of vs) {
    if (q.cat !== cur) { cur = q.cat; html += `<div class="cat-h">${esc(cur)} <button data-act="playCat" data-c="${esc(cur)}">▶</button></div>` }
    html += card(q);
  }
  $("#list").innerHTML = html || `<p class="dim">맞는 질문이 없습니다.</p>`;
}
function renderBanner() {
  const b = $("#banner");
  if (!S.server) b.innerHTML = `⚠️ 저장하려면 연습시작.command로 열기`;
  else if (S.dirtyConcat) b.innerHTML = `수정 사항 통파일 미반영 <button id="bannerConcat">반영</button>`;
  else b.innerHTML = "";
  $("#bannerConcat")?.addEventListener("click", reconcat);
}

// ───────────────────────── 목록 이벤트
$("#catChips").onclick = e => { const c = e.target.dataset.c; if (!c) return; S.cat = c; save("pr_cat", c); renderChips(); renderList() };
$("#search").oninput = e => { S.q = e.target.value; renderList() };
$("#list").addEventListener("input", e => {
  const ed = e.target.closest(".ed"); if (!ed || e.target.dataset.f !== "script") return;
  const q = S.qs.find(x => x.id === ed.dataset.id);
  ed.querySelector(".stats").innerHTML = stats(e.target.value, q.time);
});
$("#list").onclick = async e => {
  const b = e.target.closest("button"); if (!b) return;
  const { act, id } = b.dataset; const q = S.qs.find(x => x.id === id);
  if (act === "play") startPlaylist(visible(), visible().findIndex(x => x.id === id));
  if (act === "one") { $("#loopOne").checked = false; startPlaylist([q], 0, true) }
  if (act === "playCat") { const l = visible().filter(x => x.cat === b.dataset.c); startPlaylist(l, 0) }
  if (act === "qa") previewAudio(qUrl(id), q.q);
  if (act === "aa") previewAudio(aUrl(id), q.script || q.guide);
  if (act === "edit") { S.editing.has(id) ? S.editing.delete(id) : S.editing.add(id); renderList(); $(`#c-${id} textarea`)?.focus() }
  if (act === "save" || act === "saveTts") await saveItem(q, b.closest(".ed"), act === "saveTts");
  if (act === "del" && (await openModal({ title: "질문 삭제", body: `<p class="hint">이 질문을 지울까요? 되돌릴 수 없습니다.</p><p style="margin:8px 0 0">${esc(q.q)}</p>`, acts: [{ label: "취소", value: "cancel", cls: "ghost" }, { label: "삭제", value: "ok", cls: "primary" }] })).action === "ok") {
    try { await api("delete", { id }); S.qs = S.qs.filter(x => x.id !== id); renderChips(); renderList() } catch (err) { alert("실패: " + err.message) }
  }
};

// ───────────────────────── 모달
// openModal({ title, body: html, acts: [{ label, value, cls }] }) → 누른 버튼의 value + 입력값
function openModal({ title, body, acts }) {
  const dlg = $("#modal");
  $("#mTitle").textContent = title; $("#mBody").innerHTML = body;
  $("#mActs").innerHTML = (acts || []).map(a => `<button value="${a.value}" class="${a.cls || ""}" ${a.value === "cancel" ? 'formnovalidate' : ""}>${esc(a.label)}</button>`).join("");
  dlg.returnValue = ""; dlg.showModal();
  setTimeout(() => dlg.querySelector("[autofocus], input, textarea")?.focus(), 30);
  return new Promise(res => {
    $("#mBody").onclick = e => { const v = e.target.closest("[data-pick]")?.dataset.pick; if (v) { dlg.returnValue = v; dlg.close() } };
    dlg.onclose = () => {
      const vals = {}; $$("#mBody [name]").forEach(i => vals[i.name] = i.value.trim());
      res({ action: dlg.returnValue || "cancel", ...vals });
    };
  });
}
const OK_CANCEL = (ok = "저장") => [{ label: "취소", value: "cancel", cls: "ghost" }, { label: ok, value: "ok", cls: "primary" }];

// ───────────────────────── 질문 추가·md 가져오기/내보내기
const needServer = () => { if (!S.server) { openModal({ title: "서버로 열어야 저장됩니다", body: `<p class="hint">연습시작.command(또는 <code>python3 server.py</code>)로 연 다음 다시 시도해 주세요.</p>`, acts: [{ label: "확인", value: "ok", cls: "primary" }] }); return true } return false };
$("#tAdd").onclick = async () => {
  if (needServer()) return;
  const r = await openModal({
    title: "질문 추가",
    body: `<label>질문</label><input name="q" required autofocus placeholder="예: 우리 회사에 지원한 이유가 무엇인가요?">
      <div class="grid2"><div><label>카테고리</label><input name="cat" list="catListM" required value="${esc(S.cat !== "전체" ? S.cat : "인성")}"></div>
        <div><label>답변 시간(초)</label><input name="time" type="number" min="10" max="300" value="60"></div></div>
      <datalist id="catListM">${allCats().map(c => `<option value="${esc(c)}">`).join("")}</datalist>
      <label>답변 스크립트 <small>(나중에 써도 됩니다)</small></label><textarea name="script" placeholder="결론 → 문제 → 행동 → 결과·숫자"></textarea>`,
    acts: OK_CANCEL("추가"),
  });
  if (r.action !== "ok" || !r.q) return;
  try {
    let { item } = await api("add", { cat: r.cat || "기타", q: r.q });
    if (r.script || r.time) ({ item } = await api("save", { id: item.id, script: r.script, time: r.time }));
    S.qs.push(item); S.cat = item.cat; save("pr_cat", item.cat); renderChips(); renderList();
    $(`#c-${item.id}`)?.scrollIntoView({ block: "center", behavior: "smooth" });
  } catch (err) { alert("실패: " + err.message) }
};
$("#tImport").onclick = () => { if (!needServer()) $("#tFile").click() };
$("#tFile").onchange = async e => {
  const f = e.target.files[0]; e.target.value = ""; if (!f) return;
  const md = await f.text(), n = (md.match(/^## /gm) || []).length;
  const r = await openModal({
    title: "md 가져오기",
    body: `<p class="hint"><b>${esc(f.name)}</b> · 질문 ${n}개를 찾았습니다. 어떻게 넣을까요?</p>
      <div class="choice">
        <button type="button" data-pick="append"><b>뒤에 이어 붙이기</b><span>지금 질문 ${S.qs.length}개는 그대로 두고 추가합니다</span></button>
        <button type="button" data-pick="replace"><b>전부 바꾸기</b><span>지금 질문을 모두 지우고 이 파일로 바꿉니다 (먼저 md 내보내기로 백업 권장)</span></button>
      </div>`,
    acts: [{ label: "취소", value: "cancel", cls: "ghost" }],
  });
  if (!["append", "replace"].includes(r.action)) return;
  try {
    const { count } = await api("import", { md, mode: r.action }); await loadQs(); renderChips(); renderList();
    openModal({ title: "가져오기 완료", body: `<p class="hint">질문 ${count}개를 ${r.action === "replace" ? "새로 넣었습니다" : "추가했습니다"}.</p>`, acts: [{ label: "확인", value: "ok", cls: "primary" }] });
  } catch (err) { alert("가져오기 실패: " + err.message) }
};
$("#tExport").onclick = async () => {
  if (needServer()) return;
  const { md } = await api("export");
  const a = document.createElement("a"); a.href = URL.createObjectURL(new Blob([md], { type: "text/markdown" }));
  a.download = `면접질문_${new Date().toISOString().slice(0, 10)}.md`; a.click();
};
$("#tVoice").onclick = async () => {
  if (needServer()) return;
  const { has } = await api("key", {});
  const r = await openModal({
    title: "🔊 음성 설정",
    body: `<p class="hint">기본은 <b>브라우저 음성</b>으로 질문과 답변을 읽어 줍니다. ElevenLabs API 키를 넣으면 더 자연스러운 음성 파일을 만들 수 있습니다.</p>
      <label>ElevenLabs API 키 ${has ? '<span class="good">· 저장됨 ✓</span>' : '<span class="dim">· 없음</span>'}</label>
      <input name="key" type="password" autocomplete="off" placeholder="${has ? "바꾸려면 새 키 입력 (비우면 그대로)" : "sk_로 시작하는 키 붙여 넣기"}">
      <p class="hint">키는 이 컴퓨터의 <code>elevenlabs_key.local</code> 파일에만 저장되고 git에는 올라가지 않습니다.<br>
        저장 후 질문 카드 [✎ 수정] → <b>[저장 + 음성 생성]</b>으로 한 문항씩, 또는 아래 버튼으로 전체를 만듭니다.</p>`,
    acts: [{ label: "닫기", value: "cancel", cls: "ghost" }, ...(has ? [{ label: "키 지우기", value: "del", cls: "ghost" }] : []),
      { label: "모든 질문 음성 만들기", value: "all" }, { label: "키 저장", value: "ok", cls: "primary" }],
  });
  if (r.action === "del") { await api("key", { key: "" }); return }
  if (r.key && ["ok", "all"].includes(r.action)) await api("key", { key: r.key });
  if (r.action === "all") {
    if (!(await api("key", {})).has) { alert("먼저 키를 저장해 주세요"); return }
    openModal({ title: "음성 만드는 중…", body: `<p class="hint"><span class="spin"></span> 질문 ${S.qs.length}개 · 문항당 몇 초씩 걸립니다. 창을 닫지 마세요.</p>`, acts: [] });
    try { await api("concat"); S.ver = Object.fromEntries(S.qs.map(q => [q.id, Date.now()])); save("pr_ver", S.ver); S.dirtyConcat = false; save("pr_dirty", false); $("#modal").close();
      openModal({ title: "음성 완료 ✓", body: `<p class="hint">모든 질문의 음성을 만들었습니다.</p>`, acts: [{ label: "확인", value: "ok", cls: "primary" }] }) }
    catch (err) { $("#modal").close(); alert("실패: " + err.message.slice(0, 300)) }
    renderBanner(); renderBed?.();
  }
};
$("#tMeta").onclick = async () => {
  if (needServer()) return;
  const d = await fetch("questions.json", { cache: "no-store" }).then(r => r.json()); const m = d.meta || {};
  const r = await openModal({
    title: "면접 이름·날짜",
    body: `<label>면접 이름</label><input name="title" autofocus value="${esc(m.title || "")}" placeholder="예: OO회사 1차 면접">
      <label>면접 날짜</label><input name="date" type="date" value="${esc(m.date || "")}">
      <p class="hint">홈 화면에 “면접 이름 D-3”처럼 표시됩니다. 날짜를 비워 두면 D-day는 숨깁니다.</p>`,
    acts: OK_CANCEL(),
  });
  if (r.action !== "ok") return;
  await api("meta", { title: r.title, date: r.date });
};
function previewAudio(url, text) { stopAll(); const run = S.run; playUrl(url, run, null, text).catch(() => { }) }

async function saveItem(q, ed, tts) {
  const msg = ed.querySelector(".msg");
  if (!S.server) { msg.textContent = "연습시작.command로 열어야 저장됩니다"; return }
  const body = { id: q.id }; ed.querySelectorAll("[data-f]").forEach(i => body[i.dataset.f] = i.value);
  const changed = ["q", "script"].some(k => (body[k] || "").trim() !== (q[k] || "").trim());
  try {
    msg.innerHTML = `<span class="spin"></span> 저장 중`;
    const { item } = await api("save", body);
    Object.assign(q, item); for (const k of ["tip", "script", "guide"]) if (!item[k]) delete q[k];
    if (body.cat) renderChips();
    if (tts) {
      msg.innerHTML = `<span class="spin"></span> 음성 생성 중`;
      await api("tts", { id: q.id });
      S.ver[q.id] = Date.now(); save("pr_ver", S.ver);
      S.dirtyConcat = true; save("pr_dirty", true);
      msg.innerHTML = `<span class="good">저장·음성 완료 ✓</span>`;
      setTimeout(() => { S.editing.delete(q.id); renderList(); previewAudio(aUrl(q.id), q.script) }, 600);
    } else {
      msg.innerHTML = `<span class="good">저장 ✓</span>${changed ? " — 음성은 아직 예전 버전" : ""}`;
    }
    renderBanner();
  } catch (err) { msg.innerHTML = `<span class="bad">실패: ${esc(err.message).slice(0, 200)}</span>` }
}
async function reconcat() {
  const btns = [$("#reconcat"), $("#bannerConcat")].filter(Boolean);
  if (!S.server) { alert("연습시작.command로 열어야 합니다"); return }
  btns.forEach(b => { b.disabled = true; b.innerHTML = `<span class="spin"></span> 합치는 중 (1~2분)` });
  try { await api("concat"); S.dirtyConcat = false; save("pr_dirty", false); renderBed() }
  catch (err) { alert("실패: " + err.message) }
  btns.forEach(b => { b.disabled = false; b.textContent = b.id === "bannerConcat" ? "반영" : "통파일 다시 만들기" });
  renderBanner();
}
$("#reconcat").onclick = reconcat;

// ───────────────────────── 플레이어
const CANCEL = Symbol("cancel");
const guard = run => { if (run !== S.run) throw CANCEL };
async function wait(sec, run, onTick) {
  let left = sec;
  while (left > 0) { guard(run); if (S.skipTurn) { S.skipTurn = false; return } if (!S.paused) { left -= 0.1; onTick?.(left) } await new Promise(r => setTimeout(r, 100)) }
}
// 음성 파일이 없으면 브라우저 음성(한국어 TTS)으로 읽기
function say(text, run) {
  return new Promise(res => {
    if (!text) return res();
    speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text); u.lang = "ko-KR"; u.rate = +$("#rate").value;
    const iv = setInterval(() => { if (run !== S.run) { speechSynthesis.cancel(); done() } }, 150);
    const done = () => { clearInterval(iv); res() };
    u.onend = done; u.onerror = done; speechSynthesis.speak(u);
  });
}
function playUrl(url, run, onTime, fallback) {
  return new Promise((res, rej) => {
    const a = S.audio; a.src = url; a.playbackRate = +$("#rate").value;
    const iv = setInterval(() => { if (run !== S.run) { clearInterval(iv); a.pause(); rej(CANCEL) } else onTime?.(a) }, 120);
    const fb = () => { clearInterval(iv); fallback ? say(fallback, run).then(res) : res() };
    a.onended = () => { clearInterval(iv); res() };
    a.onerror = fb;
    a.play().catch(fb);
  });
}
function stopAll() { S.run++; S.audio.pause(); speechSynthesis.cancel(); S.playing = false; S.paused = false; $("#pDone").hidden = true; $("#npTurn").textContent = ""; updatePlayBtn() }

function startPlaylist(list, idx = 0, single = false) {
  if (!list.length) return;
  if ($("#shuffle").checked && !single) { const first = list[idx]; list = [first, ...list.filter(x => x !== first).sort(() => Math.random() - .5)]; idx = 0 }
  S.playlist = list; S.idx = Math.max(0, idx); S.single = single;
  playFrom(S.idx);
}
async function playFrom(i) {
  stopAll(); const run = S.run; S.playing = true; S.idx = i; updatePlayBtn();
  try {
    while (S.idx < S.playlist.length) {
      await playItem(S.playlist[S.idx], run);
      guard(run);
      if ($("#loopOne").checked) continue;
      if (S.single) break;
      S.idx++;
    }
    $("#npMeta").textContent = "재생 끝"; S.playing = false; updatePlayBtn(); renderList();
  } catch (e) { if (e !== CANCEL) throw e }
}

async function playItem(q, run) {
  const mode = $("input[name=pm]:checked").value, blind = $("#blind").checked;
  $$(".qc.playing").forEach(c => c.classList.remove("playing"));
  const el = $(`#c-${q.id}`); el?.classList.add("playing"); el?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  $("#npMeta").textContent = `${q.cat} · ${S.idx + 1}/${S.playlist.length} · 제한 ${q.time}초`;
  $("#npQ").textContent = q.q;
  const text = q.script || ("방향: " + (q.guide || ""));
  const ss = sentences(text);
  $("#npA").innerHTML = ss.map((s, k) => `<span class="s" data-k="${k}">${esc(s)}</span>`).join(" ");
  $("#npA").classList.toggle("blind", blind); $("#reveal").hidden = !blind;
  $("#npTurn").textContent = "";
  mediaMeta(q);

  if (mode !== "answer") await playUrl(qUrl(q.id), run, null, q.q);
  guard(run);
  let mine = null;
  if (mode === "shadow") {
    const t = +$("#think").value;
    const rec = $("#recMine").checked ? await startRec() : null;
    $("#pDone").hidden = false;
    await wait(t, run, left => $("#npTurn").textContent = `🎙 내 차례 — 결론부터! ${Math.ceil(left)}초`);
    $("#pDone").hidden = true; $("#npTurn").textContent = "";
    if (rec) mine = await stopRec(rec);
  } else if (mode === "listen") await wait(1.2, run);
  guard(run);

  // 답변 재생 + 현재 문장 하이라이트 (음절 비율로 추정)
  if (mode === "shadow" && blind) { $("#npA").classList.remove("blind"); $("#reveal").hidden = true }
  const w = ss.map(s => syl(s) / SPM * 60 + BREAK); const tot = w.reduce((a, b) => a + b, 0);
  await playUrl(aUrl(q.id), run, a => {
    if (!a.duration) return;
    let t = a.currentTime / a.duration * tot, k = 0; while (k < w.length - 1 && t > w[k]) { t -= w[k]; k++ }
    $$("#npA .s").forEach(s => s.classList.toggle("cur", +s.dataset.k === k));
  }, text);
  $$("#npA .s").forEach(s => s.classList.remove("cur"));
  if (mine) {
    await wait(0.8, run);
    $("#npTurn").textContent = "🔁 방금 내 답변";
    await playUrl(mine, run); URL.revokeObjectURL(mine);
    $("#npTurn").textContent = "";
  }
  await wait(+$("#gap").value, run);
}

async function startRec() {
  try {
    S.mic ??= await navigator.mediaDevices.getUserMedia({ audio: true });
    const r = new MediaRecorder(S.mic), chunks = [];
    r.ondataavailable = e => chunks.push(e.data); r.start(); r.chunks = chunks; return r;
  } catch { $("#recMine").checked = false; return null }
}
function stopRec(r) { return new Promise(res => { r.onstop = () => res(URL.createObjectURL(new Blob(r.chunks, { type: r.mimeType }))); r.stop() }) }

function updatePlayBtn() {
  const b = $("#pPlay");
  b.textContent = !S.playing ? (S.playlist.length ? "▶ 이어 재생" : "▶ 전체 재생") : S.paused ? "▶ 계속" : "⏸ 일시정지";
}
$("#pPlay").onclick = () => {
  if (!S.playing) { S.playlist.length && S.idx < S.playlist.length ? playFrom(S.idx) : startPlaylist(visible(), 0); return }
  S.paused = !S.paused; S.paused ? S.audio.pause() : S.audio.play().catch(() => { }); updatePlayBtn();
};
$("#pNext").onclick = () => { if (S.playlist.length) playFrom(Math.min(S.idx + 1, S.playlist.length - 1)) };
$("#pPrev").onclick = () => { if (S.playlist.length) playFrom(Math.max(S.idx - 1, 0)) };
$("#pDone").onclick = () => { S.skipTurn = true };
$("#reveal").onclick = () => { $("#npA").classList.remove("blind"); $("#reveal").hidden = true };
$("#rate").onchange = e => { S.audio.playbackRate = +e.target.value; save("pr_rate", e.target.value) };
$("#think").oninput = e => { $("#thinkV").textContent = e.target.value + "초"; save("pr_think", e.target.value) };
$$("input[name=pm]").forEach(r => r.onchange = () => { save("pr_mode", r.value); $("#thinkRow").style.opacity = r.value === "shadow" ? 1 : .4 });
document.addEventListener("keydown", e => {
  if (["INPUT", "TEXTAREA", "SELECT"].includes(e.target.tagName)) return;
  if (e.code === "Space") { e.preventDefault(); if (!$("#pDone").hidden) $("#pDone").click(); else $("#pPlay").click() }
  if (e.code === "ArrowRight") $("#pNext").click();
  if (e.code === "ArrowLeft") $("#pPrev").click();
});

// 이어폰·잠금화면 버튼
function mediaMeta(q) {
  if (!("mediaSession" in navigator)) return;
  navigator.mediaSession.metadata = new MediaMetadata({ title: q.q, artist: `면접 연습 · ${q.cat}` });
  navigator.mediaSession.setActionHandler("nexttrack", () => $("#pNext").click());
  navigator.mediaSession.setActionHandler("previoustrack", () => $("#pPrev").click());
  navigator.mediaSession.setActionHandler("pause", () => { if (!S.paused) $("#pPlay").click() });
  navigator.mediaSession.setActionHandler("play", () => { if (S.paused || !S.playing) $("#pPlay").click() });
}

// 취침 타이머: 끝나기 20초 전부터 소리 줄이고 정지
$("#sleepT").onchange = e => { const m = +e.target.value; S.sleepEnd = m ? Date.now() + m * 60000 : 0; if (!m) { S.audio.volume = 1; $("#sleepLeft").textContent = "" } };
setInterval(() => {
  if (!S.sleepEnd) return;
  const left = (S.sleepEnd - Date.now()) / 1000;
  $("#sleepLeft").textContent = left > 0 ? `${Math.ceil(left / 60)}분 남음` : "";
  if (left < 20) S.audio.volume = Math.max(0, left / 20);
  if (left <= 0) { stopAll(); S.sleepEnd = 0; S.audio.volume = 1; $("#sleepT").value = "0"; $("#npMeta").textContent = "취침 타이머 종료 · 잘 자요 🌙" }
}, 1000);

// ───────────────────────── 취침용 통파일
function renderBed() {
  const v = Date.now(), cs = cats();
  const row = (label, url) => `<div class="bedrow"><span>${label}</span><audio controls preload="none" src="${url}?v=${v}"></audio></div>`;
  $("#bedFiles").innerHTML = `<h3>취침용</h3>${row("전체", "audio/취침용/00_전체.mp3")}` +
    cs.map(c => row(c, `audio/취침용/${String(allCats().indexOf(c) + 1).padStart(2, "0")}_${c}.mp3`)).join("") +
    `<h3>쉐도잉</h3>` + cs.map(c => row(c, `audio/쉐도잉/${String(allCats().indexOf(c) + 1).padStart(2, "0")}_${c}.mp3`)).join("");
}

// ───────────────────────── 시작
S.ver = load("pr_ver", {});
$("#rate").value = load("pr_rate", "1.0");
$("#think").value = load("pr_think", 45); $("#thinkV").textContent = $("#think").value + "초";
const m = load("pr_mode", "listen"); $(`input[name=pm][value=${m}]`).checked = true; $("#thinkRow").style.opacity = m === "shadow" ? 1 : .4;
await Promise.all([loadQs(), ping()]);
if (S.cat !== "전체" && !cats().includes(S.cat)) S.cat = "전체";
renderChips(); renderList(); renderBanner(); renderBed();
