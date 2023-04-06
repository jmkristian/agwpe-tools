@REM Sign and timestamp %1 using the code signing .pfx file %2
@SignTool Sign /fd SHA256 /f %2 %1
@if %errorlevel% neq 0 exit /B %errorlevel%
@SignTool Timestamp /tr "http://timestamp.sectigo.com" /td SHA256 %1
@if %errorlevel% neq 0 exit /B %errorlevel%
