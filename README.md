# CustomVoice

BetterDiscord용 음성·방송 플러그인과 Windows native 캡처 도우미입니다.
이 배포본의 저장소 및 업데이트 경로는 **awizc/CustomVoice-plugin**이며 private으로 운영합니다.
기존 작성자 정보와 번들에 포함된 저작권 표시는 유지합니다.

## 설치

[Releases](https://github.com/awizc/CustomVoice-plugin/releases)에서 Windows x64 ZIP을 받습니다.
압축을 **전부** 풀고 Discord를 트레이에서 완전히 종료한 뒤 `Install.cmd`를 실행합니다.
일반 사용자는 Node.js나 .NET을 따로 설치할 필요가 없습니다.
`CustomVoice.plugin.js`와 `CustomVoice.native` 폴더가 함께 필요하며 기존 설정은 유지합니다.

## 1.1.0 변경 사항

- 자신과 같은 채널 사용자의 접속·퇴장 효과음.
- 자신의 마이크/헤드셋 음소거 토글 및 방송 시작·종료 효과음. 설정에서 끄거나 볼륨을 조절할 수 있습니다.
- 방송 유저에게 마우스를 올리거나 유저를 클릭하면 썸네일을 표시합니다.
  같은 음성 채널에서 작동하며 송출자와 시청자 모두 1.1.0이 필요합니다.
  실제 시청 구독이나 오디오 재생 없이 요청한 상대에게 작은 JPEG만 전송합니다.
- 창 공유의 소리는 선택 창의 프로세스 및 자식 프로세스만 캡처합니다.
  실패하면 화면만 공유하며 전체 시스템 소리로 대체하지 않습니다.
  같은 프로세스 트리의 여러 창/탭 소리는 함께 포함될 수 있습니다.
  전체 화면 공유에서 소리를 켜면 시스템 소리를 사용합니다.
- 시청 화면에서 마우스가 나가면 채널명/화질 UI를 숨깁니다. 키보드 조작 중에는 접근성을 유지합니다.
- 연결 해제 시 캡처 트랙, 프로세스 오디오, 시청 구독과 재생 요소를 즉시 정리합니다.
- 시작 직후 업데이트를 지연하고 파일을 제자리에서 교체해 BetterDiscord가 플러그인을 삭제된 것으로 처리하는 문제를 방지합니다.

## private 업데이트

저장소 접근 권한과 Contents 읽기 권한의 GitHub 토큰이 필요합니다.
설정의 **GitHub 업데이트 토큰**에서 등록하거나 삭제할 수 있습니다.
토큰은 소스/일반 설정에 저장하지 않고 현재 Windows 사용자용 DPAPI로 암호화해
`%APPDATA%/BetterDiscord/data/CustomVoice/github-token.bin`에 저장합니다.
자동 확인은 통화·방송 중에는 적용하지 않습니다. native 변경이 필요한 버전은 전체 ZIP 설치를 안내합니다.
다른 사용자에게 ZIP을 전달해 설치하는 것은 가능하며, 자동 업데이트에는 각자의 저장소 권한과 토큰이 필요합니다.

## 개발 및 패키지 생성

개발 PC에는 .NET 9 SDK와 Node.js가 필요합니다.

```powershell
.\package.ps1 -Dotnet dotnet -SkipCapabilityCheck
```

`native/sync-renderer.cjs`가 native 캡처 및 기능 모듈을 배포용 `CustomVoice.plugin.js`에 반영합니다.
`native/plugin-updater.js`, `native/process-audio.js`, `native/voice-extras.js`가 신규 기능의 편집 원본입니다.
생성물은 `dist/CustomVoice-<버전>-windows-x64.zip`입니다.
이번 변경에서는 배포 파일 생성에 필요한 빌드만 수행하고 테스트·실측·computer-use는 실행하지 않았습니다.
기존 테스트 코드는 참고용으로 포함되어 있습니다.

로그: `%APPDATA%/BetterDiscord/plugins/logs/CustomVoice`.
native 구성과 서드파티 고지는 `native/README.txt`, `native/THIRD-PARTY-NOTICES.txt`, `native/licenses`를 참고하세요.
프로세스 오디오 구현은 Microsoft의 [ApplicationLoopback API 예제](https://github.com/microsoft/Windows-classic-samples/tree/main/Samples/ApplicationLoopback)를 참고했습니다.
