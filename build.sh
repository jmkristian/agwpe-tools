#!/bin/bash
cd `dirname "$0"` || exit $?
test -e converse.exe && rm converse.exe || exit $?
node_modules/.bin/pkg.cmd -t node12-win-x86 converse.js || exit $?
./sign.cmd converse.exe ..\\codeSigning\\signingCert.pfx || exit $?
