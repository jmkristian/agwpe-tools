#!/bin/bash
cd `dirname "$0"` || exit $?

test -e chatter && rm chatter
node_modules/.bin/pkg -t node14-linuxstatic-armv7 chatter.js || exit $?

test -e converse && rm converse
node_modules/.bin/pkg -t node14-linuxstatic-armv7 converse.js || exit $?
