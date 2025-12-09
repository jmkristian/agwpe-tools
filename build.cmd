@pushd "%~dp0"

@set ERRORLEVEL=0
call npm install
@if %ERRORLEVEL% neq 0 goto :err

@if exist chatter.exe del chatter.exe
@echo on
call node_modules\.bin\pkg.cmd -t node20-win chatter.js
@if %ERRORLEVEL% neq 0 goto :err
@call .\sign.cmd chatter.exe
@if %ERRORLEVEL% neq 0 goto :err

@if exist converse.exe del converse.exe
@echo on
call node_modules\.bin\pkg.cmd -t node20-win converse.js
@if %ERRORLEVEL% neq 0 goto :err
@call .\sign.cmd converse.exe
@if %ERRORLEVEL% neq 0 goto :err

@goto :finally
:err
@echo error %ERRORLEVEL%
:finally
echo on
@popd
