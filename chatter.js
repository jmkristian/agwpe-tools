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
    'boolean': ['debug', 'show-controls', 'show-eol', 'show-time', 'show-timestamp', 'timestamp', 'trace', 'verbose', 'v'],
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
const allRemoteEOLs = new RegExp(remoteEOL, 'g');
const allOS_EOLs = new RegExp(OS.EOL, 'g');
const eachLine = new RegExp('.*' + remoteEOL, 'g');
const remoteEncoding = shared.encodingName((args.encoding || 'ISO-8859-1').toLowerCase());
const decodedEOL = shared.decode(remoteEOL, remoteEncoding);
const verbose = args.verbose || args.v;
const showTime = args['show-time'] || args['show-timestamp'] || args['timestamp'];

var allConnections = {};
var bestPathTo = {};
var pathTo = {};
var myCall = '';
var tncPort = 0;
var hiddenSources = {};
var hiddenDestinations = {};

function pathLength(path) {
    return path ? path.split(/[\s,]+/).length : 0;
}
function normalizePath(p) {
    return p && p.replace(/\s/g, '').replace(/,+/, ',').toUpperCase();
}
function validatePath(p) {
    if (p) p.split(/[\s,]+/).forEach(function(c) {validateCallSign('repeater', c);});
}
var defaultPath = normalizePath(args['via']);

const terminal = new Lines(ESC);
var commandMode = true;
const commandPrompt = 'cmd: ';
var dataPrompt = '';
var hasEscaped = false;
var connected = null;
var connectedBuffer = '';
var remoteAddress = null;
var server = null;
var rawSocket = null;
var ending = false;

/** Convert s to a javascript string literal (without the quotation marks.) */
function escapify(s) {
    var result = (s == null) ? '' : s.toString('binary');
    if (!showControls) {
        return result.replace(controlCharacters, '');
    }
    if (!showEOL) result = result.replace(allRemoteEOLs, '');
    return result
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
        result += validateCallSign('repeater', parts[p].replace(/\*$/, ''));
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
        // Construct a path from here to fromAddress:
        var newPath = '';
        var newPathLength = 0;
        const via = packet.via;
        if (via) {
            for (var v = 0; v < via.length; ++v) {
                var repeater = via[v];
                if (repeater.endsWith('*')) { // This repeater forwarded this packet.
                    newPath = validateCallSign(
                        'repeater', repeater.substring(0, repeater.length - 1))
                        + (newPath && ',' + newPath);
                    ++newPathLength;
                } else {
                    // We received this packet directly from the last repeater (if any).
                    break; // Look no further.
                }
            }
        }
        const best = bestPathTo[fromAddress];
        if (!best || (newPath != best.path && newPathLength <= pathLength(best.path))) {
            bestPathTo[fromAddress] = {path: newPath, counter: 1};
        } else if (newPath == best.path) {
            best.counter++;
            if ([4, 8, 16, 32].indexOf(best.counter) >= 0) {
                var current = pathTo[fromAddress];
                if (current != null && current != best.path) {
                    if (best.path) {
                        terminal.writeLine(
                            `(It looks like sending to ${fromAddress} via ${best.path} would be better than via ${current}.)`
                        );
                    } else {
                        terminal.writeLine(
                            `(It looks like sending to ${fromAddress} directly would be better than via ${current}.)`
                        );
                    }
                }
            }
        }
    } catch(err) {
        log.warn(err);
    }
}

function pad2(n) {
    return (n <= 9) ? '0' + n : '' + n;
}

function logLine(line, callback) {
    try {
        const now = new Date();
        const prefix = !showTime ? ''
              : pad2(now.getHours())
              + ':' + pad2(now.getMinutes())
              + ':' + pad2(now.getSeconds())
              + ' ';
        terminal.writeLine(prefix + line, callback);
    } catch(err) {
        if (callback) callback(err);
    }
}

function logLines(prefix, lines, callback) {
    log.trace('logLines(%s, %s, %s)', prefix, lines && lines.length, typeof callback);
    var next = 0;
    const logNextLine = function logNextLine(err) {
        if (err) {
            if (callback) callback(err);
        } else if (next < lines.length) {
            const line = escapify(lines[next++]);
            logLine(`${prefix} ${line}`, logNextLine);
        } else {
            if (callback) callback();
        }
    };
    logNextLine();
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

function logPacketReceived(packet, callback) {
    log.trace('logPacketReceived(%s, %s)', packet, typeof callback);
    var marker = '';
    if (packet.fromAddress == myCall) {
        marker += '>' + packet.toAddress;
    } else if (packet.toAddress == myCall) {
        marker += '<' + packet.fromAddress;
    } else {
        marker += packet.fromAddress + '>' + packet.toAddress;
    }
    if (packet.via && packet.via.length) {
        var via = [];
        var lastSender = 0;
        for (var v = packet.via.length; --v >= 0; ) {
            var sender = packet.via[v];
            if (sender.endsWith('*')) { // a digipeater sent this
                if (lastSender == 0) {
                    lastSender = v;
                } else {
                    sender = sender.substring(0, sender.length - 1);
                }
            }
            via.unshift(sender);
        }
        marker += ' via' + via.join(',');
    }
    marker += ` ${packet.type}`;
    logLines(marker,
             splitLines(shared.decode(packet.info || '', remoteEncoding)),
             callback);
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

function toRemoteLine(line) {
    return shared.encode(line + decodedEOL, remoteEncoding);
}

function logDataSent(packetType, lines, remoteAddress, via) {
    logLines(`>${remoteAddress}` + (via ? ` via ${via}` : '') + ` ${packetType} `,
             lines.split(allOS_EOLs).map(escapify));
}

function initialize() {
    setDataPrompt();
    setCommandMode(!remoteAddress);
    terminal.on('escape', function() {
        if (commandMode && !(connected || remoteAddress)) {
            terminal.writeLine('(Enter "u <call sign>" or "c <call sign>" to set a destination address.)');
        } else {
            setCommandMode(!commandMode);
        }
    });
    terminal.on('line', function(line) {
        try {
            if (commandMode) {
                execute(line);
            } else if (connected) {
                connected.write(toRemoteLine(line), function sent() {
                    logDataSent('I', line, connected.remoteAddress);
                });
            } else if (remoteAddress) {
                const via = getPathTo(remoteAddress);
                rawSocket.write({
                    port: tncPort,
                    type: 'UI',
                    toAddress: remoteAddress,
                    fromAddress: myCall,
                    via: via || undefined,
                    info: toRemoteLine(line),
                }, function sent() {
                    logDataSent('UI', line, remoteAddress, via);
                });
            } else {
                terminal.writeLine('(Where to? Enter "u <call sign>" to set a destination address.)');
            }
        } catch(err) {
            log.error(err);
        }
    });
    restartServer();
}

function restartServer() {
    if (server) server.close();
    server = null;
    rawSocket = null;
    const newServer = new AGWPE.Server({
        host: host,
        port: port,
        localPort: tncPort,
        logger: log,
    });
    newServer.on('error', function(err) {
        if (!server || server === newServer) {
            // not necessary: newServer.destroy();
            log.error('server error(%s)', err ? err : '');
            process.exit(1);
        } else {
            log.debug('previous server error(%s)', err ? err : '');
        }
    });
    newServer.on('close', function closed(err) {
        if (!server || server === newServer) {
            // not necessary: newServer.destroy();
            process.exit(2);
        } else {
            log.debug('previous server close(%s)', err ? err : '');
        }
    });
    newServer.on('connection', function(connection) {
        const remoteAddress = connection.remoteAddress.toUpperCase();
        allConnections[remoteAddress] = connection;
        terminal.writeLine(
            `(Received a connection.`
                + ` The command "c ${remoteAddress}" will start sending data there.)`);
    });
    newServer.listen({
        host: myCall,
        port: tncPort,
    }, function listening() {
        if (server && server !== newServer) {
            // Somebody else got there first.
            newServer.destroy();
        } else {
            server = newServer;
            if (verbose) {
                terminal.writeLine(`(Listening to TNC port ${tncPort}.)`);
            }
            const newSocket = newServer.createSocket();
            ['close', 'end', 'error', 'timeout'].forEach(function(event) {
                newSocket.on(event, function(err) {
                    log.error('raw socket %s(%s)', event, err != null ? err : '');
                });
            });
            newSocket.bind(function bound(err) {
                if (err) {
                    log.error(err);
                } else {
                    newSocket.pipe(new Stream.Writable({
                        objectMode: true,
                        write: function _write(packet, encoding, callback) {
                            onPacket(packet, callback);
                        },
                    }));
                    rawSocket = newSocket;
                }
            });
        }
    });
} // restartServer

function getPathTo(remoteAddress) {
    var path = pathTo[remoteAddress];
    var best = bestPathTo[remoteAddress];
    return (path != null) ? path : best ? best.path : defaultPath;
}

function viaOption(remoteAddress, parts) {
    // A command line like "c a6call via" specifies no repeaters.
    // But "c a6call" means use pathTo or besPathTo.
    if (parts.length < 3 || parts[2].toLowerCase() != 'via') {
        return getPathTo(remoteAddress);
    } else {
        var path = normalizePath(parts[3]);
        validatePath(path);
        pathTo[remoteAddress] = path;
        return path;
    }
}

function onPacket(packet, callback) {
    try {
        log.trace('onPacket(%s)', packet);
        if (packet.port == tncPort) {
            noteReturnPath(packet);
            if (verbose || packet.type == 'I' || packet.type == 'UI') {
                if (!(isRepetitive(packet) // Call this first for its side effect.
                      || hiddenSources[packet.fromAddress]
                      || hiddenDestinations[packet.toAddress]
                      || (connected
                          && packet.type == 'I'
                          && packet.toAddress == connected.localAddress)))
                {
                    logPacketReceived(packet, callback);
                    return;
                }
            }
        }
        // We didn't show this packet, for one of those reasons.
        if (callback) callback();
    } catch(err) {
        log.error(err);
        if (callback) callback(err);
    }
}

function onConnectedData(chunk, encoding, callback) {
    try {
        const data = (chunk == null) ? '' : chunk.toString('binary');
        if (log.trace()) {
            log.trace('onConnectedData(%s, %s, %s)', escapify(data), encoding, typeof callback);
        }
        const remainder = data.replace(eachLine, function(line) {
            connectedBuffer += shared.decode(Buffer.from(line, 'binary'), remoteEncoding);
            logLines(`<${connected.remoteAddress} I `, [connectedBuffer]);
            connectedBuffer = '';
            return '';
        });
        connectedBuffer += remainder;
        setDataPrompt();
        terminal.prompt(dataPrompt, callback);
    } catch(err) {
        if (callback) callback(err);
    }
}

function execute(command) {
    log.debug('execute(%s)', command);
    terminal.writeLine(`${commandPrompt}${command}`);
    var nextCommandMode = true;
    try {
        const parts = command.trim().split(/\s+/);
        switch(parts[0].toLowerCase()) {
        case '':
            break;
        case 'u':
        case 'ui':
        case 'unproto':
            nextCommandMode = !unproto(parts);
            break;
        case 'c':
        case 'connect':
            nextCommandMode = !connect(parts);
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
        case 'via':
            setVia(parts);
            break;
        case 'via?':
            showVia(parts);
            break;
        case 'h':
        case 'hide':
            hide(parts);
            break;
        case 's':
        case 'show':
            show(parts);
            break;
        case 'hide?':
            terminal.writeLine(
                'hidden: '
                    + Object.keys(hiddenDestinations).map(function(s){return '>' + s;}).join(' ')
                    + ' ' + Object.keys(hiddenSources).map(function(s){return '<' + s;}).join(' '));
            break;
        case 'x':
        case 'xecute':
        case 'execute':
            if (parts.length < 2) {
                terminal.writeLine('(What file do you want to execute?)');
            } else {
                // This crude parser doesn't have a syntax for quoted strings.
                // This is a pretty good approximation:
                parts.splice(0, 1);
                terminal.readFile(parts.join(' '));
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
                "U[nproto] callsign [via callsign,...]",
                "          : Send the following data in UI packets to that call sign via",
                "          : those digipeaters.",
                "C[onnect] callsign [via callsign,...]",
                "          : Send the following data in a connection to that call sign via",
                "          : those digipeaters.",
                "D[isconnect] [callsign]",
                "          : Disconnect from that call sign or (with no call sign) disconnect",
                "          : from the station to which you're currently connected.",
                "Via [repeater,...]",
                "          : Set the default list of digipeaters via which to communicate with",
                "          : a new station. If you don't list any digipeaters, the default",
                "          : will be to communicate directly.",
                "Via? [callsign]",
                "          : Show the current and default digipeaters via which to communicate",
                "          : with that call sign or (with no call sign) a new call sign.",
                "H[ide] [<fromCall >toCall ...]",
                "          : Stop showing data that were sent by fromCall or sent to toCall.",
                "S[how] [<fromCall >toCall ...]",
                "          : Resume showing data that were sent by fromCall or sent to toCall.",
                "X[ecute] fileName",
                "          : Read a file and interpret it like input that you type.",
                "P[ort] number",
                "          : Use that AGWPE port to send and receive data.",
                "B[ye]",
                "          : Close all connections and exit.",
            ].forEach(function(line) {
                terminal.writeLine(line);
            });
        }
    } catch(err) {
        log.error(err);
        nextCommandMode = true;
    }
    setCommandMode(nextCommandMode);
} // execute

function setDataPrompt() {
    if (connected) {
        dataPrompt = `>${connected.remoteAddress} I: ${connectedBuffer}`;
    } else if (remoteAddress) {
        dataPrompt = `>${remoteAddress} UI: `;
    } else {
        dataPrompt = `>?: `;
    }
}

function startSendingTo(remote, packetType) {
    remoteAddress = remote;
    setDataPrompt();
    delete hiddenSources[remote];
    delete hiddenDestinations[remote];
    setCommandMode(false);
}

function unproto(parts) {
    const remote = validateCallSign('remote', parts[1]);
    const via = viaOption(remote, parts);
    connected = null; // but it remains in allConnections.
    startSendingTo(remote, 'UI');
    if (verbose) {
        const viaNote = via ? ` via ${via}` : '';
        terminal.writeLine(`(Will send UI packets${viaNote} to ${remote}.)`);
    }
    return true;
} // unproto

function connect(parts) {
    const remote = validateCallSign('remote', parts[1]);
    const via = viaOption(remote, parts);
    connected = allConnections[remote];
    if (connected) {
        startSendingTo(remote, 'I');
        if (verbose) {
            terminal.writeLine(`(Will send I packets to ${remote}.)`);
        }
        return true;
    }
    const viaNote = via ? ` via ${via}` : '';
    const options = {
        host: host,
        port: port,
        localPort: tncPort,
        localAddress: myCall,
        remoteAddress: remote,
        via: via || undefined,
    };
    terminal.writeLine(`(Connecting to ${remote}${viaNote}...)`);
    const newConnection = AGWPE.createConnection(options, function() {
        try {
            terminal.writeLine(`(Connected to ${remote}${viaNote}.)`);
            connected = allConnections[remote] = newConnection;
            startSendingTo(remote, 'I');
            connected.pipe(new Stream.Writable({
                write: function _write(chunk, encoding, callback) {
                    onConnectedData(chunk, encoding, callback);
                },
            }));
        } catch(err) {
            log.error(err);
        }
    });
    newConnection.on('end', function(info) {
        const message = shared.decode(
            showEOL ? info : !info ? ''
                : info.toString('binary').replace(allRemoteEOLs, ''),
            remoteEncoding);
        logLine(message ? message : `(Disconnected from ${remote}.)`);
        delete allConnections[remote];
        if (connected === newConnection) {
            connected = null;
            setDataPrompt();
            setCommandMode(true);
        }
        if (ending && Object.keys(allConnections).length <= 0) {
            process.exit();
        }
    });
    ['error', 'timeout'].forEach(function(event) {
        newConnection.on(event, function(err) {
            terminal.writeLine(`(${event} ${err || ''} from ${remote})`);
            try {
                newConnection.end(); // in case it hasn't already ended.
            } catch(err) {
            }
        });
    });
    return false; // not connected yet. Stay tuned.
} // connect

function disconnect(arg) {
    var remote = (arg || '');
    if (!remote && connected) {
        remote = connected.remoteAddress;
    }
    if (!remote) {
        terminal.writeLine(`(You're not connected.)`);
    } else {
        remote = validateCallSign('remote', remote.toUpperCase());
        var target = allConnections[remote];
        if (!target) {
            terminal.writeLine(`(You're not connected to ${remote}.)`);
        } else {
            logLine(`>${remote} DISC`);
            target.end();
        }
    }
} // disconnect

function setVia(parts) {
    defaultPath = parts[1] && normalizePath(parts[1]);
    validatePath(defaultPath);
}

function showVia(parts) {
    if (parts[1] == '*') {
        terminal.writeLine('pathTo: ' + JSON.stringify(pathTo));
        terminal.writeLine('bestPathTo: ' + JSON.stringify(bestPathTo));
        terminal.writeLine('defaultPath: ' + defaultPath);
        return;
    }
    const remoteAddress = parts[1] && validateCallSign('remote', parts[1]);
    var messages = [];
    if (remoteAddress) {
        const path = pathTo[remoteAddress];
        if (path != null) {
            if (path) {
                messages.push(`The default path to ${remoteAddress} is ${path}.`);
            } else {
                messages.push(`The default is to send directly to ${remoteAddress}, without digipeaters.`);
            }
        }
        const bestPath = bestPathTo[remoteAddress];
        if (bestPath && bestPath.path != null) {
            if (path == null) {
                if (bestPath.path) {
                    messages.push(`The default path to ${remoteAddress} is ${bestPath.path}.`);
                } else {
                    messages.push(`The default is to send directly to ${remoteAddress}, without digipeaters.`);
                }
            } else if (bestPath.counter >= 4
                       && pathLength(bestPath.path) <= pathLength(path)) {
                if (bestPath.path) {
                    messages.push(`It looks like it would be better to communicate`
                                  + ` with ${remoteAddress} via ${bestPath.path}.`);
                } else {
                    messages.push(
                        `It looks like it would be better to communicate`
                            + ` with ${remoteAddress} directly, without digipeaters.`);
                }
            }
        }
    }
    if (defaultPath) {
        messages.push(`The default path to a new station is ${defaultPath}.`);
    }
    if (messages.length) {
        messages.forEach(function(message, m) {
            var line = (m == 0 ? '( ' : '  ')
                + message
                + (m == messages.length - 1 ? ')' : '');
            terminal.writeLine(line);
        });
    } else {
        terminal.writeLine('(The default is to communicate directly, without digipeaters.)');
    }
}

function hide(parts) {
    for (var p = 1; p < parts.length; ++p) {
        var part = parts[p];
        switch(part.charAt(0)) {
        case '<':
            hiddenSources[validateCallSign('source', part.substring(1))] = true;
            break;
        case '>':
            hiddenDestinations[validateCallSign('destination', part.substring(1))] = true;
            break;
        default:
            terminal.writeLine(`Do you mean >${part} (destination) or <${part} (source)?`);
        }
    }
}

function show(parts) {
    for (var p = 1; p < parts.length; ++p) {
        var part = parts[p];
        switch(part.charAt(0)) {
        case '<':
            delete hiddenSources[validateCallSign('source', part.substring(1))];
            break;
        case '>':
            delete hiddenDestinations[validateCallSign('destination', part.substring(1))];
            break;
        default:
            terminal.writeLine(`Do you mean >${part} (to) or <${part} (from)?`);
        }
    }
}

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
    validatePath(defaultPath);
    remoteAddress = args._[1] ? validateCallSign('remote', args._[1]) : null;
    if (ESC && ESC.length > 1) {
        throw shared.newError(
            `--escape must specify a single character (not ${JSON.stringify(ESC)}).`,
            'ERR_INVALID_ARG_VALUE');
    }
    log.debug('%s', {
        verbose: verbose,
        myCall: myCall,
        tncPort: tncPort,
        remoteEOL: remoteEOL,
    });
    terminal.on('error', function(err) {
        terminal.writeLine(err);
    });
    terminal.on('SIGTERM', process.exit);
    initialize();
    ['close', 'SIGINT'].forEach(function(event) {
        terminal.on(event, function(info) {
            bye();
        });
    });
} catch(err) {
    log.error(err);
    showUsage(1);
}
