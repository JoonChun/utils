import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

// 직업 프리셋 (PROTOCOL.md 참조)
const CLASS_PRESETS = {
  전사: { max_hp: 30, items: ["롱소드", "방패", "물약"] },
  마법사: { max_hp: 18, items: ["지팡이", "주문서", "물약"] },
  도적: { max_hp: 22, items: ["단검", "도둑도구", "물약"] },
  성직자: { max_hp: 24, items: ["메이스", "성수", "물약"] },
};

const DICE_RE = /^(\d*)d(\d+)([+-]\d+)?$/i;

function freshState() {
  return {
    game_id: null,
    title: "",
    status: "idle",
    players: [],
    scene: null,
    log: [],
    epilogue: null,
  };
}

export class GameEngine {
  #dataFile;
  #actionQueue = []; // 대기 중인 액션 (FIFO)
  #actionWaiters = []; // 대기 중인 waitForAction 호출자 (FIFO)
  #rollRequests = new Map(); // id -> { request, resolved, tapped, tapWaiters }
  #rollCounter = 0;

  constructor({ dataFile } = {}) {
    this.#dataFile = dataFile ?? null;
    this.state = freshState();
    this.load();
  }

  // ── 영속화 ──────────────────────────────────────────────

  save() {
    if (!this.#dataFile) return;
    try {
      fs.mkdirSync(path.dirname(this.#dataFile), { recursive: true });
      fs.writeFileSync(this.#dataFile, JSON.stringify(this.state, null, 2));
    } catch (err) {
      console.error("[engine] save failed:", err.message);
    }
  }

  load() {
    if (!this.#dataFile) return;
    try {
      if (!fs.existsSync(this.#dataFile)) return;
      const parsed = JSON.parse(fs.readFileSync(this.#dataFile, "utf8"));
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        this.state = { ...freshState(), ...parsed };
      }
    } catch (err) {
      console.error("[engine] load failed, starting fresh:", err.message);
      this.state = freshState();
    }
  }

  // ── 게임 생성/조회/종료 ─────────────────────────────────

  createGame({ title, players } = {}) {
    if (!Array.isArray(players) || players.length < 1 || players.length > 4) {
      throw new Error("players는 1~4명이어야 합니다");
    }
    const built = players.map((p, i) => {
      const preset = CLASS_PRESETS[p?.class_name];
      if (!preset) {
        throw new Error(
          `잘못된 class_name: ${p?.class_name} (전사|마법사|도적|성직자 중 하나)`
        );
      }
      if (!p.name || typeof p.name !== "string") {
        throw new Error("플레이어 name이 필요합니다");
      }
      return {
        id: `p${i + 1}`,
        name: p.name,
        class_name: p.class_name,
        hp: preset.max_hp,
        max_hp: preset.max_hp,
        xp: 0,
        items: [...preset.items],
        status_effects: [],
      };
    });
    this.state = {
      ...freshState(),
      game_id: `g_${crypto.randomBytes(4).toString("hex")}`,
      title: title || "이름 없는 모험",
      status: "playing",
      players: built,
    };
    this.save();
    return this.state;
  }

  getState() {
    return this.state;
  }

  updateScene(scene = {}) {
    const stored = {
      title: scene.title ?? "",
      narration: scene.narration ?? "",
      mood: scene.mood ?? "normal",
      choices: Array.isArray(scene.choices) ? scene.choices : [],
      allow_free_text: scene.allow_free_text ?? true,
    };
    this.state.scene = stored;
    this.state.log.push({ ts: Date.now(), text: stored.narration });
    if (this.state.log.length > 100) {
      this.state.log = this.state.log.slice(-100);
    }
    this.save();
    return stored;
  }

  endGame(epilogue) {
    this.state.status = "over";
    this.state.epilogue = epilogue ?? null;
    this.save();
    return this.state;
  }

  // ── 플레이어 상태 갱신 ──────────────────────────────────

  applyPlayerUpdates(updates = []) {
    for (const u of updates) {
      const player = this.state.players.find((p) => p.id === u.player_id);
      if (!player) {
        throw new Error(`없는 player_id: ${u.player_id}`);
      }
      if (typeof u.hp_delta === "number") {
        player.hp = Math.min(player.max_hp, Math.max(0, player.hp + u.hp_delta));
      }
      if (typeof u.xp_delta === "number") {
        player.xp += u.xp_delta;
      }
      for (const item of u.add_items ?? []) {
        player.items.push(item);
      }
      for (const item of u.remove_items ?? []) {
        const idx = player.items.indexOf(item);
        if (idx !== -1) player.items.splice(idx, 1);
      }
      for (const s of u.add_status ?? []) {
        if (!player.status_effects.includes(s)) player.status_effects.push(s);
      }
      for (const s of u.remove_status ?? []) {
        const idx = player.status_effects.indexOf(s);
        if (idx !== -1) player.status_effects.splice(idx, 1);
      }
    }
    this.save();
    return this.state.players;
  }

  // ── 주사위 ──────────────────────────────────────────────

  rollDice(notation) {
    if (typeof notation !== "string") {
      throw new Error(`잘못된 주사위 표기: ${notation}`);
    }
    const m = notation.trim().match(DICE_RE);
    if (!m) {
      throw new Error(`잘못된 주사위 표기: ${notation}`);
    }
    const count = m[1] === "" ? 1 : parseInt(m[1], 10);
    const sides = parseInt(m[2], 10);
    const modifier = m[3] ? parseInt(m[3], 10) : 0;
    if (count < 1 || count > 100 || sides < 2 || sides > 1000) {
      throw new Error(`잘못된 주사위 표기: ${notation}`);
    }
    const rolls = [];
    for (let i = 0; i < count; i++) {
      rolls.push(crypto.randomInt(1, sides + 1));
    }
    const total = rolls.reduce((a, b) => a + b, 0) + modifier;
    return { rolls, modifier, total };
  }

  createRollRequest({ player_id, dice, reason, dc } = {}) {
    this.rollDice(dice); // 표기 검증 (굴림 결과는 버림)
    const request = {
      id: `r${++this.#rollCounter}`,
      player_id,
      dice,
      reason: reason ?? "",
      dc: dc ?? null,
    };
    this.#rollRequests.set(request.id, {
      request,
      resolved: false,
      tapped: false,
      tapWaiters: [],
    });
    return request;
  }

  resolveRoll(requestId) {
    const entry = this.#rollRequests.get(requestId);
    if (!entry) {
      throw new Error(`없는 roll request id: ${requestId}`);
    }
    if (entry.resolved) {
      throw new Error(`이미 처리된 roll request: ${requestId}`);
    }
    entry.resolved = true;
    const { request } = entry;
    const { rolls, modifier, total } = this.rollDice(request.dice);
    return {
      request_id: request.id,
      player_id: request.player_id,
      dice: request.dice,
      rolls,
      modifier,
      total,
      dc: request.dc,
      success: request.dc == null ? null : total >= request.dc,
    };
  }

  waitForRollTap(requestId, timeoutMs) {
    const entry = this.#rollRequests.get(requestId);
    if (!entry || entry.resolved) {
      return Promise.resolve(false);
    }
    if (entry.tapped) {
      return Promise.resolve(true);
    }
    return new Promise((resolve) => {
      const waiter = { resolve: null, timer: null };
      waiter.timer = setTimeout(() => {
        const idx = entry.tapWaiters.indexOf(waiter);
        if (idx !== -1) entry.tapWaiters.splice(idx, 1);
        resolve(false);
      }, timeoutMs);
      waiter.timer.unref?.();
      waiter.resolve = resolve;
      entry.tapWaiters.push(waiter);
    });
  }

  notifyRollTap(requestId) {
    const entry = this.#rollRequests.get(requestId);
    if (!entry || entry.resolved || entry.tapped) return false;
    entry.tapped = true;
    for (const waiter of entry.tapWaiters.splice(0)) {
      clearTimeout(waiter.timer);
      waiter.resolve(true);
    }
    return true;
  }

  // ── 액션 큐 ─────────────────────────────────────────────

  pushAction(action) {
    const waiter = this.#actionWaiters.shift();
    if (waiter) {
      clearTimeout(waiter.timer);
      waiter.resolve(action);
    } else {
      this.#actionQueue.push(action);
    }
  }

  waitForAction(timeoutMs) {
    if (this.#actionQueue.length > 0) {
      return Promise.resolve(this.#actionQueue.shift());
    }
    return new Promise((resolve) => {
      const waiter = { resolve, timer: null };
      waiter.timer = setTimeout(() => {
        const idx = this.#actionWaiters.indexOf(waiter);
        if (idx !== -1) this.#actionWaiters.splice(idx, 1);
        resolve(null);
      }, timeoutMs);
      waiter.timer.unref?.();
      this.#actionWaiters.push(waiter);
    });
  }
}
