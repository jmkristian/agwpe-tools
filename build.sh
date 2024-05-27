#!/bin/bash
cd `dirname "$0"` || exit $?

test -e chatter.exe && rm chatter.exe
node_modules/.bin/pkg.cmd -t node12-win-x86 chatter.js || exit $?
./sign.cmd chatter.exe ..\\codeSigning\\signingCert.pfx || exit $?

test -e converse.exe && rm converse.exe
node_modules/.bin/pkg.cmd -t node12-win-x86 converse.js || exit $?
./sign.cmd converse.exe ..\\codeSigning\\signingCert.pfx || exit $?
