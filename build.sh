#!/bin/bash
cd `dirname "$0"` || exit $?

npm install || exit $?

test -e chatter && rm chatter
node_modules/.bin/pkg -t node18-linux chatter.js || exit $?

test -e converse && rm converse
node_modules/.bin/pkg -t node18-linux converse.js || exit $?
