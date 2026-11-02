# CustomVoice 시청자 집계 서버 수정

2026-11-02 현재 접속 중인 서버의 `/api/v1/livekit/token` 응답 권한을 확인한 결과:

```json
{
  "canPublishData": false,
  "canPublish": true,
  "canSubscribe": true,
  "canUpdateOwnMetadata": false
}
```

CustomVoice 1.1.8 이상은 방송 영상에 실제 구독한 시청자가 방송자에게 `customvoice.viewers.v1` 주제로 작은 LiveKit 데이터 메시지를 보냅니다. 서버가 데이터 전송을 금지하면 영상과 음성은 정상 전달되어도 시청자 알림만 사라집니다. 클라이언트의 `publishData()`가 성공해도 수신 성공을 의미하지 않습니다. [LiveKit 서버의 `onReceivedDataMessage`](https://github.com/livekit/livekit/blob/master/pkg/rtc/participant.go)는 `CanPublishData()`가 false이면 수신 데이터를 전달하지 않고 반환합니다.

1.1.11부터 방송자는 같은 주제로 시청자 목록을 실제 시청 중인 참여자에게 전달합니다. 시청자 화면에서도 인원수와 닉네임을 보려면 **방송자와 해당 사용자 모두 1.1.11 이상**이어야 합니다. 이 목록 전달을 위해 **방송자의 `canPublishData`도 true**여야 합니다. 별도 서버 API나 메타데이터 수정 권한은 필요하지 않습니다.

## 필요한 서버 변경

`POST /api/v1/livekit/token`과 입장·이동·재연결 시 사용되는 **공통 LiveKit 토큰 발급 함수**에서, 현재 채널 입장/시청 권한을 검증한 참여자의 기존 VideoGrant에 아래 값만 변경합니다.

```diff
- canPublishData: false,
+ canPublishData: true,
```

기존 인증, 현재 채널 확인, 토큰의 identity와 room 범위, canSubscribe, canPublish, canPublishSources 및 만료 시간은 유지해야 합니다. 음성 발언 권한이 없어도 방송을 볼 권한이 있는 참여자는 자신의 시청 상태를 알릴 수 있어야 합니다. `canUpdateOwnMetadata`는 필요 없으므로 그대로 유지합니다. 실제 서버 코드가 이 작업 공간에 없어 위 내용은 관리자에게 전달할 수정 지침입니다.

## 적용과 확인

1. 토큰 발급 서버 변경을 배포합니다. LiveKit 미디어 서버 설정 변경은 필요하지 않습니다.
2. 새로 발급된 토큰에서 `video.canPublishData === true`인지 확인합니다. 토큰 원문은 로그나 채팅으로 공유하지 않습니다.
3. 기존 접속자는 새 권한을 받도록 채널에서 나갔다가 다시 입장합니다. 시청자도 목록을 확인하려면 방송자·시청자 모두 1.1.11 이상을 사용합니다. 이전 1.1.8~1.1.10의 시청 알림은 계속 집계할 수 있습니다.
4. 방송을 보고 있지 않을 때 0명, 다른 사용자가 실제 방송을 볼 때 1명과 닉네임이 표시되는지 확인합니다. 닉네임 미리보기만 열면 증가하지 않아야 합니다.
5. 시청 종료·채널 퇴장 시 목록에서 제거되고, 다시 시청하면 재등록되는지 확인합니다.
6. 방송자와 시청자 화면에 같은 목록이 표시되고, 여러 방송을 동시에 시청하면 각 방송의 목록이 독립적으로 갱신되는지 확인합니다.

1.1.9 이후 플러그인은 목록을 방송 화면에만 표시합니다. 서버 권한이 차단되어 있으면 0명 대신 확인 불가를 알립니다. **플러그인 ZIP 설치 자체가 서버 권한을 수정하지는 않습니다.**
