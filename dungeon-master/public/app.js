/* ═══════════════════════════════════════════════════════════════
   AI 던전 마스터 — 게임보드 클라이언트
   구조: 상수 → 앱 상태 → 유틸 → 렌더 함수 → WS 핸들러 → 연결 관리
   ═══════════════════════════════════════════════════════════════ */
"use strict";

// ── 상수 ─────────────────────────────────────────────────────

const CLASS_EMOJI = {
  "전사": "⚔️",
  "마법사": "🧙",
  "도적": "🗡️",
  "성직자": "✨",
};

const MOODS = {
  normal:  { emoji: "🕯️", label: "탐험" },
  combat:  { emoji: "⚔️", label: "전투" },
  mystery: { emoji: "🔮", label: "미스터리" },
  rest:    { emoji: "🏕️", label: "휴식" },
  boss:    { emoji: "🐉", label: "보스전" },
};

const LS_PREFIX = "dm_player_";       // localStorage 키: dm_player_<game_id>
const TYPE_SPEED_MS = 14;             // 타자기 효과 속도 (글자당)
const RESULT_DISMISS_MS = 2500;       // 주사위 결과 자동 닫힘
const RECONNECT_BASE_MS = 1000;
const RECONNECT_CAP_MS = 5000;

// ── 앱 상태 ──────────────────────────────────────────────────

const app = {
  ws: null,
  reconnectDelay: RECONNECT_BASE_MS,
  reconnectTimer: null,
  state: null,             // 마지막 전체 state
  myId: null,              // 선택한 플레이어 id
  sceneKey: null,          // 중복 렌더 방지용 장면 지문
  pendingAction: false,    // 행동 전송 후 다음 장면 대기 중
  typeTimer: null,         // 타자기 interval
  typeDone: null,          // 타자기 스킵/완료 콜백
  resultTimer: null,       // roll_result 자동 닫힘 타이머
};

// ── 유틸 ─────────────────────────────────────────────────────

const $ = (id) => document.getElementById(id);

function show(id) { $(id).classList.remove("hidden"); }
function hide(id) { $(id).classList.add("hidden"); }

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

function classEmoji(className) { return CLASS_EMOJI[className] || "🧝"; }

function playerById(id) {
  return app.state?.players?.find((p) => p.id === id) || null;
}

function playerName(id) {
  const p = playerById(id);
  return p ? p.name : id;
}

function lsKey() {
  return LS_PREFIX + (app.state?.game_id || "default");
}

function wsSend(obj) {
  if (app.ws && app.ws.readyState === WebSocket.OPEN) {
    app.ws.send(JSON.stringify(obj));
    return true;
  }
  return false;
}

// ── 렌더: 연결 상태 ──────────────────────────────────────────

function renderConn(on) {
  const dot = $("conn-dot");
  dot.classList.toggle("dot-on", on);
  dot.classList.toggle("dot-off", !on);
  $("conn-text").textContent = on ? "연결됨" : "연결 끊김";
}

// ── 렌더: 전체 상태 ──────────────────────────────────────────

function renderState(state) {
  const prevGameId = app.state?.game_id;
  app.state = state;

  // 새 게임(다른 game_id)이 시작되면 이전 게임의 흔적을 정리:
  // 플레이어 정체성/장면 지문/입력 잠금 초기화 + 이전 게임의 오버레이 제거.
  if (prevGameId !== undefined && state.game_id !== prevGameId) {
    app.myId = null;
    app.sceneKey = null;
    app.pendingAction = false;
    stopTypewriter();
    hide("gameover-overlay");
    hide("dice-overlay");
    hide("roll-result-overlay");
    hide("other-roll-banner");
    hide("dm-thinking");
    hide("me-label");
  }

  if (state.title) $("game-title").textContent = state.title;

  // 게임 종료 상태
  if (state.status === "over") {
    renderGameOver(state.epilogue || "모험이 끝났습니다.");
    return;
  }

  // 게임 시작 전: 대기 화면
  if (state.status === "idle" || !Array.isArray(state.players) || state.players.length === 0) {
    show("waiting-screen");
    hide("player-select");
    hide("scene-section");
    hide("no-scene");
    hide("party-section");
    hide("log-section");
    return;
  }
  hide("waiting-screen");

  // 플레이어 정체성 확인
  if (!app.myId) {
    const saved = localStorage.getItem(lsKey());
    if (saved && playerById(saved)) app.myId = saved;
  }
  if (!app.myId || !playerById(app.myId)) {
    app.myId = null;
    renderPlayerSelect(state.players);
    return; // 선택 후 renderBoard()가 이어서 그림
  }

  hide("player-select");
  renderBoard();
}

function renderBoard() {
  const state = app.state;
  renderMeLabel();
  renderParty(state.players);
  renderLog(state.log);
  show("party-section");
  show("log-section");

  if (state.scene) {
    renderScene(state.scene);
    hide("no-scene");
  } else {
    hide("scene-section");
    show("no-scene");
  }
}

function renderMeLabel() {
  const me = playerById(app.myId);
  const el = $("me-label");
  if (!me) { el.classList.add("hidden"); return; }
  el.innerHTML = `${classEmoji(me.class_name)} <b>${esc(me.name)}</b>(으)로 모험 중`;
  el.classList.remove("hidden");
}

// ── 렌더: 플레이어 선택 ──────────────────────────────────────

function renderPlayerSelect(players) {
  const list = $("player-select-list");
  list.innerHTML = "";
  players.forEach((p, i) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "player-select-btn";
    btn.style.animationDelay = (i * 0.07) + "s";
    btn.innerHTML = `
      <span class="psb-emoji">${classEmoji(p.class_name)}</span>
      <span>
        <span class="psb-name">${esc(p.name)}</span>
        <span class="psb-class">${esc(p.class_name)} · HP ${p.hp}/${p.max_hp}</span>
      </span>
      <span class="psb-arrow">▸</span>`;
    btn.addEventListener("click", () => {
      app.myId = p.id;
      localStorage.setItem(lsKey(), p.id);
      hide("player-select");
      renderBoard();
    });
    list.appendChild(btn);
  });
  hide("scene-section");
  hide("no-scene");
  hide("party-section");
  hide("log-section");
  show("player-select");
}

// ── 렌더: 파티 ───────────────────────────────────────────────

function renderParty(players) {
  const wrap = $("party");
  wrap.innerHTML = "";
  for (const p of players) {
    const ratio = p.max_hp > 0 ? p.hp / p.max_hp : 0;
    const hpClass = ratio > 0.55 ? "hp-green" : ratio > 0.25 ? "hp-amber" : "hp-red";
    const card = document.createElement("div");
    card.className = "player-card"
      + (p.id === app.myId ? " me" : "")
      + (p.hp <= 0 ? " dead" : "");

    const items = (p.items || [])
      .map((it) => `<span class="item-chip">🎒 ${esc(it)}</span>`).join("");
    const effects = (p.status_effects || [])
      .map((ef) => `<span class="status-badge">☠️ ${esc(ef)}</span>`).join("");

    card.innerHTML = `
      <div class="pc-head">
        <span class="pc-emoji">${p.hp <= 0 ? "💀" : classEmoji(p.class_name)}</span>
        <span class="pc-name-wrap">
          <span class="pc-name">${esc(p.name)}</span>
          <span class="pc-class">${esc(p.class_name)}</span>
        </span>
      </div>
      <div class="hp-row">
        <span class="hp-caption">HP</span>
        <span class="hp-nums">${p.hp} / ${p.max_hp}</span>
      </div>
      <div class="hp-bar">
        <div class="hp-fill ${hpClass}" style="width:${Math.max(0, Math.min(100, ratio * 100))}%"></div>
      </div>
      <div class="pc-xp">✨ XP ${p.xp ?? 0}</div>
      <div class="pc-items">${items}${effects}</div>`;
    wrap.appendChild(card);
  }
}

// ── 렌더: 모험 기록 ──────────────────────────────────────────

function renderLog(log) {
  const body = $("log-body");
  if (!Array.isArray(log) || log.length === 0) {
    body.innerHTML = `<div class="log-empty">아직 기록된 모험이 없습니다 🕯️</div>`;
    return;
  }
  body.innerHTML = log
    .map((e) => `<div class="log-entry">${esc(e.text)}</div>`)
    .join("");
  if (!body.classList.contains("hidden")) body.scrollTop = body.scrollHeight;
}

$("log-toggle").addEventListener("click", () => {
  const body = $("log-body");
  const open = body.classList.toggle("hidden") === false;
  $("log-toggle").classList.toggle("open", open);
  if (open) body.scrollTop = body.scrollHeight;
});

// ── 렌더: 장면 ───────────────────────────────────────────────

function renderScene(scene) {
  if (!scene) return;
  const key = JSON.stringify(scene);
  if (key === app.sceneKey) return; // 동일 장면 중복 렌더 방지
  app.sceneKey = key;

  // 새 장면 = 이전 대기/주사위 상태 정리
  app.pendingAction = false;
  hide("dm-thinking");
  hide("dice-overlay");
  hide("other-roll-banner");
  stopTypewriter();

  const section = $("scene-section");
  section.className = ""; // mood-* 초기화
  section.id = "scene-section";
  const mood = MOODS[scene.mood] || MOODS.normal;
  const moodName = MOODS[scene.mood] ? scene.mood : "normal";
  section.classList.add("mood-" + moodName);
  const banner = $("mood-banner");
  banner.className = "mood-banner mood-" + moodName;
  $("mood-emoji").textContent = mood.emoji;
  $("mood-label").textContent = mood.label;

  $("scene-title").textContent = scene.title || "";

  // 선택지/입력은 타자기 완료 후 공개
  const choicesEl = $("choices");
  choicesEl.innerHTML = "";
  hide("free-text-row");
  $("free-text-input").value = "";
  $("free-text-input").disabled = false;
  $("free-text-send").disabled = false;

  show("scene-section");
  hide("no-scene");

  typewrite(scene.narration || "", () => revealInputs(scene));
}

function revealInputs(scene) {
  const choicesEl = $("choices");
  choicesEl.innerHTML = "";
  (scene.choices || []).forEach((c, i) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "choice-btn";
    btn.style.animationDelay = (i * 0.08) + "s";
    btn.innerHTML = `<span class="choice-label">${esc(c.label)}</span>`
      + (c.hint ? `<span class="choice-hint">💡 ${esc(c.hint)}</span>` : "");
    btn.addEventListener("click", () => {
      sendPlayerAction({ type: "choice", choice_id: c.id });
    });
    choicesEl.appendChild(btn);
  });

  if (scene.allow_free_text) show("free-text-row");
}

// 타자기 효과 (탭으로 스킵)
function typewrite(text, done) {
  const el = $("narration");
  stopTypewriter();
  let i = 0;
  const caret = `<span class="caret"></span>`;
  const finish = () => {
    stopTypewriter();
    el.innerHTML = esc(text);
    done && done();
  };
  app.typeDone = finish;
  el.innerHTML = caret;
  app.typeTimer = setInterval(() => {
    i += 2; // 한 틱에 2글자 → 빠른 전개
    if (i >= text.length) { finish(); return; }
    el.innerHTML = esc(text.slice(0, i)) + caret;
  }, TYPE_SPEED_MS);
}

function stopTypewriter() {
  if (app.typeTimer) { clearInterval(app.typeTimer); app.typeTimer = null; }
  app.typeDone = null;
}

$("narration").addEventListener("click", () => {
  if (app.typeDone) app.typeDone(); // 탭 → 즉시 전체 표시
});

// ── 행동 전송 ────────────────────────────────────────────────

function sendPlayerAction(msg) {
  if (app.pendingAction || !app.myId) return;
  msg.player_id = app.myId;
  if (!wsSend(msg)) return;
  app.pendingAction = true;
  // 입력 잠금
  $("choices").querySelectorAll("button").forEach((b) => (b.disabled = true));
  $("free-text-input").disabled = true;
  $("free-text-send").disabled = true;
  show("dm-thinking");
}

$("free-text-send").addEventListener("click", sendFreeText);
$("free-text-input").addEventListener("keydown", (e) => {
  if (e.key === "Enter") sendFreeText();
});

function sendFreeText() {
  const text = $("free-text-input").value.trim();
  if (!text) return;
  sendPlayerAction({ type: "free_text", text });
}

// ── 주사위 ───────────────────────────────────────────────────

function handleRollRequest(request) {
  if (!request) return;
  if (request.player_id === app.myId) {
    $("dice-reason").textContent = "🎯 " + (request.reason || "운명의 판정!");
    const dcEl = $("dice-dc");
    if (request.dc != null) {
      dcEl.textContent = `목표치 ${request.dc}+`;
      dcEl.classList.remove("hidden");
    } else {
      dcEl.classList.add("hidden");
    }
    $("dice-notation").textContent = request.dice ? `[ ${request.dice} ]` : "";
    show("dice-button");
    hide("dice-rolling");
    show("dice-overlay");
    const btn = $("dice-button");
    btn.onclick = () => {
      wsSend({ type: "roll", request_id: request.id, player_id: app.myId });
      hide("dice-button");
      show("dice-rolling");
    };
  } else {
    const banner = $("other-roll-banner");
    banner.textContent = `⏳ ${playerName(request.player_id)}의 주사위 대기 중…`;
    banner.classList.remove("hidden");
  }
}

function handleRollResult(result) {
  if (!result) return;
  hide("dice-overlay");
  hide("other-roll-banner");

  $("result-player").textContent =
    `🎲 ${playerName(result.player_id)}의 판정 (${result.dice || ""})`;

  const rolls = Array.isArray(result.rolls) ? result.rolls : [];
  let html = rolls.map((r) => `<span class="die">${esc(r)}</span>`).join(`<span> + </span>`);
  const mod = result.modifier || 0;
  if (mod !== 0) html += `<span class="mod">${mod > 0 ? "+" : "−"} ${Math.abs(mod)}</span>`;
  $("result-breakdown").innerHTML = html;

  $("result-total").innerHTML = `${esc(result.total)}<small>TOTAL</small>`;

  const verdict = $("result-verdict");
  if (result.dc != null && result.success != null) {
    verdict.textContent = result.success ? "성공 ✅" : "실패 ❌";
    verdict.className = "result-verdict " + (result.success ? "verdict-success" : "verdict-fail");
    verdict.classList.remove("hidden");
  } else {
    verdict.classList.add("hidden");
  }

  // 팝 애니메이션 재시작
  const inner = document.querySelector("#roll-result-overlay .result-inner");
  inner.style.animation = "none";
  void inner.offsetWidth;
  inner.style.animation = "";

  show("roll-result-overlay");
  if (app.resultTimer) clearTimeout(app.resultTimer);
  app.resultTimer = setTimeout(() => hide("roll-result-overlay"), RESULT_DISMISS_MS);
}

$("roll-result-overlay").addEventListener("click", () => {
  if (app.resultTimer) clearTimeout(app.resultTimer);
  hide("roll-result-overlay");
});

// ── 게임 종료 ────────────────────────────────────────────────

function renderGameOver(epilogue) {
  stopTypewriter();
  hide("waiting-screen");
  hide("player-select");
  hide("dice-overlay");
  hide("roll-result-overlay");
  $("epilogue").textContent = epilogue || "";
  show("gameover-overlay");
}

$("restart-btn").addEventListener("click", () => {
  // 이 게임(및 과거 게임)의 플레이어 선택 기록 제거 후 새로고침
  for (let i = localStorage.length - 1; i >= 0; i--) {
    const k = localStorage.key(i);
    if (k && k.startsWith(LS_PREFIX)) localStorage.removeItem(k);
  }
  location.reload();
});

// ── WS 메시지 디스패치 ───────────────────────────────────────

function handleMessage(msg) {
  switch (msg.type) {
    case "state":
      if (msg.state) renderState(msg.state);
      break;
    case "scene":
      if (msg.scene && app.state) {
        app.state.scene = msg.scene;
        if (app.myId) { renderScene(msg.scene); hide("no-scene"); }
      }
      break;
    case "roll_request":
      handleRollRequest(msg.request);
      break;
    case "roll_result":
      handleRollResult(msg.result);
      break;
    case "game_over":
      renderGameOver(msg.epilogue);
      break;
    default:
      // 알 수 없는 메시지는 무시
      break;
  }
}

// ── 연결 관리 (자동 재접속: 1s → 2s → 4s, 최대 5s) ──────────

function connect() {
  if (app.reconnectTimer) { clearTimeout(app.reconnectTimer); app.reconnectTimer = null; }
  const proto = location.protocol === "https:" ? "wss" : "ws";
  let ws;
  try {
    ws = new WebSocket(`${proto}://${location.host}`);
  } catch {
    scheduleReconnect();
    return;
  }
  app.ws = ws;

  ws.addEventListener("open", () => {
    app.reconnectDelay = RECONNECT_BASE_MS;
    renderConn(true);
  });

  ws.addEventListener("message", (ev) => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }
    handleMessage(msg);
  });

  ws.addEventListener("close", () => {
    renderConn(false);
    scheduleReconnect();
  });

  ws.addEventListener("error", () => {
    try { ws.close(); } catch { /* noop */ }
  });
}

function scheduleReconnect() {
  if (app.reconnectTimer) return;
  const delay = app.reconnectDelay;
  app.reconnectDelay = Math.min(app.reconnectDelay * 2, RECONNECT_CAP_MS);
  app.reconnectTimer = setTimeout(() => {
    app.reconnectTimer = null;
    connect();
  }, delay);
}

connect();
