#!/bin/bash
cd `dirname "$0"` || exit $?

test -e chatter && rm chatter
node_modules/.bin/pkg -t node12-linux chatter.js || exit $?

test -e converse && rm converse
node_modules/.bin/pkg -t node12-linux converse.js || exit $?
