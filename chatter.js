'use strict';

const AGWPE = require('@jmkristian/node-agwpe');
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
    'boolean': ['debug', 'trace', 'debugTNC', 'traceTNC'],
    'string': ['host', 'port', 'tnc-port', 'tncport', 'frame-length'],
});
var argsCommandIndex = 1; // args._.slice(1) are commands to be executed
const logStream = bunyanFormat({outputMode: 'short', color: false}, process.stderr);
const log = Bunyan.createLogger({
    name: 'chatter',
    level: args.trace ? Bunyan.TRACE : args.debug ? Bunyan.DEBUG : Bunyan.INFO,
    stream: logStream,
});
const agwLogger = Bunyan.createLogger({
    name: 'AGWPE',
    level: args.traceTNC ? Bunyan.TRACE : args.debugTNC ? Bunyan.DEBUG : Bunyan.INFO,
    stream: logStream,
});
const allControls = new RegExp('[\x00-\x1F]|[\x7F-\u00A0]', 'g');
const allOS_EOLs = new RegExp(OS.EOL, 'g');
var escape = '\x1D'; // GS = Ctrl+]
const frameLength = parseInt(args['frame-length'] || '128');
const host = args.host || '127.0.0.1'; // localhost, IPv4
const port = args.port || args.p || 8000;
var showControls = false;
var showEOL = false;
var remoteEOL = undefined;
var allRemoteEOLs = undefined;
var eachLine = undefined;
var remoteEncoding = shared.encodingName('iso-8859-1');
var showRepeats = false;
var showTime = false;
var showVia = true;
var myID = undefined;

var allConnections = {};
var bestPathTo = {};
var pathTo = {};
var myCall = '';
var tncPort = 0;
var heard = [];
var heardLimit = 30;
const hiddenTypes = {
    RR: true,
    RNR: true,
    REJ: true,
    SREJ: true,
    UA: true,
};

var hiddenSources = {};
var hiddenDestinations = {};

function pathLength(path) {
    return path ? path.split(/[\s,]+/).length : 0;
}
function normalizePath(p) {
    return p && p.replace(/\s/g, '').replace(/,+/g, ',').toUpperCase();
}
var defaultPath = undefined;

const terminal = new Lines(function(line, callback){
    interpret(line, callback);
}, escape);
terminal.on('debug', function(message) {
    log.debug('terminal ' + message);
});
terminal.on('error', function(err) {
    log.error(err);
    setTimeout(function() {
        terminal.writeLine(); // prompt
    }, 2);
});
var commandMode = true;
const commandPrompt = 'cmd: ';
var dataPrompt = '';
var hasEscaped = false;
var connected = null;
var remoteAddress = null;
var server = null;
var rawSocket = null;
var ending = false;

/** Convert s to a javascript string literal (without the quotation marks.) */
function escapify(s) {
    var result = (s == null) ? '' : s.toString('binary');
    if (!showEOL) result = result.replace(allRemoteEOLs, '');
    if (!showControls) result = result.replace(allControls, function(c) {
        return (c == remoteEOL) ? c : '';
    });
    return result
        .replace(/\\/g, '\\\\')
        .replace(/\r/g, '\\r')
        .replace(/\n/g, '\\n')
        .replace(allControls, function(c) {
            const code = c.charCodeAt(0);
            if (code <= 0xFF) {
                return '\\x' + (code + 0x100).toString(16).substring(1).toUpperCase();
            } else {
                return '\\u' + (code + 0x100000).toString(16).substring(2).toUpperCase();
            }
        });
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

var lastPurgeBetween = Date.now();
const lastPacketBetween = {};
const sec = 1000;
const maxRepetitionTime = 15 * sec;
const fakeNR = '?';
var fakeNS = 0;

function packetDigest(packet) {
    return packet.type
        + ' ' + packet.NR
        + ' ' + packet.NS
        + ' ' + (packet.P || packet.F)
        + (packet.info ? ' ' + packet.info.toString('binary') : '');
}

function hideRepeat(packet) {
    try {
        const now = Date.now();
        const key = validateCallSign('source', packet.fromAddress)
              + '>' + validateCallSign('destination', packet.toAddress);
        const recent = lastPacketBetween[key];
        const current = packetDigest(packet);
        const currentSent = recent && packetDigest({
            type: packet.type,
            NR: fakeNR,
            NS: fakeNS,
            info: packet.info,
        });
        lastPacketBetween[key] = {packet: current, when: now};
        if (recent
            && now - recent.when <= maxRepetitionTime
            && (recent.packet == current || recent.packet == currentSent)) {
            return !showRepeats;
        }
        if (now - lastPurgeBetween > 120 * sec) {
            // delete obsolete items:
            lastPurgeBetween = now;
            Object.keys(lastPacketBetween).forEach(function(key) {
                if (now - lastPacketBetween[key].when > 2 * maxRepetitionTime) {
                    delete lastPacketBetween[key];
                }
            });
        }
    } catch(err) {
        log.warn(err);
    }
    return false; // show this packet
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

function padString(s, length) {
    var t = s;
    while (t.length < length) {
        t += ' ';
    }
    return t;
}

function showHeard() {
    var lines = heard.map(function(from) {
        const d = new Date(from.when);
        return pad2(d.getMonth())
            + '/' + pad2(d.getDate())
            + '/' + d.getFullYear()
            + ' ' + pad2(d.getHours())
            + ':' + pad2(d.getMinutes())
            + ':' + pad2(d.getSeconds())
            + ' ' + padString(from.fromAddress, 9)
            + ((showVia && from.via) ? ' via ' + from.via : '');
    }).forEach(function(line) {
        terminal.writeLine(line);
    });
}

function noteReturnPath(packet) {
    try {
        const fromAddress = validateCallSign('source', packet.fromAddress);
        if (fromAddress == myCall) {
            return;
        }
        heard = heard.filter(function(item) { // remove fromAddress from heard
            return item.fromAddress != fromAddress;
        });
        heard.push({
            fromAddress: fromAddress,
            via: (packet.via && packet.via.length) ? packet.via.join(',') : null,
            when: new Date().getTime(),
        });
        while (heard.length > heardLimit) {
            heard.shift();
        }
        // Construct a path from here to fromAddress:
        var newPath = '';
        var newPathLength = 0;
        const via = packet.via;
        if (via) {
            for (var v = 0; v < via.length; ++v) {
                var repeater = via[v];
                if (repeater.endsWith('*')) { // This repeater forwarded this packet.
                    // Insert it into the path:
                    newPath = repeater.substring(0, repeater.length - 1)
                        + (newPath && ',') + newPath;
                    ++newPathLength;
                } else {
                    // We received this packet directly from the last repeater (if any).
                    break; // Look no further.
                }
            }
        }
        // Maybe this packet can tell us the repeaters for an active connection.
        const connection = allConnections[fromAddress];
        if (connection && connection.via == undefined // we don't know yet
            && ['I', 'RR', 'RNR', 'REJ', 'SREJ'].indexOf(packet.type) >= 0)
        {
            connection.via = newPath || '';
        }
        // Is this path better than the best we've seen so far?
        for (var target = fromAddress; newPathLength >= 0; --newPathLength) {
            // log.debug('%s via %s?', target, newPath);
            const best = bestPathTo[target];
            // That might be undefined, '' (definitely direct) or a list of repeaters.
            if (best == undefined || (newPath != best.path && newPathLength <= pathLength(best.path))) {
                bestPathTo[target] = {path: newPath, counter: 1};
                log.debug('bestPathTo[%s] = %j', target, bestPathTo[target]);
            } else if (newPath == best.path) {
                best.counter++;
                log.debug('bestPathTo[%s] = %j', target, best);
                if ([4, 8, 16, 32].indexOf(best.counter) >= 0) {
                    const current = pathTo[target];
                    if (current != undefined && current != best.path) {
                        const viaBest = best.path ? `via ${best.path}` : 'directly';
                        const viaCurrent = current ? `via ${current}` : 'directly';
                        terminal.writeLine(
                            `(Sending to ${target} ${viaBest} might be better than ${viaCurrent}.`);
                        terminal.writeLine(
                            ` The shorter path was heard in ${best.counter} packets.)`);
                     }
                }
            }
            // Next, consider the path to one of the repeaters:
            target = newPath.replace(/.*,/, '');
            newPath = (newPathLength == 1) ? '' : newPath.replace(/,[^,]*$/, '');
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
        var s = line;
        if (showTime) {
            const now = new Date();
            s = pad2(now.getHours())
                + ':' + pad2(now.getMinutes())
                + ':' + pad2(now.getSeconds())
                + ' ' + s;
        }
        terminal.writeLine(s, callback);
    } catch(err) {
        if (callback) callback(err);
    }
}

function logLines(prefix, lines, callback) {
    log.trace('logLines(%s, %j, %s)', prefix, lines, typeof callback);
    var next = 0;
    const logNextLine = function logNextLine(err) {
        if (err) {
            if (callback) callback(err);
        } else if (next < lines.length) {
            const line = escapify(lines[next++]);
            logLine(`${prefix}${line}`, logNextLine);
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
        `Usage: ${myName} [options] <local call sign> [command command ...]`,
        `Supported options are:`,
        `--host <address> : TCP host of the TNC. Default: 127.0.0.1`,
        `--port N         : TCP port of the TNC. Default: 8000`,
        `--tnc-port N     : TNC port (sound card number), in the range 0-255. Default: 0`,
        '',
    ].join(OS.EOL));
    if (exitCode != null) process.exit(exitCode);
}

function logPacketReceived(packet, callback) {
    log.trace('logPacketReceived(%s, %s)', packet, typeof callback);
    var marker = '';
    if (packet.fromAddress == myCall) {
        marker += `> ${packet.toAddress}`;
    } else if (packet.toAddress == myCall) {
        marker += `< ${packet.fromAddress}`;
    } else {
        marker += `${packet.fromAddress} > ${packet.toAddress}`;
    }
    if (showVia && packet.via && packet.via.length) {
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
        marker += ' via ' + via.join(',');
    }
    marker += ` ${packet.type} `;
    const info = packet.type == 'XID'
          ? shared.hexBuffer(packet.info)
          : shared.decode(packet.info, remoteEncoding) || '';
    var lines = [];
    var last = null;
    info.split(remoteEOL).forEach(function(line) {
        last = line;
        lines.push(line + remoteEOL);
    });
    if (lines.length > 1 && last == '') {
        lines.pop(); // info ended with remoteEOL
    } else {
        lines[lines.length - 1] = last; // without remoteEOL
    }
    logLines(marker, lines, callback);
}

function setCommandMode(newMode) {
    if (commandMode != newMode) {
        if (commandMode && !hasEscaped) {
            hasEscaped = true;
            terminal.writeLine(`(Enter data to send to ${remoteAddress}`
                               + (escape ? `, or ${shared.controlify(escape)} to enter a command` : '')
                               + '.)');
        }
        commandMode = newMode;
    }
    const newPrompt = commandMode ? commandPrompt : dataPrompt;
    log.trace('terminal.setPrompt(%s)', newPrompt);
    terminal.setPrompt(newPrompt);
}

function toRemoteLine(line) {
    return shared.encode(line + remoteEOL, remoteEncoding);
}

function noteVia(via) {
    if (!showVia) return '';
    if (!via) return '';
    if (Array.isArray(via)) {
        if (via.length <= 0) return '';
        return ` via ${via.join(',')}`;
    }
    return ` via ${via}`;
}

function logSent(packetType, line, remoteAddress, via) {
    logLines(`> ${remoteAddress}`
             + noteVia(via)
             + ` ${packetType} `,
             [line]);
}

function interpret(line, callback) {
    try {
        if (commandMode) {
            execute(line);
            if (callback) callback();
        } else if (connected) {
            log.debug(`send I ${line}`);
            const packet = {
                type: 'I',
                toAddress: remoteAddress,
                fromAddress: myCall,
                NR: fakeNR,
                NS: ++fakeNS,
                info: toRemoteLine(line),
            };
            hideRepeat(packet);
            connected.connection.write(packet.info, function sent() {
                logSent('I', line, connected.connection.remoteAddress);
                if (callback) callback();
            });
        } else if (remoteAddress) {
            log.debug(`send UI ${line}`);
            const via = getPathTo(remoteAddress);
            const packet = {
                port: tncPort,
                type: 'UI',
                toAddress: remoteAddress,
                fromAddress: myCall,
                via: via || undefined,
                info: toRemoteLine(line),
            };
            hideRepeat(packet);
            rawSocket.write(packet, function sent() {
                logSent('UI', line, remoteAddress, via);
                if (callback) callback();
            });
        } else {
            terminal.writeLine('(Where to? Enter "unproto callsign" to set a destination address.)');
            setCommandMode(true);
            if (callback) callback();
        }
    } catch(err) {
        log.error(err);
        if (callback) callback(err);
    }
}

function restartServer(newPort) {
    if (server) server.close();
    server = null;
    tncPort = null;
    rawSocket = null;
    const newServer = new AGWPE.Server({
        host: host,
        port: port,
        localPort: newPort,
        logger: agwLogger,
    });
    newServer.on('error', function(err) {
        log.error(`Error from TNC ${host}:${port} port ${newPort}`);
        log.error(err);
        process.exit(2);
    });
    newServer.on('close', function closed(err) {
        if (server === newServer) {
            server = null;
            log.error('server closed(%s)', err || '');
        } else {
            log.debug('previous server closed(%s)', err || '');
        }
    });
    newServer.on('connection', function(connection) {
        const from = connection.remoteAddress.toUpperCase();
        watchConnection(connection, from);
        onConnected(connection, from);
        terminal.writeLine(
            `(Received a connection.`
                + ` The command "c ${from}" will start sending data there.)`);
    });
    newServer.listen({
        host: myCall,
        port: newPort,
    }, function listening() {
        if (server && server !== newServer) {
            // Somebody else got there first.
            newServer.destroy();
        } else {
            tncPort = newPort;
            server = newServer;
            terminal.writeLine(`(Listening to TNC port ${newPort}.)`);
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
           while (argsCommandIndex < args._.length) {
                interpret(args._[argsCommandIndex++]);
            }
        }
    });
} // restartServer

function getPathTo(remoteAddress) {
    var path = pathTo[remoteAddress];
    var best = bestPathTo[remoteAddress];
    return (path != null) ? path : best ? best.path : defaultPath;
}

function viaOption(remoteAddress, parts) {
    // A command line like "c a6call via" specifies no digipeaters.
    // But "c a6call" means use pathTo or besPathTo.
    if (parts.length < 3 || parts[2].toLowerCase() != 'via') {
        return getPathTo(remoteAddress);
    } else {
        return (pathTo[remoteAddress] = AGWPE.validatePath(normalizePath(parts[3])));
    }
}

function isDataConnectedToMe(packet) {
    if (packet.type != 'I') { // It's not data.
        return false;
    }
    if (connected && connected.connection.localAddress == packet.toAddress) {
        return true;
    }
    var found = Object.keys(allConnections).filter(function(remoteAddress) {
        return allConnections[remoteAddress].connection.localAddress == packet.toAddress;
    });
    return found.length > 0;
}

function onPacket(packet, callback) {
    try {
        log.trace('onPacket(%s)', packet);
        if (packet.port == tncPort) {
            noteReturnPath(packet);
            if (!(hideRepeat(packet) // Call this first for its side effect.
                  || hiddenTypes[packet.type]
                  || hiddenSources[packet.fromAddress]
                  || hiddenDestinations[packet.toAddress]))
            {
                // Don't log data received on an active connection:
                if (!isDataConnectedToMe(packet)) {
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
        case 'c?':
        case 'connect?':
            showAllConnections();
            break;
        case 'd':
        case 'disconnect':
            disconnect(parts[1]);
            break;
        case 'via':
            setVia(parts);
            break;
        case 'via?':
            showDigipeaters(parts);
            break;
        case 'heard':
            showHeard();
            break;
        case 'hear':
            heardLimit = parseInt(parts[1]);
            while (heard.length > heardLimit) {
                heard.shift();
            }
            break;
        case 'hide':
            hide(parts);
            break;
        case 'show':
            show(parts);
            break;
        case 'hide?':
        case 'hidden?':
            showHidden();
            break;
        case 'set':
            set(parts);
            break;
        case 'x':
        case 'xecute':
        case 'execute':
            if (parts.length < 2) {
                terminal.writeLine('(What file do you want to execute?)');
            } else {
                const fileName = command.replace(/^\s*[^\s]+\s+/, '');
                log.debug(`terminal.readFile(${fileName})`);
                terminal.readFile(fileName);
            }
            break;
        case 'b':
        case 'bye':
            nextCommandMode = false;
            bye();
            break;
        case '?':
        case 'help':
            showCommands();
            break;
        default:
            terminal.writeLine(`(${JSON.stringify(parts[0])} isn't a command. Enter "?" to see a list of commands.)`);
        }
    } catch(err) {
        if (log.debug()) log.debug(err);
        nextCommandMode = true;
        terminal.writeLine('(' + err + ')');
    }
    setCommandMode(nextCommandMode);
} // execute

function showCommands() {
    [
        "The available commands are:",
        "u[nproto] callSign [via callSign,...]",
        "          : Send the following data in UI packets to that call sign via",
        "          : those digipeaters.",
        "c[onnect] callSign [via callSign,...]",
        "          : Send the following data in a connection to that call sign via",
        "          : those digipeaters.",
        "d[isconnect] [callSign]",
        "          : Disconnect from that call sign or (with no call sign) disconnect",
        "          : from the station to which you're currently connected.",
        "via [digipeater,...]",
        "          : Set the default list of digipeaters via which to communicate with",
        "          : a new station. If you don't list any digipeaters, the default",
        "          : will be to communicate directly.",
        "via? [callSign]",
        "          : Show the current and default digipeaters via which to communicate",
        "          : with that call sign or (with no call sign) a new call sign.",
        "x[ecute] fileName",
        "          : Read a file and interpret it like input that you type.",
        "heard     : Show a list of source addresses received recently.",
        "hear number",
        "          : Set the maximum number of source addresses to remember.",
        "hide [<fromCall >toCall ...]",
        "          : Stop showing packets addressed from: fromCall or to: toCall.",
        "hide via  : Stop showing digipeaters.",
        "hide?     : Show which packets are currently hidden.",
        "show [<fromCall >toCall ...]",
        "          : Resume showing things that were previously hidden.", 
        "show time : Show the time when data are sent or received.",
        "show eol  : Show end-of-line characters.",
        "show control",
        "          : Show unprintable characters (as string literals).",
        "show repeats",
        "          : Show packets that are heard repeatedly.",
        "set id <string>",
        "          : sent in a UI packet to ID, at the end of each connection.",
        "          : This is a way to add your FCC call sign to a tactical call sign.",
        "set encoding <string>",
        "          : encoding of characters sent or received. Default: ISO-8859-1",
        "          : Other supported encodings are Windows-1252 and UTF-8.",
        "set eol <string>",
        "          : represents end-of-line in data sent or received. Default: CR",
        "set escape <character>",
        "          : switches between commands and sending data. Default: Ctrl+]",
        "b[ye]     : Close all connections and exit.",
        "",
        "Commands are not case-sensitive.",

    ].forEach(function(line) {
        terminal.writeLine(line);
    });
}

function setDataPrompt() {
    if (connected) {
        const partial = !connected.received ? '' :
              `< ${connected.connection.remoteAddress} I ${connected.received}...`;
        dataPrompt = `${partial}> ${remoteAddress} I: `;
    } else if (remoteAddress) {
        dataPrompt = `> ${remoteAddress} UI: `;
    } else {
        dataPrompt = `> ?: `;
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
    return true;
} // unproto

class Receiver extends Stream.Writable {
    constructor(connection) {
        super();
        this.connection = connection;
    }
    _write(chunk, encoding, callback) {
        try {
            if (chunk && chunk.length > 0) {
                const data = this.connection.received + chunk.toString('binary');
                if (log.trace()) {
                    log.trace('onConnectedData(%s, %s, %s)', escapify(data), encoding, typeof callback);
                }
                const remoteAddress = this.connection.connection.remoteAddress;
                this.connection.received = data.replace(eachLine, function(line) {
                    logLines(`< ${remoteAddress} I `, [
                        shared.decode(Buffer.from(line, 'binary'), remoteEncoding)
                    ]);
                    return '';
                });
                if (this.connection === connected) {
                    setDataPrompt();
                }
                if (commandMode) {
                    if (callback) callback();
                } else {
                    terminal.setPrompt(dataPrompt, callback);
                }
            }
        } catch(err) {
            if (callback) callback(err);
        }
    }
}

function connect(parts) {
    const remote = validateCallSign('remote', parts[1]);
    const existing = allConnections[remote];
    if (existing) {
        connected = existing;
        setDataPrompt();
        startSendingTo(remote, 'I');
        return true;
    }
    const via = viaOption(remote, parts);
    const options = {
        logger: agwLogger,
        host: host,
        port: port,
        localPort: tncPort,
        localAddress: myCall,
        remoteAddress: remote,
        via: via || undefined,
        ID: myID || undefined,
    };
    const viaNote = noteVia(via);
    terminal.writeLine(`(Connecting to ${remote}${viaNote}...)`);
    const newConnection = AGWPE.createConnection(options, function(data) {
        try {
            terminal.writeLine(`(Connected to ${remote}${viaNote}.)`);
            connected = onConnected(newConnection, remote, via);
            startSendingTo(remote, 'I');
        } catch(err) {
            log.error(err);
        }
    });
    watchConnection(newConnection, remote);
    return false; // not connected yet. Stay tuned.
} // connect

function watchConnection(newConnection, remote) {
    ['error', 'timeout'].forEach(function(event) {
        newConnection.on(event, function(err) {
            terminal.writeLine(`(${event} ${err || ''} from ${remote})`);
            try {
                newConnection.end(); // in case it hasn't already ended.
            } catch(err) {
            }
        });
    });
    newConnection.on('end', function(info) {
        const message = info && escapify(shared.decode(info, remoteEncoding));
        logLine(message || `(Disconnected from ${remote}.)`);
        delete allConnections[remote];
        if (connected && (connected.connection === newConnection)) {
            connected = null;
            if (!ending) {
                setDataPrompt();
                setCommandMode(true);
            }
        }
        if (ending && Object.keys(allConnections).length <= 0) {
            // This was the last connection to be closed.
            process.exit();
        }
    });
}

function onConnected(newConnection, remote, via) {
    const myConnection = {connection: newConnection, via: via || '', received: ''};
    allConnections[remote] = myConnection;
    newConnection.pipe(new Receiver(myConnection));
    return myConnection;
}

function showAllConnections() {
    Object.keys(allConnections).forEach(function(remoteAddress) {
        const via = allConnections[remoteAddress].via;
        terminal.writeLine(`connect ${remoteAddress}${noteVia(via)}`);
    });
} // showAllConnections

function disconnect(arg) {
    var remote = (arg || '');
    if (!remote && connected) {
        remote = connected.connection.remoteAddress;
    }
    if (!remote) {
        terminal.writeLine(`(You're not connected.)`);
    } else {
        remote = validateCallSign('remote', remote.toUpperCase());
        var target = allConnections[remote];
        if (!target) {
            terminal.writeLine(`(You're not connected to ${remote}.)`);
        } else {
            logLine(`> ${remote} DISC`);
            target.connection.end();
        }
    }
} // disconnect

function setVia(parts) {
    defaultPath = AGWPE.validatePath(normalizePath(parts[1]));
}

function showDigipeaters(parts) {
    const remoteAddress = parts[1] && validateCallSign('remote', parts[1]);
    var targets = undefined;
    if (remoteAddress) {
        targets = [remoteAddress];
    } else {
        targets = Object.keys(pathTo).concat(Object.keys(bestPathTo)).sort();
        targets = targets.filter(function(target, t) {
            return target != targets[t - 1];
        });
    }
    var messages = [];
    const prefix = targets.length > 1 ?  'Send' : 'The default is to send';
    if (targets.length > 1) {
        messages.push('The defaults are:');
    }
    targets.forEach(function(target) {
        const path = pathTo[target];
        if (path != null) {
            const viaPath = path ? `via ${path}` : 'directly, without digipeaters';
            messages.push(`${prefix} to ${target} ${viaPath}.`);
        }
        const best = bestPathTo[target];
        if (best && best.path != null) {
            const viaBest = best.path ? `via ${best.path}` : 'directly, without digipeaters';
            if (path == null) {
                messages.push(`${prefix} to ${target} ${viaBest}.`);
            } else if (best.counter >= 4 && pathLength(best.path) <= pathLength(path)) {
                messages.push(`(Sending to ${target} ${viaBest} might be better.`);
                messages.push(` The shorter path was heard in ${best.counter} packets.)`);
            }
        }
    })
    const lastNote = messages.length == 0 ? 'The default is to send' : 'Otherwise send';
    if (defaultPath) {
        messages.push(`${lastNote} via ${defaultPath}.`);
    } else {
        messages.push(`${lastNote} directly, without digipeaters.`);
    }
    messages.forEach(function(message) {
        terminal.writeLine(message);
    });
}

function showHidden() {
    if (!(showTime && showEOL && showControls && showRepeats)) {
        var line = 'hide';
        if (!showTime) line += ' time';
        if (!showEOL) line += ' eol';
        if (!showControls) line += ' control';
        if (!showRepeats) line += ' repeats';
        if (!showVia) line += ' via';
        terminal.writeLine(line);
    }
    var keys = Object.keys(hiddenTypes);
    if (keys && keys.length > 0) terminal.writeLine('hide ' + keys.map(function(key) {
        return `.${key}`;
    }).join(' '));
    keys = Object.keys(hiddenDestinations);
    if (keys && keys.length > 0) terminal.writeLine('hide ' + keys.map(function(key) {
        return `>${key}`;
    }).join(' '));
    keys = Object.keys(hiddenSources);
    if (keys && keys.length > 0) terminal.writeLine('hide ' + keys.map(function(key) {
        return `<${key}`;
    }).join(' '));
}

function hide(parts) {
    for (var p = 1; p < parts.length; ++p) {
        var part = parts[p];
        switch(part.toLowerCase()) {
        case 'repeat':
        case 'repeats':
        case 'repeated':
            showRepeats = false;
            break;
        case 'controls':
        case 'control':
        case 'ctrl':
            showControls = false;
            break;
        case 'eol':
        case 'end-of-line':
            showEOL = false;
            break;
        case 'time':
        case 'timestamp':
            showTime = false;
            break;
        case 'via':
            showVia = false;
            break;
        default:
            switch(part.charAt(0)) {
            case '>':
                hiddenDestinations[validateCallSign('destination', part.substring(1))] = true;
                break;
            case '<':
                hiddenSources[validateCallSign('source', part.substring(1))] = true;
                break;
            case '.':
                hiddenTypes[part.substring(1).toUpperCase()] = true;
                break;
            default:
                terminal.writeLine(`Do you mean >${part} (destination) or <${part} (source)?`);
            }
        }
    }
}

function show(parts) {
    for (var p = 1; p < parts.length; ++p) {
        var part = parts[p];
        switch(part.toLowerCase()) {
        case 'repeat':
        case 'repeats':
        case 'repeated':
            showRepeats = true;
            break;
        case 'controls':
        case 'control':
        case 'ctrl':
            showControls = true;
            break;
        case 'eol':
        case 'end-of-line':
            showEOL = true;
            break;
        case 'time':
        case 'timestamp':
            showTime = true;
            break;
        case 'via':
            showVia = true;
            break;
        case 'encoding':
            terminal.writeLine(`encoding ${remoteEncoding}`);
            break;
        case 'esc':
        case 'escape':
            terminal.writeLine(`escape ${shared.controlify(escape)}`);
            break;
        case 'id':
            terminal.writeLine(`ID ${myID || '(none)'}`);
            break;
        default:
            switch(part.charAt(0)) {
            case '>':
                delete hiddenDestinations[validateCallSign('destination', part.substring(1))];
                break;
            case '<':
                delete hiddenSources[validateCallSign('source', part.substring(1))];
                break;
            case '.':
                delete hiddenTypes[part.substring(1).toUpperCase()];
                break;
            default:
                terminal.writeLine(`Do you mean >${part} (to) or <${part} (from)?`);
            }
        }
    }
}

function set(parts) {
    const name = parts[1] && parts[1].toLowerCase();
    var value = parts[2];
    if (!(name && (value || name == 'id'))) {
        throw('usage: set encoding|eol|escape|ID <value>');
    }
    switch(name) {
    case 'encoding':
        value = shared.encodingName(value.toLowerCase());
        shared.validateEncoding(value);
        remoteEncoding = value;
        break;
    case 'eol':
    case 'end-of-line':
        remoteEOL = shared.fromASCII(value);
        allRemoteEOLs = new RegExp(remoteEOL, 'g');
        eachLine = new RegExp('.*' + remoteEOL, 'g');
        break;
    case 'esc':
    case 'escape':
        value = shared.fromASCII(value);
        if (value.length > 1) {
            throw AGWPE.newError(
                `Escape must be a single character (not ${JSON.stringify(value)}).`,
                'ERR_INVALID_ARG_VALUE');
        }
        escape = value;
        terminal.setEscape(escape);
        break;
    case 'id':
        myID = value || undefined;
        break;
    default:
        throw AGWPE.newError(
            `${value}? Settable things are encoding, eol or escape.`,
            'ERR_INVALID_ARG_VALUE');
    }
}

function bye() {
    try {
        dataPrompt = ''; // Don't let our prompt get mixed up with the shell prompt.
        hasEscaped = true;
        setCommandMode(false);
        for (var remoteAddress in allConnections) {
            ending = true;
            allConnections[remoteAddress].connection.end();
            // The 'end' handler for one of the connections will call process.exit.
        }
        if (ending) {
            setTimeout(process.exit, 20 * sec); // just in case something stalls.
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
    set(['set', 'eol', 'CR']);
    log.debug('%s', {
        args: JSON.stringify(args),
        myCall: myCall,
        tncPort: tncPort,
        remoteEOL: remoteEOL,
    });
    terminal.on('SIGTERM', process.exit); // exit abruptly
    ['close', 'SIGINT'].forEach(function(event) { // exit gracefully
        terminal.on(event, function(info) {
            log.debug(`terminal ${event} ${info || ''}`);
            bye();
        });
    });
    terminal.on('escape', function() {
        log.debug('terminal escape');
        if (commandMode && !(connected || remoteAddress)) {
            terminal.writeLine('(Enter "unproto <call sign>" or "connect <call sign>" to set a destination address.)');
        } else {
            setCommandMode(!commandMode);
        }
    });
    setDataPrompt();
    setCommandMode(!remoteAddress);
    restartServer(tncPort);
} catch(err) {
    log.debug(err);
    process.stderr.write(`${err}`);
    showUsage(1);
}
