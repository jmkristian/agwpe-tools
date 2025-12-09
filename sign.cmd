@REM Sign and timestamp %1
@SignTool Sign /q /n "John Michael Kristian" /t http://time.certum.pl/ /fd SHA256 %1
@REM if %ERRORLEVEL% neq 0 exit /B %ERRORLEVEL%
@SignTool Verify /q /pa %1
@REM if %ERRORLEVEL% neq 0 exit /B %ERRORLEVEL%
