CustomVoice native GPU capture (Windows x64)

플러그인 1.1.18 UI 정리 (native 1.1.13 유지)
- 설정 화면을 기능별로 구분하고 글꼴, 줄높이, 버튼과 입력창 간격을 Discord 기준으로 정리했습니다.
- 창 이름 검색, 앱/시스템 소리 구분, 접근 가능한 닫기 버튼과 좁은 창 레이아웃을 추가했습니다.
- 기존 설정은 보존하며 1.1.17의 토큰 없는 GitHub 자동 업데이트를 포함합니다.

native 1.1.13 / 플러그인 1.1.17 공개 GitHub 자동 업데이트
- 업데이트 토큰 UI·저장·전달·인증 처리를 제거합니다. 기존 CustomVoice 전용 토큰 파일은 삭제합니다.
- 공개 raw 파일과 정식 릴리스 다운로드 주소를 사용하며 GitHub API에 의존하지 않습니다.
- 플러그인은 5분마다 확인하고 통화 중에도 내려받습니다. 통화가 끝나면 적용합니다.
- native는 15분마다 확인하고 자동 다운로드합니다. Discord 완전 종료 후 적용하며 오래된 플러그인도 함께 갱신합니다.
- 더 최신인 플러그인과 설정은 보존합니다. Discord를 트레이에서 완전히 종료한 뒤 5초 정도 기다렸다 다시 실행하세요.
- 아래는 이전 버전 변경 기록이며 현재 업데이트 방식은 위 설명을 따릅니다.

native 1.1.12 / 플러그인 1.1.16 게임 렌더링 캡처
- 선택한 앱이 활성 전체화면이면 게임 후크를 연결합니다. 이후 알탭해도 같은 게임의 GPU/메모리 프레임을 받습니다.
- 방송 시작 후 게임을 한 번 활성화해 주세요. 방송 정보의 게임 캡처 · GPU / 호환 모드로 연결 여부를 확인할 수 있습니다.
- OBS 공식 게임 캡처 구성요소를 동봉하며 OBS 앱 설치·실행은 필요 없습니다. 32/64비트, OpenGL 반전, 버퍼 교체를 처리합니다.
- 다른 캡처 프로그램의 소유권을 존중합니다. 후크 연결 실패·차단 또는 게임 자체의 렌더링 중지는 계속 움직이는 영상을 보장하지 않습니다.
- game-hook 폴더에 라이선스와 OBS의 완전한 대응 소스를 동봉합니다. DLL은 방송 종료 후에도 게임 종료까지 로드될 수 있습니다.
- 합성 프레임/프로토콜/설치 검증을 수행했습니다. 실제 osu! 후크 연결과 두 PC 송수신은 확인하지 않았습니다.

native 1.1.11 / 플러그인 1.1.15 알탭 화면 유지 및 수신 복구
- 새 게임 프레임을 받을 수 없을 때 마지막 정상 송출 프레임을 GPU에 보관해 유지합니다.
- 게임 복귀 시 새 프레임으로 교체하며 대기 중 화질 변경도 지원합니다.
- 시청자 플러그인에 디코딩·화면 표시 정지 감지와 영상 재연결을 추가했습니다.
- 송출자와 시청자 모두 업데이트해 주세요. 실제 게임·두 PC 송수신은 미확인입니다.

native 1.1.10 / 플러그인 1.1.14 게임 복귀 후 송출 FPS 복구
- 최소화된 창의 160×28 크기로 초기 인코더가 설정되는 경로를 수정했습니다.
- 소스 대기를 인코더 과부하와 구분하고 게임 화면이 돌아오면 목표 FPS로 처리 속도를 복구합니다.
- 화면을 받을 수 없는 동안 자체 검은 GPU 프레임을 보내며 게임 화면 대기 중으로 안내합니다.
- 합성 GPU 프레임으로 픽셀 교체와 반복 복구를 검증했습니다. 실제 osu! 송출은 미확인입니다.
- 전체 ZIP 설치 후 Discord를 완전히 재시작해 주세요.

native 1.1.9 / 플러그인 1.1.13 공유할 게임 창 목록 보완
- Discord 목록에서 빠진 최상위 앱 창을 Windows 창 목록으로 보완합니다. 최소화된 게임도 선택할 수 있습니다.
- 선택창의 목록 새로고침으로 실행하거나 상태가 바뀐 게임을 다시 조회할 수 있습니다.
- 최소화된 창은 공유를 시작한 뒤 게임으로 돌아가면 캡처를 이어갑니다.
- 실제 창 열거나 앱 조작 없이 모형 테스트를 사용했습니다. 전체 ZIP 설치 후 Discord를 완전히 재시작해 주세요.

native 1.1.8 / 플러그인 1.1.12 게임 창 공유 시작 오류 수정
- 제목 표시줄 제외 영역의 오른쪽·아래쪽 좌표를 너비·높이로 전달하던 오류를 수정했습니다.
- 원본 프레임 경계를 넘는 영역을 차단하고 GPU 변환 오류에 크기 정보를 추가했습니다.
- 합성 GPU 프레임에서 이전 코드의 0x80070057 오류를 재현하고 수정 후 변환을 확인했습니다.
- 실제 osu! 및 Discord 조작은 수행하지 않았습니다. 전체 ZIP 설치와 Discord 완전 재시작이 필요합니다.

native 1.1.7 / 플러그인 1.1.10 자동 전체 화면 캡처
- 일반 창: Windows 제목 표시줄·바깥 테두리를 제외한 클라이언트 영역을 GPU에서 캡처합니다.
- 활성 전체 화면·보더리스 창: 해당 모니터의 DXGI 영상으로 자동 전환합니다. 영상에 알림·오버레이가 포함될 수 있습니다.
- 소리는 계속 선택한 앱 프로세스만 캡처합니다. 시스템 소리로 전환하지 않습니다.
- 알탭·최소화·창모드 복귀 시 모니터 캡처를 중지하고 선택 창으로 돌아갑니다.
- 최소화된 게임은 자체 검은 화면으로 공유를 시작하고 활성화 후 새 프레임을 받습니다.
- 모드 전환으로 캡처 연결이 끊기면 재연결합니다. 다른 GPU로 이동하거나 회전된 모니터는 재시작 또는 지원 제한 안내가 나올 수 있습니다.
- Discord 완전 종료 후 함께 설치해 주세요. 실행 테스트 및 computer-use는 수행하지 않았습니다.

1.1.6 공개 저장소 업데이트
- 공개 저장소 업데이트에는 GitHub 토큰이 필요하지 않습니다.
- 1.1.4 오디오 수정과 1.1.5 업데이트 개선을 모두 포함합니다. 실행 테스트 없이 빌드했습니다.

1.1.5 업데이트 안정성
- 플러그인 자동 업데이트와 버튼으로 실행하는 native 업데이트를 분리합니다.
- 플러그인 커밋이 같으면 파일 재다운로드를 생략하고, 실패 시 간격을 늘려 재시도합니다.
- 자동 업데이트는 내려받은 JS를 실행하지 않고 문법을 먼저 파싱하며, 파일 쓰기 실패 시 이전 파일로 복원합니다.
- native 중복 예약을 방지하고 손상된 상태 파일에서 재시도할 수 있도록 보완했습니다.
- 설치된 native와 현재 로드된 native를 구분해 재시작 필요 여부를 안내합니다.
- 오래된 GUID 임시 다운로드 폴더만 정리합니다. 최근 두 개, 최근 7일 자료, 설치 백업과 활성 업데이트는 보존합니다.
- 필요한 native가 GitHub 정식 릴리스에 없으면 전체 ZIP 설치가 필요합니다.
- 이번 ZIP은 실행 테스트 없이 빌드했으며, 이전 1.1.4 앱별 오디오 수정도 포함합니다.

1.1.4 앱별 오디오
- 송출자 PC에 플러그인과 native를 함께 업데이트해야 합니다.
- 창모드/보더리스의 애플리케이션 공유는 선택한 프로세스 트리 소리만 캡처합니다.
- 창 식별 또는 앱 오디오 캡처 실패 시 전체 시스템 소리로 대체하지 않습니다.
- 오디오 패킷을 순서대로 보존하는 큐, 처리기 준비 대기, 전달 정지 감지와 진단 로그를 추가했습니다.
- 게임 프로세스의 종료 이벤트를 열지 않고 선택 창/PID로 감시해 불필요한 프로세스 접근 권한 의존을 제거했습니다.
- 같은 프로세스를 사용하는 여러 창/탭의 소리는 함께 포함될 수 있습니다.
- 실제 소리 복구 여부는 실행 검증하지 않았습니다.

1.1.1 업데이트 방식
- 플러그인 JS만 시작 후/매시간 자동 업데이트합니다. 통화·방송 중에는 적용을 미룹니다.
- native는 BetterDiscord의 CustomVoice 설정에서 새 버전 확인 후 업데이트 버튼으로 받습니다.
- GitHub 최신 정식 릴리스의 ZIP 및 CustomVoice-native.json을 사용합니다.
- 다운로드 완료 후 Discord를 완전히 종료하면 native만 설치하며 플러그인 JS와 설정은 유지합니다.
- 종료 후 5초 정도 기다렸다가 다시 실행하세요. 예약 대기는 최대 24시간입니다.
- 사용 중인 파일 교체 실패 시 기존 파일을 복원하고 설정창에 실패 원인을 표시합니다.

1.1.0
- 저장소/업데이트 경로: https://github.com/awizc/CustomVoice-plugin
- 접속/퇴장, 마이크/헤드셋 토글, 방송 시작/종료 효과음과 볼륨 설정.
- 방송 유저 위에 마우스를 올리거나 클릭하면 같은 음성 채널의 방송 썸네일 표시.
  썸네일은 송출자/시청자 모두 1.1.0이 필요합니다. 실제 시청 구독이나 오디오는 켜지지 않습니다.
- 창 공유는 선택 창의 프로세스 및 자식 프로세스 소리만 캡처합니다.
  해당 기능 실패 시 화면만 공유하며 시스템 전체 소리로 대체하지 않습니다.
  같은 앱의 여러 창/탭이 같은 프로세스 트리에 속하면 그 소리가 함께 포함될 수 있습니다.
  전체 화면 공유는 시스템 소리를 사용합니다.
- 시청 화면에서 포인터가 나가면 채널/화질 표시를 숨기며 키보드 포커스는 유지합니다.
- 연결 해제 시 송출/시청 오디오 트랙과 구독을 즉시 정리합니다.
  1.1.1부터는 native를 설정창의 업데이트 버튼으로 별도 갱신합니다.
- 이번 작업에서는 배포용 빌드만 수행하며 테스트·실측·computer-use는 수행하지 않습니다.

프로세스 루프백 API 참고:
https://github.com/microsoft/Windows-classic-samples/tree/main/Samples/ApplicationLoopback

일반 사용자 설치
1. 배포 ZIP 파일의 압축을 전부 풉니다.
2. Discord를 트레이 아이콘의 Quit Discord까지 눌러 완전히 종료합니다.
3. Install.cmd를 더블클릭합니다.
4. Discord를 실행하고 CustomVoice 플러그인을 켭니다.

Node.js, .NET, 개발 도구를 따로 설치할 필요가 없습니다.
플러그인과 native 폴더가 자동으로 BetterDiscord 플러그인 폴더에 복사됩니다.
기존 설정은 유지하고, 교체 전 파일은 BetterDiscord/data/CustomVoice-install-backups에 보관합니다.
BetterDiscord 업데이트 후 고FPS 캡처 연결이 풀리면 Install.cmd를 다시 실행합니다.
네이티브 연결만 해제하려면 CustomVoice.Capture.exe --remove를 실행합니다.
설치 실패 로그: BetterDiscord/plugins/logs/CustomVoice/installer-날짜.log

1.0.51 긴급 수정
- awaitScreenTracks() 함수의 닫는 중괄호 누락으로 플러그인이 로드되지 않는 구문 오류 수정.
- native 연결 코드는 1.0.50과 동일하며 해당 연결을 이미 로드했다면 추가 재시작 불필요.
- 사용자 요청에 따라 별도 검증 명령과 computer-use를 실행하지 않음.

1.0.50 변경 사항
- 방송 중지를 소리/화질 설정 대기열에서 분리하고 현재 캡처부터 종료합니다.
- 중복 중지 요청은 합치며, 종료 버튼은 새 방송 시작으로 바뀌지 않습니다.
- 취소된 캡처 요청의 결과가 늦게 도착하면 해당 트랙을 바로 정리합니다.
- 정상 프레임 메시지가 한꺼번에 도착해도 전체 묶음 크기로 오류 처리하지 않습니다.
- 송출 대기 중에는 최신 GPU 핸들 하나만 보관하고 이전 핸들은 import 전에 반환합니다.
  목표 FPS/해상도는 유지하며, 이 단계의 적체도 기존 부하 조절에 반영합니다.
- 동일한 처리 속도 알림은 매번 보내지 않고 변경 시 또는 유지 주기에 전송합니다.
- 테두리 권한 응답과 오래된 native 연결의 재시작 필요 상태를 방송 설정에 표시합니다.
이번 변경은 테스트, 구문 검사, 실측 없이 작성했습니다. FPS 향상 수치는 측정하지 않았습니다.
적용 후 Discord를 완전히 종료하고 다시 실행해야 새 host/preload를 불러옵니다.
캡처/송출 효율 개선은 방송하는 쪽의 업데이트로 적용됩니다.

노란 테두리 ON/OFF (1.0.49 이상)
방송 화면의 화질/FPS 버튼 → 방송 설정 → '노란 테두리 표시' 체크박스.
체크하면 ON, 해제하면 OFF입니다. 네이티브 방송은 방송 중 바로 변경합니다.
플러그인 설정의 '화면 공유 노란 테두리 표시 (다음 방송)'에서도 저장할 수 있습니다.
기본값은 ON이며 OFF를 선택한 경우 Windows의 테두리 없는 캡처 권한을 요청합니다.
권한을 허용하지 않거나 변경이 지원되지 않으면 방송은 계속하고 이유를 표시합니다.
권한 응답 대기 중에도 프레임 전송과 방송 종료는 계속 처리됩니다.
일반 캡처로 방송 중이면 OFF를 저장하고 방송을 다시 시작해야 합니다.
OFF로 시작하면 60FPS 이하에서도 지원되는 네이티브 캡처를 먼저 시도합니다.
다른 앱이 같은 화면/창의 테두리를 요구하면 Windows가 테두리를 계속 표시할 수 있습니다.
업데이트 후 Discord를 완전히 재시작해야 새 테두리 제어 연결이 로드됩니다.

Development notes (not required for installation)
The browser adapter is embedded in CustomVoice.plugin.js to avoid BetterDiscord's
external CommonJS loader. After editing capture.js, run node sync-renderer.cjs;
build.ps1 also performs this synchronization. Only the host/preload modules load
through real Node in the native startup hooks.

Build with the .NET 9 SDK:
  powershell -File .\build.ps1
An explicit SDK host can be passed with -Dotnet <path-to-dotnet.exe>.

Run ../package.ps1 to build the complete distributable ZIP. End users run
Install.cmd from the extracted package. Fully quit and restart Discord after
installing; toggling the plugin alone cannot load a new preload bridge.
The installer backs up betterdiscord.asar and adds two module-loading hooks.
It preserves existing code and isolation settings; no generic Node/IPC interface
is exposed to the page. The bridge permits only native capture start/configure/
pace/stop and GPU frame transfer, scoped to the originating Discord main window.

build.ps1 publishes self-contained, including the .NET runtime and its notices.
Windows 11 24H2+, Direct3D 11 video processing, and Electron sharedTexture.subtle
plus MediaStreamTrackGenerator are required. No Discord executable is patched.

The plugin selects this path for targets above 60 FPS. It uses the exact window
or monitor selected in the existing picker. Its helper sets the WGC session's
MinUpdateInterval to 1 ms, follows the requested border setting with Windows
consent, and converts/scales to
NV12 on the GPU. Eight bounded shared textures carry frames to the renderer;
only metadata crosses stdin/stdout and main-process IPC. GPU VideoFrames transfer
from the isolated preload into the plugin without a CPU pixel copy. It never
writes captured images to disk.
The Electron release callback acknowledges when a texture can be reused.
Output is paced at the selected FPS using a high-resolution waitable timer. When
the source has not changed, the latest NV12 frame is reused through GPU copies;
scaling/conversion runs only for an output deadline with a free GPU surface, or
profile changes. Source callbacks only retain the newest frame. This adds
one NV12 cache texture and retains one source frame in a three-frame WGC pool.
It does not create intermediate motion. A 60 FPS video's motion remains 60 FPS.
The shared output pool stays bounded at eight frames; busy encoders cause output
deadlines to be skipped instead of accumulating frames, memory or latency.
There is no Python worker or network server.

Version 1.0.43 negotiates advertised H264 profiles individually using WebRTC
capabilities, preserving compatible fallback profiles and retransmission codecs.
Hardware support is a capability hint, not proof of the active encoder; actual
encoder implementation, profile and powerEfficientEncoder are written to logs.
Source revisions distinguish new game frames from reused frames. A busy writer
holds at most one pending frame, replacing it with the latest source frame.
Version 1.0.46 replaces the old 200 ms repeat suppression with adaptive pacing.
Two sustained overload samples reduce the cadence offered to the encoder; three
healthy samples start gradual recovery. Resolution and the selected FPS ceiling
stay intact. WebRTC may adapt frame rate instead of holding overloaded encoding
at a fixed frame rate and resolution. Effective pacing is shown in the FPS HUD.
Fresh and repeated frames use the same cadence, with only one latest pending
frame. Slow writers cannot build up a queue. A busy GPU keyed mutex skips output
without writing to an unacquired surface. Color conversion is deferred until
there is an output slot, saving GPU work under encoder backpressure.
Native pacing feedback does not rebuild the processor or restart the stream.
Older hosts use a bounded renderer timer until Discord is fully restarted.
Logs include pacingFps, conversionFps, backpressureFps and handoffMaxGapMs.
Version 1.0.48 avoids adding a whole frame interval after slow native output work.
It keeps phase for ordinary timer jitter, bounds timing correction, and yields
for at least 0.5 ms after an overrun instead of replaying expired deadlines.
outputWorkMs measures elapsed work per output attempt, including lock/submission
time; it is not a GPU hardware timer. Sustained work overruns participate in
cadence feedback, and recovery requires native work headroom as well.
handoffMaxGapMs/MeanGapMs/LateCount now cover the recent ten one-second buckets,
not the whole session. handoffAgeMs and writerPendingMs reveal an ongoing stall
even without a new completed frame. These measure delivery into the local video
track, not confirmed viewer freezes. Diagnostics allocate a fixed ten buckets;
no per-frame history grows with stream duration. Stale native samples older than
six seconds no longer drive cadence adaptation.
Restart Discord after updating host-preload.cjs to enable revision metadata.

A small always-on-top FPS window opens when sharing starts. It shows measured
send/capture FPS and encoder cost without playing a second video preview. Close
it with X or reopen it with FPS beside broadcast settings. One shared 1 Hz poll
feeds the window, encoder feedback and logs even while Discord is hidden.
Stopping the broadcast or disabling the plugin closes the display and poll.
Exclusive fullscreen games may cover OS windows; borderless mode supports it.
Logs are saved under BetterDiscord/plugins/logs/CustomVoice (local-date files).

Version 1.0.47 also stops screen audio immediately when toggled off, even if
signaling or unpublishing fails. A deferred audio-state retry belongs to one
room and video publication. Screen announcements are ordered, and late results
from an old capture cannot clean up a newer broadcast. Audio settings reflect
the locally stopped track even when synchronization reports an error.

Version 1.0.44 stops capture and screen audio independently of signaling and
WebRTC renegotiation errors. Failed stop notifications retry on reconnect using
the original request ID. Viewers close ended publications and detached players,
and ignore stale live-state snapshots until a new video publication arrives.
Viewer-side cleanup requires updating the viewer's plugin as well.

Closing the source, stopping sharing, cancelling startup, disabling the plugin,
closing the pipe, or losing the parent process shuts down the helper. An
unsupported/failed native startup falls back to Chromium with a visible warning.

The tooltip identifies the active native engine as "WGC-D3D11 GPU". Its measured
capture/send FPS still come from WebRTC frame counters, not the requested FPS.
The tooltip distinguishes WGC source input, capture output, reused output frames
and actual encoded FPS. Static sources have fewer new frames but still request
the selected output cadence. Output remains limited by actual encoder, GPU,
network and receiver capacity; the chosen FPS is a target, not a guarantee.

The smoke directory is a development-only isolated Electron harness. It runs
hidden with contextIsolation on and Node disabled in the page, captures the
selected source locally, uses a local WebRTC connection,
prints numerical statistics, and exits; it does not operate the Discord UI.
It is not deployed with the plugin.
