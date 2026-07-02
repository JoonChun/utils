import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

// 주의: stdout은 MCP 전송 전용이다. 이 모듈에서는 절대 console.log를 쓰지 않는다.
// 디버그가 필요하면 console.error만 사용할 것.

const CLASS_NAMES = ["전사", "마법사", "도적", "성직자"];

/** 결과 객체를 MCP tool 응답 형태로 감싼다. */
function ok(result) {
  return { content: [{ type: "text", text: JSON.stringify(result) }] };
}

/** engine 오류를 MCP tool 오류 응답으로 감싼다. */
function fail(err) {
  const message = err instanceof Error ? err.message : String(err);
  return {
    content: [{ type: "text", text: JSON.stringify({ error: message }) }],
    isError: true,
  };
}

/**
 * MCP 서버를 생성하고 PROTOCOL.md의 tool 7개를 등록한다.
 * 반환된 McpServer는 index.js가 StdioServerTransport로 connect한다.
 *
 * @param {{ engine: import("./engine.js").GameEngine, broadcast: (msg: object) => void }} deps
 */
export function createMcpServer({ engine, broadcast }) {
  const server = new McpServer({ name: "dungeon-master", version: "0.1.0" });

  server.registerTool(
    "start_game",
    {
      title: "새 게임 시작",
      description:
        "새 TRPG 게임을 시작합니다. 플레이어 1~4명의 이름과 직업을 받아 캐릭터를 생성하고, " +
        `게임보드에 초기 상태를 표시합니다. 직업(class_name)은 ${CLASS_NAMES.join("/")} 4종만 가능하며 ` +
        "직업에 따라 HP와 기본 아이템이 자동으로 정해집니다(전사 30HP, 마법사 18HP, 도적 22HP, 성직자 24HP). " +
        "반환된 전체 상태를 보고 첫 장면을 update_scene으로 연출하세요.",
      inputSchema: {
        title: z.string().optional().describe("모험 제목 (예: '잊혀진 지하묘지')"),
        players: z
          .array(
            z.object({
              name: z.string().describe("플레이어 이름"),
              class_name: z.enum(CLASS_NAMES).describe("직업: 전사/마법사/도적/성직자"),
            })
          )
          .min(1)
          .max(4)
          .describe("플레이어 목록 (1~4명, p1부터 순서대로 id가 부여됨)"),
      },
    },
    async ({ title, players }) => {
      try {
        const state = engine.createGame({ title, players });
        broadcast({ type: "state", state });
        return ok(state);
      } catch (err) {
        return fail(err);
      }
    }
  );

  server.registerTool(
    "update_scene",
    {
      title: "장면 연출",
      description:
        "현재 장면을 교체해 게임보드에 표시합니다. 몰입감 있는 한국어 나레이션과 함께 " +
        "플레이어가 탭할 선택지(choices)를 2~4개 제시하세요. mood로 보드 분위기가 바뀝니다 " +
        "(normal=일반, combat=전투, mystery=미스터리, rest=휴식, boss=보스전). " +
        "allow_free_text를 켜두면 플레이어가 자유 행동을 입력할 수 있습니다. " +
        "장면을 올린 뒤에는 반드시 get_player_action으로 플레이어 입력을 기다리세요.",
      inputSchema: {
        title: z.string().describe("장면 제목 (예: '무너진 입구')"),
        narration: z.string().describe("장면 나레이션 (한국어, 플레이어에게 그대로 보임)"),
        mood: z
          .enum(["normal", "combat", "mystery", "rest", "boss"])
          .optional()
          .describe("장면 분위기 (기본 normal)"),
        choices: z
          .array(
            z.object({
              id: z.string().describe("선택지 id (예: 'c1')"),
              label: z.string().describe("선택지 문구"),
              hint: z.string().optional().describe("부가 힌트 (예: '힘 판정 필요')"),
            })
          )
          .optional()
          .describe("플레이어가 탭할 선택지 목록"),
        allow_free_text: z
          .boolean()
          .optional()
          .describe("자유 텍스트 입력 허용 여부 (기본 true)"),
      },
    },
    async ({ title, narration, mood, choices, allow_free_text }) => {
      try {
        const scene = engine.updateScene({
          title,
          narration,
          mood: mood ?? "normal",
          choices: choices ?? [],
          allow_free_text: allow_free_text ?? true,
        });
        broadcast({ type: "scene", scene });
        broadcast({ type: "state", state: engine.getState() });
        return ok({ ok: true, hint: "이제 get_player_action을 호출해 플레이어 입력을 기다리세요" });
      } catch (err) {
        return fail(err);
      }
    }
  );

  server.registerTool(
    "get_player_action",
    {
      title: "플레이어 입력 대기",
      description:
        "플레이어가 게임보드에서 선택지를 탭하거나 자유 텍스트를 입력할 때까지 기다립니다(long-poll). " +
        "반환은 {kind:'choice', player_id, choice_id, label} 또는 {kind:'free_text', player_id, text} 형태이며, " +
        "타임아웃 시 {timed_out:true}를 반환합니다. 타임아웃이면 다시 호출하거나 장면으로 재촉하세요.",
      inputSchema: {
        timeout_sec: z.number().optional().describe("대기 시간(초), 기본 120"),
      },
    },
    async ({ timeout_sec }) => {
      try {
        const action = await engine.waitForAction((timeout_sec ?? 120) * 1000);
        return ok(action ?? { timed_out: true });
      } catch (err) {
        return fail(err);
      }
    }
  );

  server.registerTool(
    "request_roll",
    {
      title: "주사위 판정 요청",
      description:
        "특정 플레이어에게 주사위 판정을 요청합니다. 게임보드에 주사위 버튼이 표시되고, " +
        "플레이어가 탭하면 서버가 굴려 결과를 반환합니다(최대 120초 대기, 타임아웃 시 {timed_out:true}). " +
        "dice 표기는 'd20', '2d6+3' 같은 형식입니다. dc(난이도)를 주면 성공/실패(success)를 판정하고, " +
        "없으면 success는 null입니다. reason에는 무엇을 위한 판정인지 적으세요 (예: '함정 회피 - 민첩 판정').",
      inputSchema: {
        player_id: z.string().describe("판정할 플레이어 id (예: 'p1')"),
        dice: z.string().describe("주사위 표기 (예: 'd20', '2d6+3')"),
        reason: z.string().describe("판정 사유 (플레이어에게 보임)"),
        dc: z.number().optional().describe("난이도(Difficulty Class). total >= dc면 성공"),
      },
    },
    async ({ player_id, dice, reason, dc }) => {
      try {
        const request = engine.createRollRequest({ player_id, dice, reason, dc });
        broadcast({ type: "roll_request", request });
        const tapped = await engine.waitForRollTap(request.id, 120000);
        if (!tapped) return ok({ timed_out: true });
        const result = engine.resolveRoll(request.id);
        broadcast({ type: "roll_result", result });
        return ok(result);
      } catch (err) {
        return fail(err);
      }
    }
  );

  server.registerTool(
    "update_players",
    {
      title: "플레이어 상태 갱신",
      description:
        "플레이어들의 HP/XP/아이템/상태이상을 갱신하고 게임보드에 반영합니다. " +
        "hp_delta는 음수면 피해, 양수면 회복이며 0~max_hp로 자동 클램프됩니다. " +
        "전투 피해, 보상 지급, 아이템 획득/소모, 중독 같은 상태이상 부여/해제에 사용하세요. " +
        "여러 플레이어를 한 번에 갱신할 수 있습니다.",
      inputSchema: {
        updates: z
          .array(
            z.object({
              player_id: z.string().describe("대상 플레이어 id"),
              hp_delta: z.number().optional().describe("HP 증감 (음수=피해, 양수=회복)"),
              xp_delta: z.number().optional().describe("XP 증감"),
              add_items: z.array(z.string()).optional().describe("추가할 아이템"),
              remove_items: z.array(z.string()).optional().describe("제거할 아이템"),
              add_status: z.array(z.string()).optional().describe("부여할 상태이상 (예: '중독')"),
              remove_status: z.array(z.string()).optional().describe("해제할 상태이상"),
            })
          )
          .min(1)
          .describe("플레이어별 갱신 목록"),
      },
    },
    async ({ updates }) => {
      try {
        const players = engine.applyPlayerUpdates(updates);
        broadcast({ type: "state", state: engine.getState() });
        return ok(players);
      } catch (err) {
        return fail(err);
      }
    }
  );

  server.registerTool(
    "get_state",
    {
      title: "전체 상태 조회",
      description:
        "게임 전체 상태(플레이어, 현재 장면, 로그, 게임 진행 상태)를 조회합니다. " +
        "이야기를 이어가기 전에 플레이어 HP나 아이템을 확인할 때 사용하세요.",
      inputSchema: {},
    },
    async () => {
      try {
        return ok(engine.getState());
      } catch (err) {
        return fail(err);
      }
    }
  );

  server.registerTool(
    "end_game",
    {
      title: "게임 종료",
      description:
        "모험을 마무리합니다. epilogue에 결말 나레이션(한국어)을 담아 호출하면 " +
        "게임보드에 에필로그 화면이 표시되고 게임 상태가 'over'로 바뀝니다. " +
        "파티 전멸, 목표 달성, 플레이어들의 종료 요청 시 사용하세요.",
      inputSchema: {
        epilogue: z.string().describe("결말 나레이션 (한국어)"),
      },
    },
    async ({ epilogue }) => {
      try {
        engine.endGame(epilogue);
        broadcast({ type: "game_over", epilogue });
        return ok({ ok: true });
      } catch (err) {
        return fail(err);
      }
    }
  );

  return server;
}
