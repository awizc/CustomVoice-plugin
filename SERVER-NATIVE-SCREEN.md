# 별도 NVENC 송출 서버 설정

수정 대상은 **CustomVoice 백엔드**입니다. 아래 기능을 구현한 뒤 `screenPublisher: "nvenc-v1"`을 활성화합니다.
방송 참여자는 기존 음성과 다른 `identity`를 사용해야 합니다.

## API 추가

기존 로그인 인증과 현재 채널의 방송 권한을 확인합니다. 요청 본문의 owner·room은 사용하지 않습니다.
[참조 구현](server/native-screen-service.cjs)을 다음 API에 연결하세요.

| API | 함수 | 응답 |
|---|---|---|
| `POST /api/v1/livekit/screen-publisher` | `create(context)` | 아래 발급 응답 |
| `PATCH /api/v1/livekit/screen-publisher/:session` | `renew(context, session)` | `{"leaseSeconds":90}` |
| `DELETE /api/v1/livekit/screen-publisher/:session` | `stop(context, session)` | 처리 후 `{}` |

발급 응답: `{version:1, session, identity, owner, url, token, leaseSeconds:90}`.
`session`은 UUID, `identity`는 `cv-screen:<UUID>`, `owner`는 기존 음성 identity, `url`은 같은 방의 WSS 주소입니다.
한 owner에 방송 하나만 허용하고 새 발급 시 이전 방송을 제거합니다.

## 기존 서버 기능 연결

`createNativeScreenService(...)`에 다음 함수를 주입합니다.

- `resolveVoiceSession(context)`: 인증·채널·방송 권한 확인 후 `{room, identity, url, canScreenShare}` 반환.
- `issueToken(...)`: LiveKit 서버 SDK로 방송 전용 토큰 서명. **10분 만료**, 같은 room, `roomJoin:true`, `canPublish:true`, `canSubscribe:false`, `canPublishData:false`, `canUpdateOwnMetadata:false`, `canPublishSources:["screen_share"]`. 서버 API secret은 클라이언트에 보내지 않습니다.
- `writeBindings(room, value)`: 기존 room metadata의 다른 항목을 보존하면서 아래 `customVoiceNativeScreen`만 갱신. 같은 방의 metadata 갱신은 직렬화합니다.
- `removeParticipant(room, identity)`: LiveKit 참여자 제거. 이미 없는 참여자는 성공 처리.

```json
{"customVoiceNativeScreen":{"version":1,"bindings":[{"owner":"voice-identity","publisher":"cv-screen:UUID","session":"UUID"}]}}
```

## 세션 정리

- 퇴장·채널 이동·강제퇴장·권한 회수 시 `revokeOwner(room, owner)` 호출.
- 클라이언트는 30초마다 갱신합니다. 서버는 15초 이내 주기로 `sweep()`을 호출해 90초 동안 갱신되지 않은 방송을 제거합니다.
- `participant_joined` 웹훅에서 `authorizePublisher(room, identity)`와 소유자의 현재 음성 접속을 확인합니다. 종료·만료·미등록 방송 참여자는 즉시 제거합니다. 참여자 제거만으로 이미 발급된 JWT가 취소되지는 않습니다.
- 재시작 시 남은 방송 참여자를 회수합니다. 참조 구현은 단일 프로세스용입니다. 다중 worker에서는 공유 DB/Redis와 방 단위 트랜잭션이 필요합니다.

## 활성화

음성 유지·영상/앱 소리·시청자 목록·퇴장/만료 처리·다른 사용자의 세션 접근 차단을 확인합니다.
채널 사용자 모두 1.1.22 이상일 때 기존 `POST /api/v1/livekit/token` 응답에 `screenPublisher: "nvenc-v1"`을 추가하세요.
이 표시만 추가하면 기능이 활성화되지 않습니다. 서버 미지원이나 NVENC 시작 실패 시 기존 송출을 사용합니다.
