@pushd "%~dp0"

@if exist chatter.exe del chatter.exe
@call node_modules\.bin\pkg.cmd -t node12-win-x86 chatter.js
@if %ERRORLEVEL% neq 0 goto :err
@call .\sign.cmd chatter.exe ..\codeSigning\signingCert.pfx
@if %ERRORLEVEL% neq 0 goto :err

@if exist converse.exe del converse.exe
@call node_modules\.bin\pkg.cmd -t node12-win-x86 converse.js
@if %ERRORLEVEL% neq 0 goto :err
@call .\sign.cmd converse.exe ..\codeSigning\signingCert.pfx
@if %ERRORLEVEL% neq 0 goto :err

@goto :finally
:err
@echo error %ERRORLEVEL%
:finally
@popd
