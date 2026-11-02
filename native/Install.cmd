@echo off
setlocal DisableDelayedExpansion
chcp 65001 >nul
set "CV_CAPTURE=%~dp0CustomVoice.native\CustomVoice.Capture.exe"
if not exist "%CV_CAPTURE%" set "CV_CAPTURE=%~dp0CustomVoice.Capture.exe"
if not exist "%CV_CAPTURE%" (
  echo CustomVoice.Capture.exe is missing. Extract the complete ZIP first.
  pause
  exit /b 1
)
"%CV_CAPTURE%" --install
set "CV_RESULT=%ERRORLEVEL%"
echo.
pause
exit /b %CV_RESULT%
