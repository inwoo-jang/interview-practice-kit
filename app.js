import { FaceLandmarker, FilesetResolver } from "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/vision_bundle.mjs";

const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
const load = (k, d) => { try { return JSON.parse(localStorage.getItem(k)) ?? d } catch { return d } };
const save = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)) } catch {} };
const esc = s => String(s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const avg = a => a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0;
const std = a => { const m = avg(a); return Math.sqrt(avg(a.map(x => (x - m) ** 2))) };
const fmt = (n, d = 0) => (n == null || isNaN(n)) ? "–" : Number(n).toFixed(d);
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ───────────────────────── 상태
const S = {
  qs: [], fl: null, stream: null, ac: null, an: null, buf: null,
  calib: load("mi_calib", null), sens: 0.22,
  phase: "off",           // off | idle | calib | question | prep | answer | report
  t0: 0, face: null, lastDetect: 0, offSince: null,
  sess: null, queue: [], qi: -1, prevQ: null,
  noise: [], drill: null, abort: false,
};
const now = () => performance.now() / 1000;

// ───────────────────────── 질문 데이터
const data = await fetch("questions.json").then(r => r.json()).catch(() => null);
if (!data) { $("#qtext").textContent = "questions.json을 못 읽었습니다 — 연습시작.command로 여세요"; throw 0 }
S.qs = data.questions;
const CATS = [...new Set(S.qs.map(q => q.cat))];
let savedCats = load("mi_cats", CATS.filter(c => c !== "돌발"));
if (!savedCats.some(c => CATS.includes(c))) savedCats = CATS;   // 질문 세트가 바뀌면 전부 선택
$("#cats").innerHTML = CATS.map(c =>
  `<label><input type="checkbox" value="${c}" ${savedCats.includes(c) ? "checked" : ""}> ${c} <small>${S.qs.filter(q => q.cat === c).length}</small></label>`).join("");
$("#cats").onchange = () => save("mi_cats", $$("#cats input:checked").map(i => i.value));

// ───────────────────────── 설정 UI
const sensLabel = v => v < 0.18 ? "엄격" : v > 0.28 ? "느슨" : "보통";
$("#prep").oninput = e => $("#prepV").textContent = e.target.value + "초";
$("#sens").value = S.sens = load("mi_sens", 0.22);
$("#sensV").textContent = sensLabel(S.sens);
$("#sens").oninput = e => { S.sens = +e.target.value; $("#sensV").textContent = sensLabel(S.sens); save("mi_sens", S.sens) };
$("#realMode").onchange = e => document.body.classList.toggle("real", e.target.checked);
$$("input[name=mode]").forEach(r => r.onchange = () => { $("#prep").value = r.value === "normal" ? 30 : 3; $("#prep").oninput({ target: $("#prep") }) });
$$("#tabs button").forEach(b => b.onclick = () => showTab(b.dataset.tab));
function showTab(t) {
  $$("#tabs button").forEach(b => b.classList.toggle("on", b.dataset.tab === t));
  $$(".tab").forEach(d => d.classList.toggle("on", d.id === "t-" + t));
  if (t === "history") renderHistory();
}

// ───────────────────────── 카메라 + 얼굴 모델
$("#bCam").onclick = async () => {
  $("#bCam").disabled = true; $("#qtext").textContent = "카메라·얼굴 인식 모델 준비 중…";
  try {
    S.stream = await navigator.mediaDevices.getUserMedia({
      video: { width: 1280, height: 720, facingMode: "user" },
      audio: { echoCancellation: true, noiseSuppression: true }
    });
  } catch (e) { $("#qtext").textContent = "카메라/마이크 권한이 필요합니다"; $("#bCam").disabled = false; return }
  $("#cam").srcObject = S.stream;
  S.ac = new AudioContext();
  S.an = S.ac.createAnalyser(); S.an.fftSize = 2048; S.buf = new Float32Array(S.an.fftSize);
  S.ac.createMediaStreamSource(S.stream).connect(S.an);
  const fs = await FilesetResolver.forVisionTasks("https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm");
  S.fl = await FaceLandmarker.createFromOptions(fs, {
    baseOptions: { modelAssetPath: "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task", delegate: "GPU" },
    outputFaceBlendshapes: true, outputFacialTransformationMatrixes: true, runningMode: "VIDEO", numFaces: 1
  });
  S.phase = "idle";
  $("#bCam").textContent = "카메라 켜짐";
  ["#bStart", "#bCalib"].forEach(s => $(s).disabled = false);
  $("#qtext").textContent = S.calib ? "준비됐습니다. [연습 시작]을 누르세요" : "먼저 [시선 보정]을 한 번 해 주세요";
  if (!(window.SpeechRecognition || window.webkitSpeechRecognition))
    $("#live").innerHTML = `<span class="bad">이 브라우저는 음성 인식을 지원하지 않습니다 → Chrome으로 열어야 두괄식·속도 분석이 됩니다</span>`;
  loop();
  setInterval(envCheck, 1000);
};

function rms() {
  S.an.getFloatTimeDomainData(S.buf);
  let s = 0; for (const v of S.buf) s += v * v;
  return Math.sqrt(s / S.buf.length);
}

function readFace(res) {
  if (!res?.faceBlendshapes?.length) return { face: false };
  const b = {}; for (const c of res.faceBlendshapes[0].categories) b[c.categoryName] = c.score;
  const m = res.facialTransformationMatrixes[0].data;            // column-major 4x4
  const yaw = Math.atan2(-m[2], Math.hypot(m[6], m[10])) * 57.3;
  const pitch = Math.atan2(m[6], m[10]) * 57.3;
  const lm = res.faceLandmarks[0];
  let x0 = 1, x1 = 0, y0 = 1, y1 = 0;
  for (const p of lm) { x0 = Math.min(x0, p.x); x1 = Math.max(x1, p.x); y0 = Math.min(y0, p.y); y1 = Math.max(y1, p.y) }
  return {
    face: true, yaw, pitch,
    gx: ((b.eyeLookInLeft - b.eyeLookOutLeft) + (b.eyeLookOutRight - b.eyeLookInRight)) / 2,
    gy: ((b.eyeLookUpLeft + b.eyeLookUpRight) - (b.eyeLookDownLeft + b.eyeLookDownRight)) / 2,
    blink: (b.eyeBlinkLeft + b.eyeBlinkRight) / 2 > 0.5,
    smile: (b.mouthSmileLeft + b.mouthSmileRight) / 2,
    eyeSmile: (b.cheekSquintLeft + b.cheekSquintRight) / 2,
    box: { x0, x1, y0, y1 }, eyeY: (lm[33].y + lm[263].y) / 2,
  };
}

function gazeOn(f, prev) {
  if (!f.face) return false;
  if (f.blink) return prev ?? true;   // 깜빡일 때는 눈동자 값이 튀므로 직전 상태 유지
  const c = S.calib || { gx: 0, gy: -0.08, yaw: 0, pitch: 0 };
  const eyeDev = Math.hypot(f.gx - c.gx, (f.gy - c.gy) * 1.3);
  const headDev = Math.max(Math.abs(f.yaw - c.yaw), Math.abs(f.pitch - c.pitch));
  return eyeDev < S.sens && headDev < 14;
}

// ───────────────────────── 메인 루프 (얼굴 ~15fps)
function loop() {
  requestAnimationFrame(loop);
  const v = $("#cam");
  if (v.readyState < 2) return;
  const t = now();
  if (t - S.lastDetect < 0.066) return;
  S.lastDetect = t;
  const f = readFace(S.fl.detectForVideo(v, performance.now()));
  f.on = gazeOn(f, S.face?.on);
  f.t = t;
  S.face = f;

  // 기록
  const ph = S.phase;
  if (S.sess && S.sess.frames[ph]) S.sess.frames[ph].push({ t: t - S.sess.ts[ph], ...pick(f) });
  if (ph === "calib") S.calibBuf.push(f);
  if (S.drill) drillTick(f, t);

  // 실시간 표시
  const wrap = $("#vwrap");
  if (f.face && f.on) S.offSince = null; else S.offSince ??= t;
  const offLong = S.offSince && t - S.offSince > 0.8;
  wrap.classList.toggle("on", !!f.face && !offLong);
  wrap.classList.toggle("off", !!offLong);
  $("#mSmile").style.width = f.face ? Math.min(100, f.smile * 140) + "%" : 0;
  $("#mGaze").style.width = f.face && f.on ? "100%" : "15%";
  const g = $("#hGaze"); g.textContent = !f.face ? "얼굴 없음" : f.on ? "시선 ✓ 렌즈" : "시선 ✗ 벗어남"; g.className = "chip " + (f.on ? "good" : "warn");
  const sm = $("#hSmile"); sm.textContent = f.face ? `미소 ${Math.round(f.smile * 100)}${f.eyeSmile > 0.25 && f.smile > 0.3 ? " 😊" : ""}` : "미소 --";
  sm.className = "chip " + (f.smile > 0.3 ? "good" : f.smile > 0.12 ? "" : "warn");
  $("#mVol").style.width = Math.min(100, rms() * 900) + "%";
  $("#gSmile").style.width = $("#mSmile").style.width; $("#gGaze").style.width = $("#mGaze").style.width; $("#gVol").style.width = $("#mVol").style.width;
  drawOverlay(f);
}
const pick = f => f.face ? { face: 1, on: f.on ? 1 : 0, smile: +f.smile.toFixed(3), eyeSmile: +f.eyeSmile.toFixed(3), yaw: +f.yaw.toFixed(1), pitch: +f.pitch.toFixed(1), blink: f.blink ? 1 : 0 } : { face: 0 };

function drawOverlay(f) {
  const c = $("#overlay"), r = c.getBoundingClientRect();
  if (c.width !== r.width) { c.width = r.width; c.height = r.height }
  const x = c.getContext("2d"); x.clearRect(0, 0, c.width, c.height);
  if (document.body.classList.contains("real")) return;
  // 화면은 object-fit:cover로 잘리므로 영상 좌표 → 화면 좌표 변환
  const v = $("#cam"), vw = v.videoWidth, vh = v.videoHeight;
  const sc = Math.max(c.width / vw, c.height / vh), ox = (c.width - vw * sc) / 2, oy = (c.height - vh * sc) / 2;
  const X = nx => ox + nx * vw * sc, Y = ny => oy + ny * vh * sc;
  if ($("#guideOn")?.checked !== false) {
    x.strokeStyle = "rgba(255,255,255,.18)"; x.setLineDash([6, 6]);
    x.beginPath(); x.moveTo(c.width / 2, 0); x.lineTo(c.width / 2, c.height); x.stroke();
    // 눈높이 권장 밴드 (화면 위에서 30~42%)
    x.fillStyle = "rgba(62,207,142,.07)"; x.fillRect(0, c.height * 0.30, c.width, c.height * 0.12);
    x.setLineDash([]);
  }
  if (!f.face) return;
  const { x0, x1, y0, y1 } = f.box;
  x.strokeStyle = f.on ? "rgba(62,207,142,.6)" : "rgba(242,184,75,.8)"; x.lineWidth = 2;
  x.strokeRect(X(x0), Y(y0), X(x1) - X(x0), Y(y1) - Y(y0));
}

// ───────────────────────── 환경(조명·구도) 체크
const envCanvas = document.createElement("canvas"); envCanvas.width = 64; envCanvas.height = 48;
function envCheck() {
  const f = S.face, v = $("#cam"); if (!f || v.readyState < 2) return;
  const x = envCanvas.getContext("2d", { willReadFrequently: true }); x.drawImage(v, 0, 0, 64, 48);
  const px = x.getImageData(0, 0, 64, 48).data;
  const lum = (i) => 0.299 * px[i] + 0.587 * px[i + 1] + 0.114 * px[i + 2];
  let all = 0, faceL = 0, nf = 0;
  for (let y = 0; y < 48; y++) for (let xx = 0; xx < 64; xx++) {
    const i = (y * 64 + xx) * 4, L = lum(i); all += L;
    if (f.face && xx / 64 > f.box.x0 && xx / 64 < f.box.x1 && y / 48 > f.box.y0 && y / 48 < f.box.y1) { faceL += L; nf++ }
  }
  all /= 64 * 48; faceL = nf ? faceL / nf : 0;
  const rows = [];
  const add = (k, ok, msg) => rows.push(`<div class="m"><span class="k">${k}</span><span class="${ok}">${msg}</span></div>`);
  if (!f.face) add("얼굴", "bad", "인식 안 됨 — 정면으로 앉기");
  else {
    add("조명", faceL < 80 ? "bad" : faceL > 215 ? "warn" : "good",
      faceL < 80 ? `어두움(${faceL | 0}) — 얼굴 앞쪽에 조명` : faceL > 215 ? `너무 밝음(${faceL | 0})` : `좋음(${faceL | 0})`);
    add("역광", all - faceL > 25 ? "warn" : "good", all - faceL > 25 ? "배경이 얼굴보다 밝음 — 창문을 등지지 않기" : "없음");
    const cx = (f.box.x0 + f.box.x1) / 2, h = f.box.y1 - f.box.y0;
    add("가운데", Math.abs(cx - 0.5) < 0.07 ? "good" : "warn", Math.abs(cx - 0.5) < 0.07 ? "좋음" : "얼굴을 화면 가운데로");
    add("눈높이", f.eyeY >= 0.28 && f.eyeY <= 0.45 ? "good" : "warn",
      f.eyeY < 0.28 ? "너무 위 — 카메라를 조금 올리거나 의자를 낮추기" : f.eyeY > 0.45 ? "너무 아래 — 노트북을 받쳐 카메라를 눈높이로" : "좋음(초록 띠 안)");
    add("거리", h < 0.28 ? "warn" : h > 0.55 ? "warn" : "good", h < 0.28 ? "너무 멂 — 가슴 위까지 나오게 조금 앞으로" : h > 0.55 ? "너무 가까움" : "좋음");
    add("고개", Math.abs(f.yaw - (S.calib?.yaw ?? 0)) < 8 ? "good" : "warn", `좌우 ${fmt(f.yaw - (S.calib?.yaw ?? 0))}°`);
  }
  add("시선보정", S.calib ? "good" : "warn", S.calib ? "완료" : "아직 — [시선 보정] 누르기");
  $("#envList").innerHTML = rows.join("");
}

// ───────────────────────── 시선 보정
$("#bCalib").onclick = calibrate;
async function calibrate() {
  if (S.phase !== "idle" && S.phase !== "report") return;
  S.phase = "calib"; S.calibBuf = [];
  $("#qtext").textContent = "카메라 렌즈(화면 맨 위 ▲)를 편하게 바라보세요";
  for (let i = 3; i > 0; i--) { $("#bigcount").textContent = i; await sleep(1000) }
  $("#bigcount").textContent = "";
  const ok = S.calibBuf.filter(f => f.face && !f.blink);
  if (ok.length < 10) { $("#qtext").textContent = "얼굴이 잘 안 잡혔어요. 다시 해 주세요"; S.phase = "idle"; return }
  const med = k => { const a = ok.map(f => f[k]).sort((x, y) => x - y); return a[a.length >> 1] };
  S.calib = { gx: med("gx"), gy: med("gy"), yaw: med("yaw"), pitch: med("pitch") };
  save("mi_calib", S.calib);
  S.phase = "idle";
  $("#qtext").textContent = "보정 완료. 렌즈를 볼 때 테두리가 초록색이면 정상입니다";
}

// ───────────────────────── 질문 큐
function buildQueue() {
  const mode = $("input[name=mode]:checked").value;
  const cats = $$("#cats input:checked").map(i => i.value);
  let pool = S.qs.filter(q => cats.includes(q.cat));
  const shuffle = a => a.map(v => [Math.random(), v]).sort((x, y) => x[0] - y[0]).map(x => x[1]);
  if (mode === "surprise") pool = shuffle([...pool, ...S.qs.filter(q => q.cat === "돌발" && !cats.includes("돌발"))]);
  else if (mode === "set") {
    const intro = S.qs.find(q => q.id === "intro60") || S.qs.find(q => q.cat === "자기소개");
    const last = S.qs.find(q => q.id === "last_word") || S.qs.find(q => /마지막/.test(q.q));
    const mid = shuffle(S.qs.filter(q => q !== intro && q !== last && q.cat !== "자기소개" && cats.includes(q.cat))).slice(0, 5);
    return [intro, ...mid, last].filter(Boolean);
  } else if (!$("#order").checked) pool = shuffle(pool);
  return pool;
}

$("#bStart").onclick = () => {
  if (!["idle", "report"].includes(S.phase)) return;
  S.queue = buildQueue(); S.qi = -1;
  if (!S.queue.length) { $("#qtext").textContent = "카테고리를 하나 이상 고르세요"; return }
  $("#bNext").disabled = $("#bSkip").disabled = false;
  nextQuestion();
};
$("#bSkip").onclick = () => { if (S.phase !== "answer") nextQuestion() };
$("#bNext").onclick = () => { if (S.phase === "prep") S.skipPrep = true; else if (S.phase === "answer") S.stopAnswer = true; else if (S.phase === "question") S.skipQ = true };
document.addEventListener("keydown", e => {
  if (e.target.tagName === "INPUT" && e.target.type !== "checkbox" && e.target.type !== "radio") return;
  if (e.code === "Space") { e.preventDefault(); $("#bNext").click() }
  if (e.code === "Enter") { e.preventDefault(); $("#bStart").click() }
  if (e.key === "n" || e.key === "N" || e.key === "ㅜ") $("#bSkip").click();
});

function nextQuestion(forced) {
  S.abort = true; speechSynthesis.cancel(); if (S.qAudio) S.qAudio.pause();
  let q = forced;
  if (!q) {
    // 돌발 모드: 40% 확률로 직전 질문의 꼬리질문
    const mode = $("input[name=mode]:checked").value;
    if (mode === "surprise" && S.prevQ?.followups?.length && Math.random() < 0.4) q = followupOf(S.prevQ);
    else {
      S.qi++;
      if (S.qi >= S.queue.length) { S.phase = "idle"; $("#qtext").textContent = "세트 끝! 기록 탭에서 추이를 확인하세요"; $("#phase").textContent = ""; return }
      q = S.queue[S.qi];
    }
  }
  runSession(q);
}
const followupOf = q => ({ id: q.id + "_f", cat: "꼬리질문", q: q.followups[Math.random() * q.followups.length | 0], time: 45, keys: [], parent: q.id });

// ───────────────────────── 한 문항 진행
async function runSession(q) {
  await sleep(50); S.abort = false; S.skipQ = S.skipPrep = S.stopAnswer = false;
  showTab("setup");
  const sess = S.sess = { q, frames: { question: [], prep: [], answer: [] }, ts: {}, audio: [], segs: [], interim: "", interimT0: null, chunks: [] };
  $("#qmeta").textContent = `${q.cat}${S.queue.length ? ` · ${Math.min(S.qi + 1, S.queue.length)}/${S.queue.length}` : ""} · 답변 ${q.time}초`;
  $("#qtext").textContent = q.q;
  $("#live").textContent = ""; $("#sub").textContent = ""; $("#nudge").style.display = "none";
  $("#vq").textContent = `${qNo(q)} · ${q.q}`;

  // 1) 질문 듣기 — 경청 표정도 측정
  S.phase = "question"; sess.ts.question = now();
  $("#phase").textContent = "질문 듣는 중 — 옅은 미소, 렌즈 보기 (Space: 건너뛰기)";
  await speak(q);
  if (S.abort) return;

  // 2) 준비
  S.phase = "prep"; sess.ts.prep = now(); S.noise = [];
  const prep = +$("#prep").value;
  for (let t = prep; t > 0 && !S.skipPrep && !S.abort; t -= 0.1) {
    $("#phase").textContent = `준비 ${Math.ceil(t)}초 — 첫 문장(결론)만 정하세요 · Space로 바로 시작`;
    $("#hTime").textContent = `준비 ${Math.ceil(t)}`;
    S.noise.push(rms());
    await sleep(100);
  }
  if (S.abort) return;
  const floor = S.noise.length ? S.noise.sort((a, b) => a - b)[S.noise.length >> 1] : 0.005;
  sess.thr = Math.max(0.012, floor * 2.8);

  // 3) 답변
  await answer(sess);
  if (S.abort) return;
  S.prevQ = q.parent ? S.qs.find(x => x.id === q.parent) : q;
  report(sess);
}

function speak(q) {
  return new Promise(res => {
    const done = () => { clearInterval(iv); res() };
    const iv = setInterval(() => { if (S.skipQ || S.abort) { a?.pause(); speechSynthesis.cancel(); done() } }, 100);
    const fallback = () => {
      const u = new SpeechSynthesisUtterance(q.q); u.lang = "ko-KR"; u.rate = 1;
      u.onend = done; u.onerror = done; speechSynthesis.speak(u);
    };
    let a = null;
    if (q.cat === "꼬리질문") return fallback();
    a = S.qAudio = new Audio(`audio/q/${q.id}.mp3`);
    a.onended = done; a.onerror = fallback;
    a.play().catch(fallback);
  });
}

async function answer(sess) {
  const q = sess.q;
  S.phase = "answer"; sess.ts.answer = now();
  $("#vwrap").classList.add("rec");
  $("#phase").textContent = "답변 중 — 결론부터! (Space: 종료)";
  // 녹화
  try {
    const mr = sess.mr = new MediaRecorder(startComposite(sess), { mimeType: MediaRecorder.isTypeSupported("video/webm;codecs=vp9,opus") ? "video/webm;codecs=vp9,opus" : "video/webm" });
    mr.ondataavailable = e => e.data.size && sess.chunks.push(e.data); mr.start(1000);
  } catch { }
  startASR(sess);
  const tick = setInterval(() => sess.audio.push({ t: now() - sess.ts.answer, rms: rms() }), 100);
  let nudged = false;
  const limit = q.time, hard = limit * 1.3;
  while (!S.stopAnswer && !S.abort) {
    const t = now() - sess.ts.answer;
    if (t > hard) break;
    const left = limit - t;
    const ht = $("#hTime"); ht.textContent = left >= 0 ? `남은 ${Math.ceil(left)}초` : `초과 +${Math.floor(-left)}초`;
    ht.className = "chip " + (left < 0 ? "bad" : left < 10 ? "warn" : "");
    // 실시간 속도·두괄식 알림
    const text = sess.segs.map(s => s.text).join(" ") + " " + sess.interim;
    const v = sess.audio.find(a => a.rms > sess.thr);
    if (v) {
      const spm = sylCount(text) / Math.max(3, t - v.t) * 60;
      const hs = $("#hSpeed"); hs.textContent = `속도 ${spm | 0}/분`;
      hs.className = "chip " + (spm > 380 ? "bad" : spm > 345 ? "warn" : spm < 220 && t - v.t > 8 ? "warn" : "good");
      if ($("#nudgeOn").checked && !nudged && t - v.t > 10 && !ENDING.test(text)) {
        nudged = true; const n = $("#nudge"); n.textContent = "결론부터 한 문장!"; n.style.display = "block"; setTimeout(() => n.style.display = "none", 2500);
      }
    }
    $("#live").textContent = text.trim().slice(-140);
    $("#sub").textContent = text.trim().slice(-90);
    await sleep(100);
  }
  clearInterval(tick);
  sess.dur = now() - sess.ts.answer;
  $("#vwrap").classList.remove("rec");
  $("#phase").textContent = "분석 중…"; $("#hTime").textContent = "--"; $("#hTime").className = "chip";
  await stopASR(sess);
  if (sess.mr && sess.mr.state !== "inactive") { await new Promise(r => { sess.mr.onstop = r; sess.mr.stop() }) }
  clearInterval(sess.compIv);
  sess.base = recBase(q);
  if (sess.chunks.length) {
    sess.blob = new Blob(sess.chunks, { type: "video/webm" });
    sess.url = URL.createObjectURL(sess.blob);
    sess.fname = sess.base + ".webm";
  }
  S.phase = "report";
}
// 파일명: Q07_why_lgcns_20261020-1932 (+ .webm / _리포트.html) · 질문 번호 = questions.json 순서
function qNo(q) {
  const i = S.qs.findIndex(x => x.id === (q.parent || q.id));
  return "Q" + String(i + 1).padStart(2, "0") + (q.parent ? "꼬리" : "");
}
function recBase(q) {
  const d = new Date(), p = n => String(n).padStart(2, "0");
  return `${qNo(q)}_${q.id}_${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
}
const dl = (href, name) => { const a = document.createElement("a"); a.href = href; a.download = name; a.click() };

// 녹화용 합성 화면: 위 4/5 영상(질문 띠·시간·게이지) + 아래 1/5 자막
function startComposite(sess) {
  const W = 1280, VH = 720, H = 900, c = document.createElement("canvas"); c.width = W; c.height = H;
  const x = c.getContext("2d"), v = $("#cam"), q = sess.q, title = `${qNo(q)} · ${q.q}`;
  const FONT = "'Apple SD Gothic Neo','Pretendard',sans-serif";
  const fit = (s, w) => { if (x.measureText(s).width <= w) return s; while (s && x.measureText(s + "…").width > w) s = s.slice(0, -1); return s + "…" };
  const tail = (s, w, n) => {
    const lines = []; let cur = "";
    for (const ch of s) { if (x.measureText(cur + ch).width > w) { lines.push(cur); cur = ch } else cur += ch }
    if (cur) lines.push(cur); return lines.slice(-n);
  };
  const gauge = (gy, label, val, color) => {
    x.fillStyle = "#fff"; x.font = `500 18px ${FONT}`; x.fillText(label, 34, gy);
    x.fillStyle = "rgba(255,255,255,.2)"; x.fillRect(110, gy - 7, 200, 12);
    x.fillStyle = color; x.fillRect(110, gy - 7, 200 * Math.max(0, Math.min(1, val)), 12);
  };
  const draw = () => {
    x.fillStyle = "#000"; x.fillRect(0, 0, W, H);
    const vw = v.videoWidth || W, vh = v.videoHeight || VH, sc = Math.max(W / vw, VH / vh), dw = vw * sc, dh = vh * sc;
    // 카메라 영상만 거울처럼 뒤집기 (실시간 화면과 같게) — 질문·자막 글자는 그대로
    x.save(); x.beginPath(); x.rect(0, 0, W, VH); x.clip(); x.translate(W, 0); x.scale(-1, 1); x.drawImage(v, (W - dw) / 2, (VH - dh) / 2, dw, dh); x.restore();
    x.textBaseline = "middle"; x.textAlign = "left";
    x.fillStyle = "rgba(0,0,0,.6)"; x.fillRect(0, 0, W, 60);
    x.fillStyle = "#fff"; x.font = `600 26px ${FONT}`; x.fillText(fit(title, W - 220), 24, 30);
    const t = sess.ts.answer ? now() - sess.ts.answer : 0;
    x.textAlign = "right"; x.font = `700 22px ${FONT}`; x.fillStyle = t > q.time ? "#f2665b" : "#fff";
    x.fillText(`● ${t | 0}초 / ${q.time}초`, W - 24, 30); x.textAlign = "left";
    const f = S.face || {};
    x.fillStyle = "rgba(0,0,0,.5)"; x.fillRect(20, VH - 120, 310, 104);
    gauge(VH - 96, "미소", f.face ? f.smile * 1.4 : 0, "#ffd166");
    gauge(VH - 66, "시선", f.face && f.on ? 1 : 0.15, "#3ecf8e");
    gauge(VH - 36, "목소리", rms() * 9, "#6aa8ff");
    const text = (sess.segs.map(s => s.text).join(" ") + " " + sess.interim).trim();
    x.fillStyle = "#fff"; x.font = `500 32px ${FONT}`; x.textAlign = "center";
    const lines = tail(text, W - 100, 2), mid = VH + (H - VH) / 2;
    lines.forEach((l, i) => x.fillText(l, W / 2, mid + (i - (lines.length - 1) / 2) * 46));
    x.textAlign = "left";
  };
  draw(); sess.compIv = setInterval(draw, 33);
  const st = c.captureStream(30);
  S.stream.getAudioTracks().forEach(tr => st.addTrack(tr));
  return st;
}

// 리포트를 영상과 같은 이름의 PDF로 저장 (Q07_…_리포트.pdf)
const loadPdfLib = () => window.html2pdf ? Promise.resolve() : new Promise((res, rej) => {
  const sc = document.createElement("script"); sc.src = "https://cdnjs.cloudflare.com/ajax/libs/html2pdf.js/0.10.1/html2pdf.bundle.min.js";
  sc.onload = res; sc.onerror = rej; document.head.appendChild(sc);
});
async function saveReport(sess) {
  try { await loadPdfLib() } catch { console.warn("PDF 라이브러리를 못 불러옴 (인터넷 연결 확인)"); return }
  const node = $("#t-report").cloneNode(true);
  const tl = $("#tl"), cv = node.querySelector("#tl");
  if (tl && cv) { const im = document.createElement("img"); im.src = tl.toDataURL("image/png"); im.style.width = "100%"; cv.replaceWith(im) }
  node.querySelector("video.replay")?.closest(".card")?.remove();
  node.querySelectorAll(".row").forEach(e => e.remove());
  const box = document.createElement("div");
  box.className = "pdfbox";
  box.innerHTML = `<h1>${esc(qNo(sess.q))} · ${esc(sess.q.q)}</h1><div class="hint">${esc(new Date().toLocaleString("ko-KR"))} · 영상: ${esc(sess.fname || "없음")}</div>${node.innerHTML}`;
  const wrap = document.createElement("div"); wrap.className = "pdfwrap"; wrap.appendChild(box); document.body.appendChild(wrap);
  try {
    await html2pdf().set({ margin: [10, 10, 12, 10], filename: sess.base + "_리포트.pdf", image: { type: "jpeg", quality: 0.9 },
      html2canvas: { scale: 2, backgroundColor: "#ffffff" }, jsPDF: { unit: "mm", format: "a4" }, pagebreak: { mode: ["css", "avoid-all"] } }).from(box).save();
  } finally { wrap.remove() }
}

// ───────────────────────── 음성 인식 (Chrome)
function startASR(sess) {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition; if (!SR) return;
  const r = new SR(); r.lang = "ko-KR"; r.continuous = true; r.interimResults = true;
  const starts = {}, done = {};
  r.onresult = e => {
    const t = now() - sess.ts.answer; let interim = "";
    for (let i = e.resultIndex; i < e.results.length; i++) {
      if (done[i]) continue;
      starts[i] ??= t;
      const res = e.results[i];
      if (res.isFinal) { done[i] = 1; const tx = res[0].transcript.trim(); if (tx) sess.segs.push({ text: tx, t0: starts[i], t1: t }) }
      else { interim += res[0].transcript; sess.interimT0 ??= starts[i] }
    }
    sess.interim = interim; if (!interim) sess.interimT0 = null;
  };
  r.onerror = e => { if (e.error === "not-allowed") $("#live").textContent = "마이크 음성 인식 권한이 없습니다" };
  r.onend = () => { if (S.phase === "answer" && S.sess === sess) { try { startASR(sess) } catch { } } else sess.asrEnded?.() };
  sess.asr = r;
  try { r.start() } catch { }
}
function stopASR(sess) {
  return new Promise(res => {
    if (!sess.asr) return res();
    sess.asrEnded = res; setTimeout(res, 1500);
    try { sess.asr.stop() } catch { res() }
  }).then(() => { if (sess.interim.trim()) sess.segs.push({ text: sess.interim.trim(), t0: sess.interimT0 ?? sess.dur, t1: sess.dur }); sess.interim = "" });
}

// ───────────────────────── 분석
const ENDING = /(니다|습니다|어요|에요|예요|해요|이죠|거든요)(?=[\s.?!,]|$)/;
const FILLERS = [
  ["것 같다", /(것|거) ?같(습니다|아요|은데|고|다)/g],
  ["그런/그거", /(그런|그거를?|그게|무언가|뭔가)(?=\s)/g],
  ["약간/좀", /(^|\s)(약간|좀|조금)(?=\s)/g],
  ["이제/사실", /(^|\s)(이제|사실|그냥|일단)(?=\s)/g],
  ["음·어", /(^|\s)(음+|어+|아+|에+|그+)(?=\s|$)/g],
  ["되게/진짜", /(되게|진짜|너무)(?=\s)/g],
];
const NUM = /(\d[\d.,]*\s?(%|퍼센트|명|개|건|곳|일|시간|분|초|배|위|팀|년|개월|달|주|만|천|원)?|(한|두|세|네|다섯|여섯|일곱|여덟|아홉|열)\s?(명|개|건|곳|가지|번|배|시간|달|팀))/g;
const MARK = {
  문제: /(문제|어려|부족|불가능|걸렸|안 ?됐|안 ?되|누락|야근|제약|한계|틀리|부정확|막혔|당시)/,
  행동: /(그래서 ?저는|저는 .{0,30}(했|만들|정리|정하|확인|제안)|첫째|둘째|직접|만들었|정리했)/,
  결과: /(그 ?결과|결과적으로|덕분에|달성|줄였|올렸|출시|쓰이기|배웠|받았|마쳤)/,
};
const sylCount = t => (t.match(/[가-힣]/g) || []).length + (t.match(/\d/g) || []).length * 1.5;
const BG_START = /^(음|어|아|그+|저기|일단|사실|우선|그러니까|예전에|옛날에|처음에|당시|그때|대학|학교|어릴|제가 .{0,18}(때|당시|시절))/;

// 스크립트 첫 문장에서 핵심어 뽑기 (조사·어미 떼고 2글자 이상, 흔한 말 제외)
const STOP = new Set(["안녕하세요", "저는", "제가", "저의", "있습니다", "했습니다", "합니다", "입니다", "때문입니다", "생각합니다", "그리고", "그래서", "하는", "있는", "것입니다", "가지", "이유는"]);
function scriptKeys(script) {
  if (!script) return [];
  const first = (script.match(/^.*?(니다|어요|에요)[.?!]?/) || [script])[0];
  const out = [];
  for (let w of first.replace(/[^가-힣A-Za-z0-9\s]/g, " ").split(/\s+/)) {
    if (STOP.has(w)) continue;
    w = w.replace(/(입니다|습니다|합니다|됩니다|니다|에서|으로|에게|까지|부터|처럼|이라|라는|하고|하는|해서|했고|이고|은|는|이|가|을|를|의|에|로|와|과|도|만)$/, "");
    if (w.length >= 2 && !STOP.has(w) && !out.includes(w)) out.push(w);
  }
  return out.slice(0, 8);
}

function analyze(sess) {
  const q = sess.q, segs = sess.segs, dur = sess.dur;
  const text = segs.map(s => s.text).join(" ").replace(/\s+/g, " ").trim();
  const R = { q: q.q, id: q.id, cat: q.cat, dur, text, ts: Date.now() };

  // ── 음성
  const voiced = sess.audio.filter(a => a.rms > sess.thr);
  const firstV = voiced[0]?.t ?? segs[0]?.t0 ?? null;
  const lastV = voiced.at(-1)?.t ?? dur;
  const speakDur = Math.max(1, lastV - (firstV ?? 0));
  R.latency = firstV; R.speakDur = speakDur;
  R.spm = text ? sylCount(text) / speakDur * 60 : null;
  let longest = 0, longPauses = 0, prev = null;
  for (const a of sess.audio) if (a.rms > sess.thr) { if (prev != null) { const g = a.t - prev; longest = Math.max(longest, g); if (g > 2.5) longPauses++ } prev = a.t }
  R.longestPause = longest; R.longPauses = longPauses;
  const db = v => 20 * Math.log10(v + 1e-9);
  const vd = voiced.map(a => db(a.rms)), third = Math.max(1, vd.length / 3 | 0);
  R.volDb = avg(vd); R.fade = avg(vd.slice(0, third)) - avg(vd.slice(-third));

  // ── 필러
  R.fillers = {}; R.fillerTotal = 0;
  for (const [k, re] of FILLERS) { const n = (text.match(re) || []).length; if (n) { R.fillers[k] = n; R.fillerTotal += n } }

  // ── 두괄식
  const D = R.dugwal = { checks: [] };
  let acc = "", tc = null;
  for (const s of segs) {
    const m = s.text.match(ENDING);
    if (m) { acc += (acc ? " " : "") + s.text.slice(0, m.index + m[0].length); tc = s.t0 + (s.t1 - s.t0) * ((m.index + m[0].length) / s.text.length); break }
    acc += (acc ? " " : "") + s.text;
  }
  D.first = tc != null ? acc : (text.slice(0, 60) + (text.length > 60 ? "…" : ""));
  D.firstSyl = sylCount(D.first);
  D.tConclusion = tc != null && firstV != null ? Math.max(0, tc - firstV) : null;
  const add = (name, pts, max, msg) => D.checks.push({ name, pts, max, msg });

  // A. 결론 도달 시간
  if (D.tConclusion == null) add("첫 문장 끝맺음", 0, 30, "'~니다'로 끝나는 문장이 인식되지 않음 — 첫 문장을 짧게 끊어 끝맺기");
  else {
    const t = D.tConclusion, p = t <= 7 ? 30 : t <= 12 ? 18 : t <= 18 ? 8 : 0;
    add("결론까지 걸린 시간", p, 30, `${fmt(t, 1)}초 · ${D.firstSyl | 0}음절 ${p === 30 ? "— 좋음" : "— 첫 문장이 길다. 7초(약 35음절) 안에 '저는 ○○입니다'로 끊기"}`);
  }
  // B. 질문 호응
  const flat = D.first.replace(/\s/g, "");
  const keyHit = (q.keys || []).some(k => flat.includes(k.replace(/\s/g, "")));
  const subj = /^(저는|제|저의|네|두|세|한)/.test(D.first.trim());
  // 스크립트 첫 문장(=준비한 결론)의 핵심어가 내 첫 문장에 몇 개 나왔나
  const sk = scriptKeys(q.script);
  const skHit = sk.filter(w => flat.includes(w));
  D.scriptRatio = sk.length ? skHit.length / sk.length : null;
  const scriptOk = D.scriptRatio != null && D.scriptRatio >= 0.4;
  add("질문에 바로 답함", keyHit || scriptOk ? 15 : subj ? 9 : 0, 15,
    scriptOk ? `준비한 결론의 핵심어를 첫 문장에서 말함 (${skHit.join("·")})` : keyHit ? "질문 핵심어를 첫 문장에서 받음" : subj ? "주어로 시작은 좋음 — 질문 단어(예: '제 강점은')를 그대로 받아 시작하면 더 선명" : `첫 문장에 질문의 핵심어(${(q.keys || []).slice(0, 2).join(", ") || "질문 단어"})가 없음`);
  if (sk.length) add("준비한 결론과 일치", Math.round(10 * Math.min(1, (D.scriptRatio || 0) / 0.6)), 10,
    `스크립트 첫 문장 핵심어 ${skHit.length}/${sk.length}개${sk.length - skHit.length ? ` · 빠진 말: ${sk.filter(w => !skHit.includes(w)).slice(0, 4).join("·")}` : ""}`);
  // C. 배경부터 시작/결론 미루기
  const bg = BG_START.test(D.first.trim());
  const conn = (D.first.match(/(는데|었는데|했는데|지만|면서|어서|아서|고 나서)/g) || []).length;
  const pC = bg ? (conn >= 2 ? 0 : 6) : conn >= 2 ? 10 : 20;
  add("배경 말고 결론부터", pC, 20,
    bg ? `배경/군말로 시작('${D.first.trim().slice(0, 10)}…') — 상황 설명은 두 번째 문장으로` :
      conn >= 2 ? `첫 문장에 연결어미 ${conn}개('~는데, ~해서') — 결론이 뒤로 밀림. 끊어서 결론 먼저` : "결론으로 시작");
  // D. 개수 선언
  const decl = /(한|두|세|네|다섯|2|3) ?가지/.test(text.slice(0, 90));
  add("개수 선언", decl ? 10 : 0, 10, decl ? "'○ 가지입니다' 선언 — 매우 우수 패턴" : "가능하면 '두 가지입니다'처럼 개수 먼저 (해당 없는 질문이면 무시)");
  // E. 4문장 틀
  D.frame = { 결론: tc != null, 문제: MARK.문제.test(text), 행동: MARK.행동.test(text), 결과: MARK.결과.test(text), 숫자: (text.match(NUM) || []).length > 0 };
  const pE = (D.frame.문제 ? 4 : 0) + (D.frame.행동 ? 3 : 0) + (D.frame.결과 ? 4 : 0) + (D.frame.숫자 ? 4 : 0);
  const miss = Object.entries(D.frame).filter(([k, v]) => !v && k !== "결론").map(([k]) => k);
  add("4문장 틀", pE, 15, miss.length ? `빠진 칸: ${miss.join(", ")} ${miss.includes("숫자") || miss.includes("문제") ? "← 근거가 약해 보이는 1순위 원인" : ""}` : "문제·행동·결과·숫자 모두 있음");
  // F. 길이
  const ratio = speakDur / q.time;
  const pF = ratio >= 0.6 && ratio <= 1.1 ? 10 : ratio >= 0.4 && ratio <= 1.3 ? 5 : 0;
  add("길이", pF, 10, ratio < 0.6 ? `${speakDur | 0}초 — 너무 짧음(한 문장 답 = '매우 미흡' 패턴). 최소 ${q.time * 0.6 | 0}초` : ratio > 1.1 ? `${speakDur | 0}초 — 제한 ${q.time}초 초과` : `${speakDur | 0}초 / ${q.time}초 적절`);
  D.score = Math.round(D.checks.reduce((s, c) => s + c.pts, 0) / D.checks.reduce((s, c) => s + c.max, 0) * 100);

  // ── 표정·시선
  const A = sess.frames.answer.filter(f => f.face), Q = sess.frames.question.filter(f => f.face);
  const all = sess.frames.answer;
  R.faceRatio = all.length ? A.length / all.length : 0;
  R.gaze = A.length ? avg(A.map(f => f.on)) : null;
  let run = 0, maxOff = 0, offs = 0, lt = null;
  for (const f of all) { const dt = lt == null ? 0 : f.t - lt; lt = f.t; if (!f.face || !f.on) { run += dt; if (run > maxOff) maxOff = run } else { if (run > 1) offs++; run = 0 } }
  R.maxOff = maxOff; R.offs = offs;
  R.smile = A.length ? avg(A.map(f => f.smile > 0.3 ? 1 : 0)) : null;
  R.smileAvg = avg(A.map(f => f.smile));
  const tEnd = all.at(-1)?.t ?? dur;
  R.smileStart = Math.max(0, ...A.filter(f => f.t < 3.5).map(f => f.smile));
  R.smileEnd = Math.max(0, ...A.filter(f => f.t > tEnd - 3.5).map(f => f.smile));
  const sm = A.filter(f => f.smile > 0.3); R.eyeSmile = sm.length ? avg(sm.map(f => f.eyeSmile)) : null;
  R.listenSmile = Q.length ? avg(Q.map(f => f.smile > 0.2 ? 1 : 0)) : null;
  R.listenGaze = Q.length ? avg(Q.map(f => f.on)) : null;
  R.headStd = A.length ? Math.max(std(A.map(f => f.yaw)), std(A.map(f => f.pitch))) : null;
  let blinks = 0; for (let i = 1; i < A.length; i++) if (A[i].blink && !A[i - 1].blink) blinks++;
  R.blinkPm = A.length > 10 ? blinks / ((A.at(-1).t - A[0].t) / 60) : null;
  R.timeline = { frames: all.map(f => [f.t, f.face ? f.smile : -1, f.face ? f.on : 0]), audio: sess.audio.map(a => [a.t, a.rms > sess.thr ? 1 : 0]), dur };
  return R;
}

// ───────────────────────── 리포트
const grade = (v, good, warn) => good(v) ? "good" : warn(v) ? "warn" : "bad";
function report(sess) {
  const R = analyze(sess), D = R.dugwal, q = sess.q;
  const hist = load("mi_hist", []); const { timeline, ...slim } = R; hist.push(slim); save("mi_hist", hist.slice(-300));

  const m = (k, v, cls, tip) => `<div class="m"><span class="k">${k}</span><span><b class="${cls}">${v}</b>${tip ? ` <small>${tip}</small>` : ""}</span></div>`;
  const spmC = R.spm == null ? "warn" : grade(R.spm, v => v >= 270 && v <= 340, v => v >= 240 && v <= 375);
  const spmTip = R.spm == null ? "" : R.spm > 340 ? "빠름 — 문장 끝마다 반 박자 쉬기" : R.spm < 270 ? "느림 — 문장 사이 공백 줄이기" : "아나운서 속도";
  const latC = R.latency == null ? "warn" : grade(R.latency, v => v >= 0.6 && v <= 2.5, v => v <= 4);
  const latTip = R.latency == null ? "" : R.latency < 0.6 ? "조급 — 1초 숨 고르고 시작" : R.latency > 2.5 ? "시작이 늦음" : "1초 숨 고르기 OK";

  // 오늘 고칠 1~3가지
  const todo = [];
  if (D.checks[0].pts < 18) todo.push("첫 문장을 7초 안에 '~입니다'로 끊기 — 준비 시간엔 첫 문장 하나만 정하기");
  if (D.checks[2].pts < 20) todo.push("배경 설명은 두 번째 문장으로. 첫 마디부터 결론");
  if (!D.frame.숫자 || !D.frame.문제) todo.push(`빠진 칸 채우기: ${[!D.frame.문제 && "문제(당시 ○○ 문제가 있었습니다)", !D.frame.숫자 && "숫자 1개"].filter(Boolean).join(" · ")}`);
  if (R.fillers["것 같다"]) todo.push(`'~것 같습니다' ${R.fillers["것 같다"]}회 → 단정형으로`);
  if (R.gaze != null && R.gaze < 0.75) todo.push(`시선 ${Math.round(R.gaze * 100)}% — 화면 속 내 얼굴 대신 렌즈. 셀프뷰 숨기고 다시`);
  if (R.smileStart < 0.3 || R.smileEnd < 0.3) todo.push(`${R.smileStart < 0.3 ? "첫 문장" : ""}${R.smileStart < 0.3 && R.smileEnd < 0.3 ? "·" : ""}${R.smileEnd < 0.3 ? "마지막 문장" : ""}에서 미소`);
  if (R.spm > 345) todo.push("말이 빠름 — 문장 끝 '니다' 뒤에 반 박자");
  if (R.fade > 5) todo.push("문장 끝으로 갈수록 목소리가 작아짐 — 끝 음절까지 또렷하게");

  // 전사 하이라이트
  let html = esc(R.text);
  const fe = esc(D.first); if (fe && html.startsWith(fe)) html = `<span class="first">${fe}</span>` + html.slice(fe.length);
  for (const [, re] of FILLERS) html = html.replace(new RegExp(re.source, "g"), s => `<span class="fill">${s}</span>`);
  html = html.replace(/(\d[\d.,]*)/g, `<span class="num">$1</span>`);

  const url = sess.url || null;
  const dC = D.score >= 80 ? "good" : D.score >= 55 ? "warn" : "bad";

  $("#t-report").innerHTML = `
    <div class="hint">${esc(q.cat)} · ${esc(q.q)}</div>
    <div class="score"><b class="${dC}">${D.score}</b><span>두괄식 점수 / 100</span></div>
    <div class="card"><h4>지금 고칠 것</h4><ol class="todo">${(todo.length ? todo : ["좋습니다. 같은 질문을 한 번 더 — 이번엔 실전 모드(셀프뷰 숨김)로"]).slice(0, 3).map(t => `<li>${esc(t)}</li>`).join("")}</ol></div>
    <div class="card"><h4>두괄식 <span class="${dC}">${D.score}점</span></h4>
      <div class="m"><span class="k">첫 문장</span><span>“${esc(D.first)}”</span></div>
      ${D.checks.map(c => m(c.name, `${c.pts}/${c.max}`, c.pts >= c.max * 0.8 ? "good" : c.pts >= c.max * 0.4 ? "warn" : "bad", esc(c.msg))).join("")}
      <div class="tags">${Object.entries(D.frame).map(([k, v]) => `<span class="tag ${v ? "ok" : "no"}">${k}</span>`).join("")}</div>
    </div>
    <div class="card"><h4>전달력</h4>
      ${m("말 속도", R.spm ? `${R.spm | 0} 음절/분` : "–", spmC, spmTip)}
      ${m("첫마디까지", R.latency != null ? fmt(R.latency, 1) + "초" : "–", latC, latTip)}
      ${m("필러", R.fillerTotal + "회", R.fillerTotal <= 1 ? "good" : R.fillerTotal <= 4 ? "warn" : "bad", Object.entries(R.fillers).map(([k, v]) => `${k} ${v}`).join(" · "))}
      ${m("긴 멈춤", `${R.longPauses}회`, R.longPauses === 0 ? "good" : R.longPauses <= 2 ? "warn" : "bad", `최장 ${fmt(R.longestPause, 1)}초`)}
      ${m("끝 흐림", R.fade > 5 ? `${fmt(R.fade, 1)}dB 작아짐` : "없음", R.fade > 5 ? "warn" : "good", "")}
    </div>
    <div class="card"><h4>표정·시선</h4>
      ${m("렌즈 응시", R.gaze != null ? Math.round(R.gaze * 100) + "%" : "–", grade(R.gaze ?? 0, v => v >= 0.8, v => v >= 0.6), `벗어남 ${R.offs}회 · 최장 ${fmt(R.maxOff, 1)}초`)}
      ${m("미소 비율", R.smile != null ? Math.round(R.smile * 100) + "%" : "–", grade(R.smile ?? 0, v => v >= 0.2 && v <= 0.75, v => v >= 0.08), R.smile < 0.2 ? "굳은 편 — 문장 사이에 입꼬리" : R.smile > 0.75 ? "계속 웃음 — 진지한 대목은 차분히" : "자연스러움")}
      ${m("시작·끝 미소", `${R.smileStart >= 0.3 ? "✓" : "✗"} / ${R.smileEnd >= 0.3 ? "✓" : "✗"}`, R.smileStart >= 0.3 && R.smileEnd >= 0.3 ? "good" : "warn", "첫 3초 · 마지막 3초")}
      ${m("눈웃음", R.eyeSmile != null ? (R.eyeSmile > 0.25 ? "있음" : "입만 웃음") : "–", R.eyeSmile > 0.25 ? "good" : "warn", "")}
      ${m("경청 표정", R.listenSmile != null ? Math.round(R.listenSmile * 100) + "%" : "–", grade(R.listenSmile ?? 0, v => v >= 0.3, v => v >= 0.1), `질문 듣는 동안 미소 · 시선 ${R.listenGaze != null ? Math.round(R.listenGaze * 100) + "%" : "–"}`)}
      ${m("고개 흔들림", R.headStd != null ? fmt(R.headStd, 1) + "°" : "–", grade(R.headStd ?? 0, v => v < 4, v => v < 7), "안정감 항목")}
      ${m("깜빡임", R.blinkPm != null ? (R.blinkPm | 0) + "회/분" : "–", grade(R.blinkPm ?? 0, v => v < 30, v => v < 45), R.blinkPm > 30 ? "긴장 신호 — 답 전 한 숨" : "")}
    </div>
    <div class="card"><h4>타임라인</h4><canvas class="tl" id="tl"></canvas>
      <div class="legend"><span style="color:var(--smile)">━ 미소</span><span style="color:var(--good)">▬ 렌즈 응시</span><span style="color:var(--accent)">▬ 말하는 중</span></div></div>
    <div class="card"><h4>인식된 답변</h4><div class="transcript">${html || "<i>인식된 말이 없습니다 (Chrome·마이크 권한 확인)</i>"}</div></div>
    ${url ? `<div class="card"><h4>녹화 다시 보기 <a href="${url}" download="${sess.fname}" style="color:var(--accent);font-weight:400">다시 저장</a> <small style="color:var(--dim);font-weight:400">${esc(sess.fname)}</small></h4><video class="replay" src="${url}" controls></video></div>` : ""}
    ${q.script || q.guide ? `<div class="card"><h4>모범 스크립트 ${q.check ? '<span class="chk">📌 본인 확인 필요</span>' : ""}</h4><div class="sc" style="font-size:13px">${esc(q.script || "방향: " + q.guide)}</div>${q.tip ? `<div class="hint">💡 ${esc(q.tip)}</div>` : ""}</div>` : ""}
    <div class="row" style="flex-wrap:wrap">
      <button id="rRetry">같은 질문 다시</button>
      ${q.followups?.length ? `<button id="rFollow">꼬리질문 받기</button>` : ""}
      <button id="rNext" class="primary">다음 질문</button>
      <button id="rCopy" class="ghost">Claude 첨삭용 복사</button>
    </div>`;
  drawTimeline(R.timeline);
  if ($("#autoSave")?.checked !== false && !sess.saved) {
    sess.saved = true;
    if (sess.url) dl(sess.url, sess.fname);
    setTimeout(() => saveReport(sess), 400);
  }
  $("#rRetry").onclick = () => runSession(q);
  $("#rNext").onclick = () => nextQuestion();
  if ($("#rFollow")) $("#rFollow").onclick = () => runSession(followupOf(q));
  $("#rCopy").onclick = () => {
    const txt = `[면접 첨삭 요청 — interview-prep 기준]\n질문: ${q.q}\n제한: ${q.time}초 / 실제 ${R.speakDur | 0}초\n두괄식 ${D.score}점 · 첫 문장: ${D.first}\n속도 ${R.spm | 0}음절/분 · 필러 ${JSON.stringify(R.fillers)}\n시선 ${Math.round((R.gaze ?? 0) * 100)}% · 미소 ${Math.round((R.smile ?? 0) * 100)}%\n\n내 답변(음성 인식):\n${R.text}`;
    navigator.clipboard.writeText(txt); $("#rCopy").textContent = "복사됨 ✓";
  };
  $("#phase").textContent = `두괄식 ${D.score}점 · Enter 새 세트 · N 다음 질문`;
  showTab("report");
}

function drawTimeline(T) {
  const c = $("#tl"); if (!c) return;
  const w = c.width = c.clientWidth * 2, h = c.height = 140, x = c.getContext("2d");
  const X = t => t / Math.max(1, T.dur) * w;
  x.fillStyle = "rgba(106,168,255,.55)"; for (const [t, v] of T.audio) if (v) x.fillRect(X(t), h - 18, Math.max(2, w / T.dur / 10), 14);
  x.fillStyle = "rgba(62,207,142,.55)"; for (const [t, , on] of T.frames) if (on) x.fillRect(X(t), h - 36, Math.max(2, w / T.dur / 15), 14);
  x.strokeStyle = "#ffd166"; x.lineWidth = 3; x.beginPath();
  T.frames.forEach(([t, s], i) => { const y = s < 0 ? h - 40 : h - 44 - s * 90; i ? x.lineTo(X(t), y) : x.moveTo(X(t), y) }); x.stroke();
  x.strokeStyle = "rgba(255,255,255,.2)"; x.setLineDash([4, 4]); x.beginPath(); x.moveTo(0, h - 44 - 0.3 * 90); x.lineTo(w, h - 44 - 0.3 * 90); x.stroke();
}

// ───────────────────────── 표정·시선 드릴
$("#dSmile").onclick = () => startDrill("smile");
$("#dGaze").onclick = () => startDrill("gaze");
$("#dListen").onclick = () => startDrill("listen");
function startDrill(kind) {
  if (!S.fl) { $("#drillOut").innerHTML = `<p class="bad">먼저 카메라를 켜세요</p>`; return }
  if (S.phase !== "idle" && S.phase !== "report") return;
  const lines = S.qs.filter(q => q.script).map(q => q.script.split(/(?<=니다\.)\s/)[0]);
  S.drill = { kind, t0: now(), hold: 0, ok: 0, last: now(), on: 0, n: 0, sm: 0, li: 0, lines: lines.sort(() => Math.random() - .5) };
  if (kind === "listen") { const q = S.qs[Math.random() * S.qs.length | 0]; $("#qtext").textContent = q.q; speak(q) }
}
function drillTick(f, t) {
  const d = S.drill, dt = t - d.last; d.last = t;
  const out = $("#drillOut");
  if (d.kind === "smile") {
    const good = f.face && f.on && f.smile > 0.3;
    d.hold = good ? d.hold + dt : 0;
    if (d.hold >= 3) { d.ok++; d.hold = 0; $("#bigcount").textContent = "✓"; setTimeout(() => $("#bigcount").textContent = "", 500) }
    $("#qtext").textContent = `미소 유지 ${d.ok}/5 — ${good ? "좋아요, 그대로" : !f.on ? "렌즈를 보세요" : "입꼬리를 조금 더"}`;
    out.innerHTML = `<div class="m"><span class="k">유지</span><span class="bar"><i style="width:${d.hold / 3 * 100}%;background:var(--smile)"></i></span></div>`;
    if (d.ok >= 5) { out.innerHTML = `<p class="good">미소 5회 완료 (${fmt(t - d.t0, 0)}초)</p>`; S.drill = null; $("#qtext").textContent = "잘했어요. 이 얼굴로 첫 문장 시작!" }
  } else {
    const dur = d.kind === "gaze" ? 30 : 20, el = t - d.t0;
    d.n++; d.on += f.face && f.on ? 1 : 0; d.sm += f.face && f.smile > 0.2 ? 1 : 0;
    if (d.kind === "gaze" && el > d.li * 6) $("#qtext").textContent = d.lines[d.li++ % d.lines.length];
    out.innerHTML = `<div class="m"><span class="k">${Math.ceil(dur - el)}초</span><span>렌즈 ${Math.round(d.on / d.n * 100)}% · 미소 ${Math.round(d.sm / d.n * 100)}%</span></div>`;
    if (el >= dur) {
      const g = d.on / d.n, s = d.sm / d.n;
      out.innerHTML = `<p>${d.kind === "gaze" ? "렌즈 응시" : "경청 표정"} 결과: <b class="${g >= .8 ? "good" : "warn"}">렌즈 ${Math.round(g * 100)}%</b> · <b class="${s >= .3 ? "good" : "warn"}">미소 ${Math.round(s * 100)}%</b></p>`;
      S.drill = null; $("#qtext").textContent = g >= .8 ? "좋아요. 시선 안정적입니다" : "시선이 자주 내려갑니다 — 글을 렌즈 바로 밑에 두고 읽기";
    }
  }
}

// ───────────────────────── 스크립트 탭
function renderScripts() {
  let html = "", cur = "";
  for (const q of S.qs) {
    if (q.cat !== cur) { cur = q.cat; html += `<div class="catH">${esc(cur)}</div>` }
    html += `<div class="qitem"><div class="qq">${esc(q.q)} <small>${q.time}초</small>${q.check ? '<span class="chk">📌 확인 필요</span>' : ""}</div>
      <div class="sc">${esc(q.script || "방향: " + q.guide)}</div>${q.tip ? `<div class="tp">💡 ${esc(q.tip)}</div>` : ""}
      <div class="acts"><button data-play="${q.id}">▶ 듣기</button><button data-go="${q.id}">이 질문 연습</button></div></div>`;
  }
  $("#scriptList").innerHTML = `<p class="hint">질문·스크립트 추가와 수정, md 가져오기는 <a href="practice.html" style="color:var(--accent)">연습모드</a>에서 합니다.</p>` + html;
  $("#scriptList").onclick = e => {
    const p = e.target.dataset.play, g = e.target.dataset.go;
    if (p) {
      S.player?.pause(); speechSynthesis.cancel();
      const qq = S.qs.find(x => x.id === p), sayIt = () => { const u = new SpeechSynthesisUtterance(qq.script || qq.guide || ""); u.lang = "ko-KR"; speechSynthesis.speak(u) };
      S.player = new Audio(`audio/a/${p}.mp3`); S.player.onerror = sayIt; S.player.play().catch(sayIt);
    }
    if (g && S.fl && ["idle", "report"].includes(S.phase)) { S.queue = []; S.qi = 0; $("#bNext").disabled = $("#bSkip").disabled = false; runSession(S.qs.find(q => q.id === g)) }
  };
}
renderScripts();

// ───────────────────────── 기록 탭
function renderHistory() {
  const h = load("mi_hist", []);
  if (!h.length) { $("#histSummary").innerHTML = `<p class="hint">아직 기록이 없습니다.</p>`; $("#histList").innerHTML = ""; return }
  const last = h.slice(-10), first = h.slice(0, Math.min(10, h.length));
  const col = (a, k) => avg(a.map(r => k(r)).filter(v => v != null && !isNaN(v)));
  const rows = [
    ["두괄식", r => r.dugwal.score, v => fmt(v)],
    ["결론까지(초)", r => r.dugwal.tConclusion, v => fmt(v, 1)],
    ["속도(음절/분)", r => r.spm, v => fmt(v)],
    ["필러(회)", r => r.fillerTotal, v => fmt(v, 1)],
    ["렌즈 응시", r => r.gaze, v => fmt(v * 100) + "%"],
    ["미소", r => r.smile, v => fmt(v * 100) + "%"],
  ];
  $("#histSummary").innerHTML = `<h3>총 ${h.length}회 · 처음 10회 → 최근 10회</h3><table><tr><th></th><th>처음</th><th>최근</th></tr>${rows.map(([n, k, f]) => `<tr><td>${n}</td><td>${f(col(first, k))}</td><td><b>${f(col(last, k))}</b></td></tr>`).join("")}</table>`;
  $("#histList").innerHTML = `<h3>최근 기록</h3><table><tr><th>날짜</th><th>질문</th><th>두괄식</th><th>시선</th><th>미소</th></tr>${h.slice(-40).reverse().map(r => `<tr><td>${new Date(r.ts).toLocaleString("ko-KR", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" })}</td><td>${esc(r.q.slice(0, 22))}</td><td>${r.dugwal.score}</td><td>${r.gaze != null ? Math.round(r.gaze * 100) + "%" : "–"}</td><td>${r.smile != null ? Math.round(r.smile * 100) + "%" : "–"}</td></tr>`).join("")}</table>`;
}
$("#bExport").onclick = () => {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([JSON.stringify(load("mi_hist", []), null, 1)], { type: "application/json" }));
  a.download = `면접연습기록_${new Date().toISOString().slice(0, 10)}.json`; a.click();
};
$("#bClear").onclick = () => { if (confirm("연습 기록을 모두 지울까요?")) { save("mi_hist", []); renderHistory() } };
