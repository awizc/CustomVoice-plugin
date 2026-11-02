# CustomVoice 별도 NVENC 방송 연결 요청

클라이언트는 Chromium 인코더를 거치지 않는 D3D11 → NVENC → LiveKit 송출 경로를 포함합니다. 기존 음성 참여자와 **다른 identity**를 사용해야 합니다. 현재 음성 토큰을 복사해 사용하면 기존 음성 연결이 끊기므로 금지합니다.

서버 기능을 적용·검증하기 전에는 기존 방송 경로를 계속 사용합니다. 실제 서버의 인증·채널 권한 처리는 서버 관리자가 연결해야 합니다. 서버 관리자에게 자동으로 메시지를 보내거나 서버를 변경하지 않았습니다.

## API 계약

기존 인증 Bearer 토큰과 현재 음성 채널 상태를 사용합니다. 요청 본문의 owner/room 값을 신뢰하지 마세요.

1. 기존 `POST /api/v1/livekit/token` 응답에 `screenPublisher: "nvenc-v1"`를 추가합니다. 아래 기능을 모두 구현하고 송수신 시험을 통과한 서버에서만 반환합니다.
2. `POST /api/v1/livekit/screen-publisher`: 같은 사용자의 이전 방송 세션을 회수하고 `{version:1, session, identity, owner, url, token, leaseSeconds:90}`를 반환합니다. session은 UUID, identity는 `cv-screen:<UUID>`, owner는 기존 음성 참여자의 identity입니다. url은 기존 방의 WSS 주소입니다.
3. `PATCH /api/v1/livekit/screen-publisher/:session`: 소유자·현재 채널·방송 권한을 재확인하고 90초 lease를 갱신합니다. 클라이언트는 30초마다 요청합니다.
4. `DELETE /api/v1/livekit/screen-publisher/:session`: 본인 세션만 종료합니다. LiveKit RemoveParticipant와 아래 연결 정보를 함께 정리합니다. 없는 세션은 성공으로 처리합니다.
5. 음성 채널 퇴장·이동·강제퇴장·권한 회수 즉시 방송 참여자도 제거합니다. 15초 이내 주기로 만료 lease를 정리합니다. 서버 재시작 시 고아 `cv-screen:` 참여자도 회수합니다.

방송용 토큰은 10분 만료, 같은 room, `roomJoin:true`, `canPublish:true`, `canSubscribe:false`, `canPublishData:false`, `canUpdateOwnMetadata:false`, `canPublishSources:["screen_share"]`만 허용합니다. 마이크와 앱 소리는 기존 브라우저 참여자가 계속 송출합니다. API key/secret은 서버 밖으로 보내지 않습니다.

## 방송자 연결 정보

LiveKit **room metadata**의 다른 항목을 보존하면서 다음 항목을 서버에서 갱신합니다. 참여자가 직접 쓰는 participant metadata는 사용하지 않습니다.

```json
{"customVoiceNativeScreen":{"version":1,"bindings":[{"owner":"voice-identity","publisher":"cv-screen:UUID","session":"UUID"}]}}
```

한 owner에 하나의 publisher만 허용합니다. 클라이언트는 이 정보로 방송 영상은 별도 참여자에서 구독하고, 원래 방송자의 닉네임·음성·앱 소리·시청자 명단을 그대로 연결합니다. 구버전 시청자는 이 매핑을 지원하지 않으므로 채널의 모든 시청자가 1.1.22 이상인지 확인한 후 기능을 활성화해야 합니다. 구버전이 섞이면 capability를 반환하지 말고 기존 방송을 사용하세요.

## 연결할 서버 코드

`server/native-screen-service.cjs`는 프레임워크 독립 참조 구현입니다. 기존 인증 미들웨어 뒤에서 `create/renew/stop`을 위 API에 연결하고 다음 서버 함수를 주입합니다.

- `resolveVoiceSession(context)`: 인증·현재 채널·방송 권한을 확인하고 `{room,identity,url,canScreenShare}` 반환.
- `issueToken(...)`: LiveKit 서버 SDK AccessToken으로 위 grant를 서명.
- `writeBindings(room,value)`: 최신 room metadata를 읽어 `customVoiceNativeScreen`만 교체. 다른 기능의 metadata 업데이트와 충돌하지 않도록 직렬화.
- `removeParticipant(room,identity)`: LiveKit RoomServiceClient의 제거 API. 이미 없는 참여자는 성공으로 처리.

참조 구현의 메모리 상태와 방 단위 큐는 단일 서버 프로세스용입니다. 다중 worker/인스턴스에서는 Redis/DB의 공유 lease와 방 단위 트랜잭션으로 교체해야 합니다. 배포 전에는 재시작 시 잔여 방송을 회수하는 초기화 처리도 필요합니다.

## 배포 확인

기존 음성 통화 유지, 두 PC의 화면·앱 소리 동시 재생, 양쪽 시청자 명단, 방 이동/재접속/90초 lease 만료, 다른 사용자의 세션 종료 거부, NVENC 실패 시 브라우저 복귀를 확인하세요. Windows NVIDIA 드라이버가 NVENC API 12.2 이상을 지원해야 합니다. 다른 GPU 또는 NVENC 시작 실패는 기존 인코더로 자동 처리합니다.

참고: https://docs.livekit.io/transport/media/pre-encoded/ 및 https://docs.livekit.io/intro/basics/connect/

이미 발급한 JWT는 RemoveParticipant만으로 취소되지 않습니다. LiveKit participant_joined webhook에서 `authorizePublisher(room, identity)`로 유효한 lease와 소유자의 현재 음성 접속을 확인하고, 만료·종료·미등록 방송 identity는 즉시 제거해야 합니다. 재사용 토큰으로 방송이 되살아나는 경로를 배포 테스트에 포함하세요.
