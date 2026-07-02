import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { GameEngine } from "../src/engine.js";

let tmpDir;
before(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "dm-engine-test-"));
});
after(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function tempFile() {
  return path.join(tmpDir, `${crypto.randomUUID()}.json`);
}

function newEngine() {
  return new GameEngine({ dataFile: tempFile() });
}

function twoPlayerGame(engine) {
  return engine.createGame({
    title: "잊혀진 지하묘지",
    players: [
      { name: "김철수", class_name: "전사" },
      { name: "이영희", class_name: "마법사" },
    ],
  });
}

describe("createGame", () => {
  test("applies class presets and assigns sequential ids", () => {
    const engine = newEngine();
    const state = engine.createGame({
      title: "테스트 모험",
      players: [
        { name: "a", class_name: "전사" },
        { name: "b", class_name: "마법사" },
        { name: "c", class_name: "도적" },
        { name: "d", class_name: "성직자" },
      ],
    });
    assert.equal(state.status, "playing");
    assert.equal(state.title, "테스트 모험");
    assert.match(state.game_id, /^g_/);
    assert.equal(state.scene, null);
    assert.deepEqual(state.log, []);
    assert.equal(state.epilogue, null);

    const expected = [
      ["p1", "전사", 30, ["롱소드", "방패", "물약"]],
      ["p2", "마법사", 18, ["지팡이", "주문서", "물약"]],
      ["p3", "도적", 22, ["단검", "도둑도구", "물약"]],
      ["p4", "성직자", 24, ["메이스", "성수", "물약"]],
    ];
    for (let i = 0; i < 4; i++) {
      const [id, cls, maxHp, items] = expected[i];
      const p = state.players[i];
      assert.equal(p.id, id);
      assert.equal(p.class_name, cls);
      assert.equal(p.hp, maxHp);
      assert.equal(p.max_hp, maxHp);
      assert.equal(p.xp, 0);
      assert.deepEqual(p.items, items);
      assert.deepEqual(p.status_effects, []);
    }
  });

  test("rejects 0 players", () => {
    assert.throws(() => newEngine().createGame({ players: [] }));
  });

  test("rejects 5 players", () => {
    const players = Array.from({ length: 5 }, (_, i) => ({
      name: `p${i}`,
      class_name: "전사",
    }));
    assert.throws(() => newEngine().createGame({ players }));
  });

  test("rejects missing players", () => {
    assert.throws(() => newEngine().createGame({}));
  });

  test("rejects unknown class_name", () => {
    assert.throws(() =>
      newEngine().createGame({ players: [{ name: "x", class_name: "음유시인" }] })
    );
  });
});

describe("rollDice", () => {
  test("d20", () => {
    const engine = newEngine();
    for (let i = 0; i < 50; i++) {
      const r = engine.rollDice("d20");
      assert.equal(r.rolls.length, 1);
      assert.ok(r.rolls[0] >= 1 && r.rolls[0] <= 20);
      assert.equal(r.modifier, 0);
      assert.equal(r.total, r.rolls[0]);
    }
  });

  test("2d6", () => {
    const r = newEngine().rollDice("2d6");
    assert.equal(r.rolls.length, 2);
    for (const roll of r.rolls) assert.ok(roll >= 1 && roll <= 6);
    assert.equal(r.modifier, 0);
    assert.equal(r.total, r.rolls[0] + r.rolls[1]);
  });

  test("2d6+3", () => {
    const r = newEngine().rollDice("2d6+3");
    assert.equal(r.rolls.length, 2);
    assert.equal(r.modifier, 3);
    assert.equal(r.total, r.rolls[0] + r.rolls[1] + 3);
  });

  test("d20-1", () => {
    const r = newEngine().rollDice("d20-1");
    assert.equal(r.rolls.length, 1);
    assert.equal(r.modifier, -1);
    assert.equal(r.total, r.rolls[0] - 1);
  });

  test("invalid notation throws", () => {
    const engine = newEngine();
    for (const bad of ["", "d", "20", "xd6", "2d", "2d6+", "d6*2", "1d6+2d4", null, undefined, 5]) {
      assert.throws(() => engine.rollDice(bad), `should throw for ${JSON.stringify(bad)}`);
    }
  });
});

describe("applyPlayerUpdates", () => {
  test("clamps hp to [0, max_hp]", () => {
    const engine = newEngine();
    twoPlayerGame(engine);
    let players = engine.applyPlayerUpdates([{ player_id: "p1", hp_delta: -999 }]);
    assert.equal(players[0].hp, 0);
    players = engine.applyPlayerUpdates([{ player_id: "p1", hp_delta: +999 }]);
    assert.equal(players[0].hp, 30);
    players = engine.applyPlayerUpdates([{ player_id: "p1", hp_delta: -7 }]);
    assert.equal(players[0].hp, 23);
  });

  test("xp, items, status effects", () => {
    const engine = newEngine();
    twoPlayerGame(engine);
    const players = engine.applyPlayerUpdates([
      {
        player_id: "p2",
        xp_delta: 50,
        add_items: ["마법 반지"],
        remove_items: ["물약"],
        add_status: ["중독"],
      },
    ]);
    const p2 = players.find((p) => p.id === "p2");
    assert.equal(p2.xp, 50);
    assert.deepEqual(p2.items, ["지팡이", "주문서", "마법 반지"]);
    assert.deepEqual(p2.status_effects, ["중독"]);

    const after2 = engine.applyPlayerUpdates([
      { player_id: "p2", xp_delta: 10, remove_status: ["중독"] },
    ]);
    const p2b = after2.find((p) => p.id === "p2");
    assert.equal(p2b.xp, 60);
    assert.deepEqual(p2b.status_effects, []);
  });

  test("unknown player_id throws", () => {
    const engine = newEngine();
    twoPlayerGame(engine);
    assert.throws(() => engine.applyPlayerUpdates([{ player_id: "p9", hp_delta: -1 }]));
  });
});

describe("updateScene", () => {
  test("fills defaults and appends log", () => {
    const engine = newEngine();
    twoPlayerGame(engine);
    const scene = engine.updateScene({ title: "무너진 입구", narration: "차가운 바람이 분다" });
    assert.equal(scene.mood, "normal");
    assert.deepEqual(scene.choices, []);
    assert.equal(scene.allow_free_text, true);
    assert.equal(engine.getState().scene.title, "무너진 입구");
    assert.equal(engine.getState().log.length, 1);
    assert.equal(engine.getState().log[0].text, "차가운 바람이 분다");
    assert.ok(typeof engine.getState().log[0].ts === "number");
  });

  test("trims log to last 100", () => {
    const engine = newEngine();
    twoPlayerGame(engine);
    for (let i = 1; i <= 120; i++) {
      engine.updateScene({ title: `t${i}`, narration: `n${i}` });
    }
    const log = engine.getState().log;
    assert.equal(log.length, 100);
    assert.equal(log[0].text, "n21");
    assert.equal(log[99].text, "n120");
  });
});

describe("action queue", () => {
  test("FIFO with pre-queued actions", async () => {
    const engine = newEngine();
    engine.pushAction({ kind: "free_text", player_id: "p1", text: "첫번째" });
    engine.pushAction({ kind: "free_text", player_id: "p2", text: "두번째" });
    const a1 = await engine.waitForAction(1000);
    const a2 = await engine.waitForAction(1000);
    assert.equal(a1.text, "첫번째");
    assert.equal(a2.text, "두번째");
  });

  test("waiter receives action pushed later", async () => {
    const engine = newEngine();
    const promise = engine.waitForAction(2000);
    setTimeout(() => {
      engine.pushAction({ kind: "choice", player_id: "p1", choice_id: "c1", label: "문을 연다" });
    }, 20);
    const action = await promise;
    assert.equal(action.choice_id, "c1");
  });

  test("times out with null", async () => {
    const engine = newEngine();
    const start = Date.now();
    const action = await engine.waitForAction(50);
    assert.equal(action, null);
    assert.ok(Date.now() - start >= 45);
  });

  test("concurrent waiters: one action goes to exactly one waiter, oldest first", async () => {
    const engine = newEngine();
    const w1 = engine.waitForAction(500);
    const w2 = engine.waitForAction(500);
    engine.pushAction({ kind: "free_text", player_id: "p1", text: "하나만" });
    const [r1, r2] = await Promise.all([w1, w2]);
    assert.equal(r1.text, "하나만"); // oldest waiter got it
    assert.equal(r2, null); // second waiter timed out
  });

  test("timed-out waiter does not steal a later action", async () => {
    const engine = newEngine();
    const timedOut = await engine.waitForAction(20);
    assert.equal(timedOut, null);
    engine.pushAction({ kind: "free_text", player_id: "p1", text: "나중" });
    const action = await engine.waitForAction(200);
    assert.equal(action.text, "나중");
  });
});

describe("roll requests", () => {
  test("createRollRequest returns sequential ids and stored fields", () => {
    const engine = newEngine();
    const r1 = engine.createRollRequest({ player_id: "p1", dice: "d20", reason: "힘 판정", dc: 12 });
    const r2 = engine.createRollRequest({ player_id: "p2", dice: "2d6+1", reason: "회피" });
    assert.equal(r1.id, "r1");
    assert.equal(r2.id, "r2");
    assert.equal(r1.player_id, "p1");
    assert.equal(r1.dice, "d20");
    assert.equal(r1.dc, 12);
    assert.equal(r2.dc, null);
  });

  test("notifyRollTap resolves waiter with true", async () => {
    const engine = newEngine();
    const req = engine.createRollRequest({ player_id: "p1", dice: "d20", reason: "r", dc: 10 });
    const promise = engine.waitForRollTap(req.id, 2000);
    setTimeout(() => engine.notifyRollTap(req.id), 20);
    assert.equal(await promise, true);
  });

  test("waitForRollTap times out with false", async () => {
    const engine = newEngine();
    const req = engine.createRollRequest({ player_id: "p1", dice: "d20", reason: "r" });
    assert.equal(await engine.waitForRollTap(req.id, 50), false);
  });

  test("tap before wait still resolves true", async () => {
    const engine = newEngine();
    const req = engine.createRollRequest({ player_id: "p1", dice: "d20", reason: "r" });
    engine.notifyRollTap(req.id);
    assert.equal(await engine.waitForRollTap(req.id, 50), true);
  });

  test("resolveRoll computes success vs dc", () => {
    const engine = newEngine();
    const alwaysPass = engine.createRollRequest({ player_id: "p1", dice: "d20", reason: "r", dc: 1 });
    assert.equal(engine.resolveRoll(alwaysPass.id).success, true);
    const alwaysFail = engine.createRollRequest({ player_id: "p1", dice: "d20", reason: "r", dc: 999 });
    assert.equal(engine.resolveRoll(alwaysFail.id).success, false);
    const noDc = engine.createRollRequest({ player_id: "p1", dice: "d20", reason: "r" });
    const result = engine.resolveRoll(noDc.id);
    assert.equal(result.success, null);
    assert.equal(result.request_id, noDc.id);
    assert.equal(result.player_id, "p1");
    assert.equal(result.dice, "d20");
    assert.equal(result.rolls.length, 1);
    assert.equal(result.total, result.rolls[0] + result.modifier);
  });

  test("resolveRoll throws on unknown and duplicate id", () => {
    const engine = newEngine();
    assert.throws(() => engine.resolveRoll("r999"));
    const req = engine.createRollRequest({ player_id: "p1", dice: "d20", reason: "r", dc: 10 });
    engine.resolveRoll(req.id);
    assert.throws(() => engine.resolveRoll(req.id));
  });

  test("createRollRequest rejects invalid dice", () => {
    assert.throws(() =>
      newEngine().createRollRequest({ player_id: "p1", dice: "banana", reason: "r" })
    );
  });
});

describe("persistence", () => {
  test("round-trip: new engine loads saved state", () => {
    const file = tempFile();
    const engine = new GameEngine({ dataFile: file });
    twoPlayerGame(engine);
    engine.updateScene({ title: "무너진 입구", narration: "차가운 바람이 분다", mood: "mystery" });
    engine.applyPlayerUpdates([{ player_id: "p1", hp_delta: -5, xp_delta: 10 }]);
    engine.endGame("모두 살아남았다");

    const reloaded = new GameEngine({ dataFile: file });
    const state = reloaded.getState();
    assert.equal(state.game_id, engine.getState().game_id);
    assert.equal(state.status, "over");
    assert.equal(state.epilogue, "모두 살아남았다");
    assert.equal(state.players[0].hp, 25);
    assert.equal(state.players[0].xp, 10);
    assert.equal(state.scene.mood, "mystery");
    assert.equal(state.log.length, 1);
    assert.deepEqual(state, engine.getState());
  });

  test("corrupt data file falls back to fresh state", () => {
    const file = tempFile();
    fs.writeFileSync(file, "{ not json !!!");
    const engine = new GameEngine({ dataFile: file });
    const state = engine.getState();
    assert.equal(state.status, "idle");
    assert.deepEqual(state.players, []);
  });

  test("missing data file starts fresh and save creates directories", () => {
    const file = path.join(tmpDir, "nested", "deep", `${crypto.randomUUID()}.json`);
    const engine = new GameEngine({ dataFile: file });
    assert.equal(engine.getState().status, "idle");
    twoPlayerGame(engine);
    assert.ok(fs.existsSync(file));
    const onDisk = JSON.parse(fs.readFileSync(file, "utf8"));
    assert.equal(onDisk.players.length, 2);
  });
});
