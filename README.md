# CustomVoice

BetterDiscord용 음성 채널·화면공유 플러그인입니다.

**현재 버전: 1.1.23 · native 1.1.16**

## 설치

Windows 11 24H2 이상(x64)과 BetterDiscord가 필요합니다.

1. [최신 릴리스](https://github.com/awizc/CustomVoice-plugin/releases/latest)의 Windows x64 ZIP을 받습니다.
2. 압축을 전부 풀고 Discord를 트레이에서도 완전히 종료합니다.
3. `Install.cmd`를 실행한 뒤 Discord를 다시 켭니다.

Node.js·.NET·OBS를 별도로 설치할 필요는 없습니다.

## 업데이트

공개 GitHub에서 자동 업데이트합니다. 별도 업데이트 토큰은 필요 없습니다.
플러그인은 통화 종료 후, native는 Discord 완전 종료 후 적용됩니다.
설정에서 실행 중·설치된 native 버전과 적용 대기 사유를 확인할 수 있습니다.
파일이 손상되면 같은 버전도 자동으로 복구합니다. 기존 설정은 유지됩니다.

## 서버 설정

- [시청자 인원·닉네임 표시](SERVER-VIEWERS.md)
- [별도 NVENC 송출 활성화](SERVER-NATIVE-SCREEN.md): 서버 기능 추가 전에는 기존 송출을 사용합니다.

## 개발

Node.js, .NET 9 SDK, Go 1.27.3 이상이 필요합니다.

```powershell
.\package.ps1 -Dotnet dotnet -Go go -SkipCapabilityCheck
```

결과물은 `dist/`에 생성됩니다. 릴리스에는 ZIP, `CustomVoice-native.json`, `CustomVoice.plugin.js`를 함께 업로드합니다.
로그: `%APPDATA%/BetterDiscord/plugins/logs/CustomVoice`.
라이선스: [서드파티 고지](native/THIRD-PARTY-NOTICES.txt).
