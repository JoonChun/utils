# AI Dungeon Master — 시스템 계약 (PROTOCOL)

이 문서는 모든 모듈이 따라야 하는 **단일 계약**이다. 여기 정의된 이름/스키마를 임의로 바꾸지 않는다.

## 아키텍처

```
[휴대폰 브라우저: 게임보드 UI (public/)]
        ▲ WebSocket (ws://host:8765)
        │
[web-server.js: HTTP + WS 서버] ──┐
        │                          │ 같은 프로세스 (src/index.js가 기동)
[engine.js: 게임 상태/주사위/액션큐] │
        │                          │
[mcp-server.js: MCP stdio 서버] ──┘
        ▲ stdio (MCP)
        │
[Claude = 던전마스터(DM)]
```

- 단일 Node 프로세스. `src/index.js`가 engine 생성 → web-server 기동 → MCP 서버 기동(stdio).
- Claude는 MCP tool로 장면을 밀어넣고(`update_scene`), 플레이어 입력을 기다린다(`get_player_action`).
- 플레이어는 폰 브라우저에서 선택지 탭 / 자유 입력 / 주사위 탭 → WS → engine 액션 큐 → MCP 응답으로 Claude에게 전달.

## 게임 상태 스키마 (engine이 소유)

```jsonc
{
  "game_id": "g_abc123",
  "title": "잊혀진 지하묘지",
  "status": "idle" | "playing" | "over",
  "players": [
    {
      "id": "p1",                       // p1, p2, ... 순서대로
      "name": "김철수",
      "class_name": "전사",              // 전사|마법사|도적|성직자
      "hp": 30, "max_hp": 30,
      "xp": 0,
      "items": ["롱소드", "물약"],
      "status_effects": ["중독"]         // 자유 문자열 배열
    }
  ],
  "scene": {                            // 현재 장면 (없으면 null)
    "title": "무너진 입구",
    "narration": "차가운 바람이...",
    "mood": "normal" | "combat" | "mystery" | "rest" | "boss",
    "choices": [ { "id": "c1", "label": "문을 연다", "hint": "힘 판정 필요" } ],
    "allow_free_text": true
  },
  "log": [ { "ts": 1234567890, "text": "..." } ],   // narration 누적, 최근 100개 유지
  "epilogue": null                       // end_game 시 문자열
}
```

### 직업 프리셋 (start_game 시 engine이 적용)

| class_name | max_hp | 기본 items |
|---|---|---|
| 전사 | 30 | 롱소드, 방패, 물약 |
| 마법사 | 18 | 지팡이, 주문서, 물약 |
| 도적 | 22 | 단검, 도둑도구, 물약 |
| 성직자 | 24 | 메이스, 성수, 물약 |

## 액션 (플레이어 → Claude)

engine의 액션 큐에 들어가는 객체. `get_player_action`이 이걸 반환한다.

```jsonc
{ "kind": "choice",    "player_id": "p1", "choice_id": "c1", "label": "문을 연다" }
{ "kind": "free_text", "player_id": "p1", "text": "천장을 살펴본다" }
```

주사위는 큐를 거치지 않고 `request_roll` tool이 **블로킹**으로 직접 결과를 반환한다(아래 참조).

## MCP tools (mcp-server.js가 소유)

모든 tool 결과는 `content: [{type:"text", text: JSON.stringify(결과)}]` 형태.

| tool | input | 동작 / 반환 |
|---|---|---|
| `start_game` | `{title?: string, players: [{name, class_name}]}` (players 1~4명) | 새 게임 생성, 보드에 state 브로드캐스트. 반환: 전체 state |
| `update_scene` | `{title, narration, mood?, choices?: [{id,label,hint?}], allow_free_text?=true}` | 장면 교체 + log 추가 + 보드에 `scene` 브로드캐스트. 반환: `{ok:true, hint:"이제 get_player_action을 호출해 플레이어 입력을 기다리세요"}` |
| `get_player_action` | `{timeout_sec?=120}` | 액션 큐에서 하나 대기(long-poll). 반환: 액션 객체 또는 `{timed_out:true}` |
| `request_roll` | `{player_id, dice, reason, dc?}` dice 예: `"d20"`, `"2d6+3"` | 보드에 `roll_request` 브로드캐스트 → 플레이어가 탭할 때까지 최대 120초 블로킹 → 서버가 굴림 → 보드에 `roll_result` 브로드캐스트. 반환: `{request_id, player_id, dice, rolls:[..], modifier, total, dc, success}` (dc 없으면 success:null). 타임아웃 시 `{timed_out:true}` |
| `update_players` | `{updates: [{player_id, hp_delta?, xp_delta?, add_items?, remove_items?, add_status?, remove_status?}]}` | 상태 반영(hp는 0~max_hp로 클램프) + 보드에 state 브로드캐스트. 반환: 갱신된 players 배열 |
| `get_state` | `{}` | 전체 state 반환 |
| `end_game` | `{epilogue: string}` | status="over", 보드에 `game_over` 브로드캐스트. 반환: `{ok:true}` |

## WebSocket 메시지 (web-server.js가 소유)

서버 → 클라이언트:

```jsonc
{ "type": "state", "state": { ...전체 상태... } }        // 접속 시 + 상태 변경 시
{ "type": "scene", "scene": { ...scene 객체... } }
{ "type": "roll_request", "request": { "id", "player_id", "dice", "reason", "dc" } }
{ "type": "roll_result", "result": { "request_id", "player_id", "dice", "rolls", "modifier", "total", "dc", "success" } }
{ "type": "game_over", "epilogue": "..." }
```

클라이언트 → 서버:

```jsonc
{ "type": "choice", "player_id": "p1", "choice_id": "c1" }
{ "type": "free_text", "player_id": "p1", "text": "..." }
{ "type": "roll", "request_id": "r1" }                    // 주사위 버튼 탭
```

## 모듈 인터페이스

### src/engine.js — `export class GameEngine`

```js
new GameEngine({ dataFile })          // dataFile 경로에 상태 저장(JSON). 생성 시 있으면 로드.
engine.createGame({ title, players }) // → state. class_name 검증(4종 외 오류 throw)
engine.getState()                     // → state (깊은 복사 아님, 읽기용)
engine.updateScene(scene)             // scene 저장 + log에 narration push → scene 반환
engine.applyPlayerUpdates(updates)    // → 갱신된 players. 없는 player_id는 오류 throw
engine.rollDice(notation)             // "2d6+3" → {rolls:[..], modifier:3, total:n}. 잘못된 표기는 throw
engine.createRollRequest({player_id, dice, reason, dc}) // → {id:"r1", player_id, dice, reason, dc}
engine.resolveRoll(requestId)         // 굴림 실행 → roll_result 객체. 미지·중복 id는 throw
engine.pushAction(action)             // 액션 큐에 추가
engine.waitForAction(timeoutMs)       // → Promise<action | null(타임아웃)>. FIFO. 대기자 여러 명이어도 액션 1개는 1명에게만.
engine.waitForRollTap(requestId, timeoutMs) // → Promise<boolean> 플레이어 탭 대기
engine.notifyRollTap(requestId)       // WS "roll" 수신 시 web-server가 호출
engine.endGame(epilogue)              // status="over"
engine.save() / engine.load()         // 상태 영속화. 변경 메서드는 내부에서 save() 호출.
```

### src/web-server.js — `export function startWebServer({ engine, port })`

- `public/` 정적 서빙 + WS 서버(같은 포트).
- 반환: `{ broadcast(msgObj), close() }` — broadcast는 모든 WS 클라이언트에 JSON 전송.
- WS 수신 처리: `choice`/`free_text` → label 붙여 `engine.pushAction(...)`, `roll` → `engine.notifyRollTap(request_id)`.
- 클라이언트 접속 시 즉시 `{type:"state", state}` 전송. scene이 있으면 `scene`도 전송.

### src/mcp-server.js — `export function createMcpServer({ engine, broadcast })`

- `@modelcontextprotocol/sdk` 사용, 서버 이름 `dungeon-master`.
- 위 표의 tool 7개 등록. 반환: `McpServer` 인스턴스 (index.js가 StdioServerTransport로 connect).
- **주의: stdout은 MCP 전용. 디버그 출력은 console.error만 사용.**

### src/index.js (이미 작성됨 — 수정 금지)

engine 생성 → web-server 기동(PORT 환경변수, 기본 8765) → MCP connect.

## 코딩 규약

- Node 22, **ESM** (`"type":"module"`), TypeScript 없음, 빌드 스텝 없음.
- 의존성은 `@modelcontextprotocol/sdk`, `ws` 두 개만. UI는 vanilla JS/CSS (CDN 금지, 오프라인 동작).
- UI 언어는 한국어. 모바일 우선(세로 화면 기준).
- 테스트는 `node --test` (test/*.test.js).
