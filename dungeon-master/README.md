# 🎲 AI Dungeon Master

Claude가 **던전마스터(DM)**, 당신의 휴대폰이 **게임보드**가 되는 TRPG 보드게임입니다.

- Claude는 MCP를 통해 장면을 연출하고, 주사위 판정을 요구하고, 파티 상태를 관리합니다.
- 플레이어는 폰 브라우저에서 선택지를 탭하거나, 자유롭게 행동을 입력하거나, 주사위를 굴립니다.
- 매 판 스토리가 다른 무한 TRPG — 1~4인 파티 플레이 지원.

```
[휴대폰 브라우저: 게임보드 UI]
        ▲ WebSocket
        │
[Node 서버: HTTP/WS + 게임 엔진 + MCP(stdio)]
        ▲ MCP
        │
[Claude = 던전마스터]
```

## 설치

```bash
cd dungeon-master
npm install
```

요구사항: Node.js 18+ (권장 22)

## Claude Desktop / Claude Code 연동

Claude Desktop의 `claude_desktop_config.json`(또는 Claude Code의 `.mcp.json`)에 추가:

```json
{
  "mcpServers": {
    "dungeon-master": {
      "command": "node",
      "args": ["/절대/경로/dungeon-master/src/index.js"]
    }
  }
}
```

Claude가 MCP 서버를 기동하면 게임보드가 `http://localhost:8765` 에 열립니다.
휴대폰에서 접속하려면 같은 Wi-Fi에서 `http://<PC의 IP>:8765` 로 들어가세요.

환경변수: `PORT`(기본 8765), `DM_DATA_FILE`(상태 저장 파일, 기본 `data/game.json`)

## 플레이 방법

1. 플레이어들이 폰으로 게임보드에 접속합니다.
2. Claude에게 이렇게 말하세요:

> 던전마스터가 되어 게임을 진행해줘. 플레이어는 철수(전사), 영희(마법사)야.
> start_game으로 시작하고, 매 장면마다 update_scene → get_player_action 순서로
> 플레이어 입력을 기다리면서 이야기를 진행해. 위험한 행동엔 request_roll로
> d20 판정을 시키고, 결과에 따라 update_players로 HP/아이템/XP를 갱신해.
> 파티가 전멸하거나 모험이 끝나면 end_game으로 에필로그를 보여줘.

3. 폰에서 자기 캐릭터를 선택하고, 선택지를 탭하거나 직접 행동을 입력하며 플레이합니다.

### 던전마스터(Claude)용 권장 시스템 프롬프트

```
너는 노련한 TRPG 던전마스터다. 규칙:
- 장면은 update_scene으로 연출한다. narration은 4~8문장, 생생하고 감각적으로.
  선택지는 2~4개, 각각 다른 성향(용감/신중/기발)으로. allow_free_text는 항상 true.
- update_scene 후에는 반드시 get_player_action으로 플레이어 입력을 기다린다.
- 결과가 불확실한 행동은 request_roll(d20, dc 8~18)로 판정한다. 대성공(20)과
  대실패(1)는 극적으로 연출한다.
- 전투/함정 피해, 아이템 획득, 경험치는 즉시 update_players로 반영한다.
- 플레이어의 자유 입력(free_text)은 최대한 존중하되, 무리한 요구는 세계관 안에서
  재치있게 받아친다.
- 3~5개 장면마다 긴장과 이완을 교차시키고, 15~20 장면 안에 클라이맥스와 결말로
  이끈 뒤 end_game으로 에필로그를 남긴다.
```

## MCP Tools

| tool | 용도 |
|---|---|
| `start_game` | 새 게임 생성 (플레이어 1~4명, 직업: 전사/마법사/도적/성직자) |
| `update_scene` | 장면 연출 (제목, 나레이션, 분위기, 선택지) |
| `get_player_action` | 플레이어 입력 대기 (선택지 탭 / 자유 입력) |
| `request_roll` | 주사위 판정 요구 (예: d20, dc 12) — 플레이어가 폰에서 굴림 |
| `update_players` | HP/XP/아이템/상태이상 갱신 |
| `get_state` | 전체 게임 상태 조회 |
| `end_game` | 게임 종료 + 에필로그 |

상세 스키마: [docs/PROTOCOL.md](docs/PROTOCOL.md)

## 개발

```bash
npm test        # 엔진 단위 테스트 (node --test)
npm start       # 서버 단독 기동 (MCP는 stdio 대기)
```
