'use strict';

const AGWPE = require('../node-agwpe');
const Bunyan = require('bunyan');
const bunyanFormat = require('bunyan-format');
const Lines = require('./lines.js').Lines;
const minimist = require('minimist');
const OS = require('os');
const path = require('path');
const shared = require('./shared.js');
const Stream = require('stream');
const validateCallSign = AGWPE.validateCallSign;

const args = minimist(process.argv.slice(2), {
    'boolean': ['debug', 'show-controls', 'show-eol', 'show-time', 'trace', 'verbose', 'v'],
    'string': ['encoding', 'eol', 'escape', 'hide-eol', 'port', 'tnc-port', 'tncport', 'via'],
});
const log = Bunyan.createLogger({
    name: 'chatter',
    level: args.trace ? Bunyan.TRACE : args.debug ? Bunyan.DEBUG : Bunyan.INFO,
    stream: bunyanFormat({outputMode: 'short', color: false}, process.stderr),
});
const controlCharacters = new RegExp('[\x00-\x1F]|[\x7F-\u00A0]', 'g');
const ESC = (args.escape == undefined) ? '\x1D' // GS = Ctrl+]
      : shared.fromASCII(args.escape);
const frameLength = parseInt(args['frame-length'] || '128');
const host = args.host || '127.0.0.1'; // localhost, IPv4
const port = args.port || args.p || 8000;
const showControls = args['show-controls'];
const showEOL = args['show-eol'];
const remoteEOL = shared.fromASCII(args.eol) || '\r';
const remoteEncoding = shared.encodingName((args.encoding || 'ISO-8859-1').toLowerCase());
const verbose = args.verbose || args.v;
const showTime = args['show-time'];

var allConnections = {};
var bestPathTo = {};
var myCall = '';
var tncPort = 0;

const terminal = new Lines(process.stdout, ESC, log);
process.stdin.pipe(terminal);
var commandMode = true;
const commandPrompt = 'cmd:';
const dataPrompt = 'data:';
var hasEscaped = false;
var connection = null;
var pathTo = {};
var remoteAddress = null;
var server = null;
var ending = false;

/** Convert s to a javascript string literal (without the quotation marks.) */
function escapify(s) {
    if (!showControls) return s;
    return s && s
        .replace(/\\/g, '\\\\')
        .replace(/\r/g, '\\r')
        .replace(/\n/g, '\\n')
        .replace(controlCharacters, function(c) {
            const code = c.charCodeAt(0);
            if (code <= 0xFF) {
                return '\\x' + (code + 0x100).toString(16).substring(1).toUpperCase();
            } else {
                return '\\u' + (code + 0x100000).toString(16).substring(2).toUpperCase();
            }
        });
}

function splitLines(from) {
    if (from == null) return from;
    if (from == '') return [from];
    var into = [];
    var last = null;
    from.split(remoteEOL).forEach(function(line) {
        into.push(line + (showEOL ? remoteEOL : ''));
        last = line;
    });
    if (last == '') {
        into.pop();
    } else {
        into[into.length - 1] = last; // without remoteEOL
    }
    return into;
}

function parseVia(via) {
    if (!via) return null;
    var result = via.trim();
    if (!result) return null;
    const parts = result.split(/[\s,]+/);
    result = '';
    for (var p = 0; p < parts.length; ++p) {
        if (result) result += ',';
        result += validateCallSign('digipeater', parts[p].replace(/\*$/, ''));
    }
    return result;
}

var lastPacketBetween = {};
const sec = 1000;

function isRepetitive(packet) {
    try {
        const now = Date.now();
        const key = validateCallSign('source', packet.fromAddress)
              + '>' + validateCallSign('destination', packet.toAddress);
        const recent = lastPacketBetween[key];
        const current = packet.type
              + ' ' + packet.NR + ' ' + packet.NS +
              + ' ' + (packet.P || packet.F)
              + (packet.info ? ' ' + packet.info.toString('binary') : '');
        if (!recent || recent.packet != current) {
            lastPacketBetween[key] = {packet: current, when: now};
        } else if (now - recent.when < 15 * sec) {
            recent.when = now;
            return true; // repetitive
        }
    } catch(err) {
        log.warn(err);
    }
    return false;
}

function arraysEqual(a, b) {
    if (a === b) return true;
    if (a == null || b == null) return false;
    if (a.length !== b.length) return false;
    for (var i = 0; i < a.length; ++i) {
        if (a[i] != b[i]) return false;
    }
    return true;
}

function noteReturnPath(packet) {
    try {
        const fromAddress = validateCallSign('source', packet.fromAddress);
        if (fromAddress == myCall) {
            return;
        }
        // Construct a path from here to packet.fromAddress:
        var newPath = [];
        const via = packet.via;
        if (via) for (var v = 0; v < via.length; ++v) {
            var repeater = via[v];
            if (repeater.endsWith('*')) { // This repeater forwarded this packet.
                newPath.unshift(validateCallSign(
                    'repeater', repeater.substring(0, repeater.length - 1)));
            } else {
                // We received this packet directly from newPath[0].
                break; // Look no further.
            }
        }
        var item = bestPathTo[fromAddress];
        if (item == null || newPath.length < item.path.length) {
            bestPathTo[fromAddress] = {path: newPath, counter: 1};
        } else if (arraysEqual(newPath, item.path)) {
            ++item.counter;
        }
    } catch(err) {
        log.warn(err);
    }
    return null;
}

function pad2(n) {
    return (n <= 9) ? '0' + n : '' + n;
}

function logLine(line, callback) {
    if (showTime) {
        const now = new Date();
        terminal.writeLine(
            pad2(now.getHours())
                + ':' + pad2(now.getMinutes())
                + ':' + pad2(now.getSeconds())
                + ' ' + line,
            callback);
    } else {
        terminal.writeLine(line, callback);
    }
}

function showUsage(exitCode) {
    const arg0 = path.basename(process.argv[0]);
    const myName = arg0 + ((arg0 == 'chatter.exe') ? '' : (' ' + path.basename(process.argv[1])));
    process.stderr.write([
        '', // blank line
        `usage: ${myName} [options] <local call sign> [remote call sign]`,
        `Supported options are:`,
        `--host <address>    : TCP host of the TNC. Default: 127.0.0.1`,
        `--port N            : TCP port of the TNC. Default: 8000`,
        `--tnc-port N        : TNC port (sound card number), in the range 0-255. Default: 0`,
        `--via <repeater,...>: a comma-separated list of digipeaters via which to send packets.`,
        `--show-controls     : show unprintable characters (as string literals). Default: false`,
        `--show-eol          : show end-of-line characters. Default: false`,
        `--show-time         : show the time when data are sent or received. Default: false`,
        `--verbose           : show more information about what's happening. Default: false`,
        `--eol <string>      : represents end-of-line in data sent or received. Default: CR`,
        `--escape <character>: switches between sending data and entering a command. Default: Ctrl+]`,
        `--encoding <string> : encoding of characters sent or received. Default: ISO-8859-1`,
        `                      Other supported encodings are Windows-1252 and UTF-8.`,
        '',
    ].join(OS.EOL));
    if (exitCode != null) process.exit(exitCode);
}

function summarize(packet) {
    log.trace('summarize(%s)', packet);
    var marker = '';
    if (packet.fromAddress == myCall) {
        marker += '>' + packet.toAddress;
    } else if (packet.toAddress == myCall) {
        marker += '<' + packet.fromAddress;
    } else {
        marker += packet.fromAddress + '>' + packet.toAddress;
    }
    if (packet.via) {
        marker += ' via ';
        for (var v = 0; v < packet.via.length; ++v) {
            if (v > 0) marker += ',';
            marker += packet.via[v];
        }
    }
    marker += ` ${packet.type}`;
    splitLines(shared.decode(packet.info || '', remoteEncoding)).forEach(function(line) {
        logLine(`${marker} ${escapify(line)}`);
    });
}

function setCommandMode(newMode) {
    if (commandMode != newMode) {
        if (commandMode && !hasEscaped) {
            hasEscaped = true;
            terminal.writeLine('(Type data to send'
                               + (ESC ? `, or ${shared.controlify(ESC)} to enter a command` : '')
                               + '.)');
        }
        commandMode = newMode;
    }
    terminal.prompt(commandMode ? commandPrompt : dataPrompt);
}

function initialize() {
    setCommandMode (!remoteAddress);
    terminal.on('escape', function() {setCommandMode(!commandMode);});
    terminal.on('line', function(line) {
        try {
            const info = shared.encode(line + remoteEOL, remoteEncoding);
            if (commandMode) {
                execute(line);
            } else if (connection) {
                connection.write(info, function sent() {
                    logLine(
                        '>' + connection.remoteAddress
                            + ' I ' + escapify(line + (showEOL ? remoteEOL : '')));
                });
            } else if (remoteAddress) {
                const via = getPathTo(remoteAddress);
                socket.send({
                    port: tncPort,
                    type: 'UI',
                    toAddress: remoteAddress,
                    fromAddress: myCall,
                    via: via || undefined,
                    info: info,
                }, function sent() {
                    logLine(
                        '>' + remoteAddress
                            + (via ? ' via ' + via : '')
                            + ' UI ' + escapify(line + (showEOL ? remoteEOL : '')));
                });
            } else {
                terminal.writeLine('(Where to? Enter "u <call sign>" to set a destination address.)');
                setCommandMode(true);
            }
        } catch(err) {
            log.error(err);
        }
    });
    restartServer();
}

function restartServer() {
    if (server) server.close();
    server = new AGWPE.Server({
        host: host,
        port: port,
        log: log,
    });
    server.on('connection', function(connection) {
        const remoteAddress = connection.remoteAddress.toUpperCase();
        allConnections[remoteAddress] = connection;
        terminal.writeLine(
            `(Received a connection.`
                + ` The command "c ${remoteAddress}" will start sending data there.)`);
    });
    server.on('error', function(err) {
        log.error(err);
    });
    server.listen({
        host: myCall,
        port: tncPort,
    }, function listening() {
        if (verbose) {
            terminal.writeLine(`(Listening for connections on TNC port ${tncPort}.)`);
        }
    });
} // restartServer

function getPathTo(remoteAddress) {
    var best = bestPathTo[remoteAddress];
    var path = pathTo[remoteAddress];
    if (path == null) {
        if (best) path = best.path.join(',');
    } else if (best && best.path.length < path.split(/[\s,]+/).length
               && [4, 8, 16, 32].indexOf(best.counter) >= 0) {
        terminal.writeLine(`(${best.path.join(',')} looks like a better path than ${path}.)`);
    }
    log.trace('getPathTo(%s) = %s', remoteAddress, path);
    return path;
}

function setPathTo(remoteAddress, path) {
    log.trace('setPathTo(%s, %s)', remoteAddress, path);
    if (path != null) {
        pathTo[remoteAddress] = path;
    }
    return path;
}

function onPacket(packet) {
    try {
        log.trace('onPacket(%s)', packet);
        if (packet.port == tncPort) {
            noteReturnPath(packet);
            if (verbose
                || (!isRepetitive(packet) // Call this first for its side effect.
                    && (packet.type == 'I' || packet.type == 'UI'))) {
                summarize(packet);
            }
        }
    } catch(err) {
        log.error(err);
    }
}

function viaOption(remoteAddress, parts) {
    // A command line like "c a6call via" specifies no repeaters.
    // But "c a6call" means use a recent path or the best observed path.
    if (parts.length < 3 || parts[2].toLowerCase() != 'via') {
        return getPathTo(remoteAddress);
    } else {
        return setPathTo(remoteAddress, parseVia(parts[3]) || '');
    }
}

function execute(command) {
    log.trace(`cmd:${command}`);
    var nextCommandMode = false;
    try {
        const parts = command.trim().split(/\s+/);
        switch(parts[0].toLowerCase()) {
        case '':
            break;
        case 'u':
        case 'ui':
        case 'unproto':
            unproto(parts);
            break;
        case 'c':
        case 'connect':
            nextCommandMode = true;
            connect(parts);
            break;
        case 'd':
        case 'disconnect':
            disconnect(parts[1]);
            break;
        case 'p':
        case 'port':
            const newPort = AGWPE.validatePort(parts[1] || '0');
            if (tncPort != newPort) {
                tncPort = newPort;
                restartServer();
            }
            if (verbose) {
                terminal.writeLine(`(Communicating via TNC port ${tncPort}.)`);
            }
            break;
        case 'b':
        case 'bye':
            bye();
            break;
        default:
            terminal.writeLine(command + '?');
            [
                "The available commands are:",
                "U[nproto] <call sign> [via <call sign>,...]",
                "          : Send the following data in UI packets",
                "          : to that call sign via those digipeaters.",
                "C[onnect] <call sign> [via <call sign>,...]",
                "          : Send the following data in a connection",
                "          : to that call sign via those digipeaters.",
                "D[isconnect] [call sign]",
                "          : Disconnect from that call sign or (with",
                "          : no call sign) disconnect from the station",
                "          : to which you're currently connected.",
                "P[ort] <number>",
                "          : Send and receive data via that AGWPE port.",
                "B[ye]",
                "          : Close all connections and exit.",
            ].forEach(function(line) {
                terminal.writeLine(line);
            });
            nextCommandMode = true;
        }
    } catch(err) {
        log.error(err);
        nextCommandMode = true;
    }
    setCommandMode(nextCommandMode);
} // execute

function unproto(parts) {
    remoteAddress = validateCallSign('remote', parts[1]);
    const via = viaOption(remoteAddress, parts);
    if (verbose) {
        const viaNote = via ? ` via ${via}` : '';
        terminal.writeLine(`(Transmit UI packets${viaNote} to ${remoteAddress}.)`);
    }
} // unproto

function connect(parts) {
    remoteAddress = validateCallSign('remote', parts[1]);
    const via = viaOption(remoteAddress, parts);
    const viaNote = via ? ` via ${via}` : '';
    connection = allConnections[remoteAddress];
    if (connection) {
        if (verbose) {
            terminal.writeLine(`(Transmit I packets${viaNote} to ${remoteAddress}.)`);
        }
    } else {
        const options = {
            host: host,
            port: port,
            localPort: tncPort,
            localAddress: myCall,
            remoteAddress: remoteAddress,
            via: via || undefined,
        };
        terminal.writeLine(`(Connecting to ${remoteAddress}${viaNote}...)`);
        const newConnection = AGWPE.createConnection(options, function connected() {
            try {
                connection = allConnections[remoteAddress] = newConnection;
                connection.pipe(new Stream.Writable({
                    write: function _write(chunk, encoding, callback) {
                        // onPacket will log the received data.
                        if (callback) callback();
                    },
                }));
                terminal.writeLine(`(Connected to ${remoteAddress}${viaNote}.)`);
                setCommandMode(false);
            } catch(err) {
                log.error(err);
            }
        });
        ['end'].forEach(function(event) {
            newConnection.on(event, function(info) {
                if (info) {
                    logLine(
                        '(' + escapify(shared.decode(info, remoteEncoding)) + ')');
                } else if (verbose) {
                    logLine(`(Disconnected from ${remoteAddress}.)`);
                }
                delete allConnections[remoteAddress];
                if (connection === newConnection) {
                    connection = null;
                }
                if (ending && Object.keys(allConnections).length <= 0) {
                    process.exit();
                }
            });
        });
        ['error', 'timeout'].forEach(function(event) {
            newConnection.on(event, function(err) {
                terminal.writeLine(`(${event} ${err || ''} from ${remoteAddress})`);
                delete allConnections[remoteAddress];
                if (connection === newConnection) {
                    connection = null;
                }
            });
        });
    }
} // connect

function disconnect(arg) {
    var remoteAddress = (arg || '').toUpperCase();
    if (!remoteAddress && connection) {
        remoteAddress = connection.remoteAddress.toUpperCase();
    }
    if (!remoteAddress) {
        terminal.writeLine(`(You're not connected.)`);
    } else {
        validateCallSign('remote', remoteAddress);
        var target = allConnections[remoteAddress];
        if (!target) {
            terminal.writeLine(`(You haven't connected to ${remoteAddress}.)`);
        } else {
            logLine(`>${remoteAddress} DISC`);
            target.end();
        }
    }
} // disconnect

function bye() {
    try {
        for (var remoteAddress in allConnections) {
            ending = true;
            allConnections[remoteAddress].end();
        }
        if (ending) {
            setTimeout(process.exit, 10 * sec);
        } else {
            process.exit();
        }
    } catch(err) {
        log.error(err);
    }
} // bye

try {
    tncPort = AGWPE.validatePort(args['tnc-port'] || args.tncport || 0);
    myCall = validateCallSign('local', args._[0]);
    shared.validateEncoding(remoteEncoding);
    remoteAddress = args._[1] ? validateCallSign('remote', args._[1]) : null;
    if (ESC && ESC.length > 1) {
        throw shared.newError(
            `--escape must specify a single character (not ${JSON.stringify(ESC)}).`,
            'ERR_INVALID_ARG_VALUE');
    }
    log.debug('%s"', {
        verbose: verbose,
        myCall: myCall,
        tncPort: tncPort,
        remoteEOL: remoteEOL,
    });
    terminal.on('SIGTERM', process.exit);
    initialize();
    ['close', 'SIGINT'].forEach(function(event) {
        terminal.on(event, function(info) {
            bye();
        });
    });
    const socket = AGWPE.raw.createSocket({
        host: host,
        port: port,
        logger: log,
    }, function connected() {
    });
    socket.on('packet', function(packet) {
        onPacket(packet);
    });
    socket.on('error', function(err) {
        log.error('error(%s)', err != null ? err : '');
    });
    socket.on('close', function(err) {
        log.warn('close(%s)', err != null ? err : '');
        process.exit(1);
    });
} catch(err) {
    log.error(err);
    showUsage(1);
}
