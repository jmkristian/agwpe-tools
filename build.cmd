@pushd "%~dp0"

@set ERRORLEVEL=0
call npm install
echo on
@if %ERRORLEVEL% neq 0 goto :err

@if exist chatter.exe del chatter.exe
call node_modules\.bin\pkg.cmd -t node18-win chatter.js
echo on
@if %ERRORLEVEL% neq 0 goto :err

@if exist converse.exe del converse.exe
call node_modules\.bin\pkg.cmd -t node18-win converse.js
echo on
@if %ERRORLEVEL% neq 0 goto :err

@goto :finally
:err
@echo error %ERRORLEVEL%
:finally
@popd
