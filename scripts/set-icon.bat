@echo off
set ROOT=E:\Test\password-manager
set UNPACKED=%ROOT%\release\win-unpacked
set RCEDIT=%ROOT%\node_modules\electron-winstaller\vendor\rcedit.exe
set ICO=%ROOT%\buildResources\icon.ico

echo === Step 1: Copy exe to temp name (avoid Chinese chars) ===
copy "%UNPACKED%\网址管理器.exe" "%UNPACKED%\password-manager-temp.exe"

echo === Step 2: Set icon on temp exe ===
"%RCEDIT%" "%UNPACKED%\password-manager-temp.exe" --set-icon "%ICO%"
if %ERRORLEVEL% NEQ 0 (
    echo rcedit FAILED!
    exit /b 1
)

echo === Step 3: Replace original exe ===
copy /Y "%UNPACKED%\password-manager-temp.exe" "%UNPACKED%\网址管理器.exe"
del "%UNPACKED%\password-manager-temp.exe"

echo === Icon set successfully! ===
