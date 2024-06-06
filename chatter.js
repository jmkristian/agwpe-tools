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
    'boolean': ['debug', 'show-controls', 'show-eol', 'show-time', 'show-timestamp', 'timestamp',
                'trace', 'verbose', 'v'],
    'string': ['encoding', 'eol', 'escape', 'hide-eol', 'port', 'tnc-port', 'tncport',
               'xecute', 'x'],
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
function validatePath(p) {
    if (p) p.split(/[\s,]+/).forEach(function(c) {validateCallSign('digipeater', c);});
}
var defaultPath = undefined;

const terminal = new Lines(ESC);
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
        result += validateCallSign('digipeater', parts[p].replace(/\*$/, ''));
    }
    return result;
}

var lastPurgeBetween = Date.now();
const lastPacketBetween = {};
const sec = 1000;
const maxRepetitionTime = 15 * sec;

function isRepetitive(packet) {
    try {
        const now = Date.now();
        const key = validateCallSign('source', packet.fromAddress)
              + '>' + validateCallSign('destination', packet.toAddress);
        const recent = lastPacketBetween[key];
        const current = packet.type
              + ' ' + packet.NR + ' ' + packet.NS
              + ' ' + (packet.P || packet.F)
              + (packet.info ? ' ' + packet.info.toString('binary') : '');
        if (!recent || recent.packet != current) {
            lastPacketBetween[key] = {packet: current, when: now};
        } else if (now - recent.when <= maxRepetitionTime) {
            recent.when = now;
            return true; // repetitive
        }
        if (now - lastPurgeBetween > 120 * sec) {
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
            + (from.via ? ' via ' + from.via : '');
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
                            ` That path has been heard in ${best.counter} packets.)`);
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
        `usage: ${myName} [options] <local call sign> [remote call sign]`,
        `Supported options are:`,
        `--host <address>    : TCP host of the TNC. Default: 127.0.0.1`,
        `--port N            : TCP port of the TNC. Default: 8000`,
        `--tnc-port N        : TNC port (sound card number), in the range 0-255. Default: 0`,
        `--xecute "line;..." : Execute a sequence of command lines immediately.`,
        `--show-controls     : Show unprintable characters (as string literals). Default: false`,
        `--show-eol          : Show end-of-line characters. Default: false`,
        `--show-time         : Show the time when data are sent or received. Default: false`,
        `--verbose           : Show more information about what's happening. Default: false`,
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
        marker += `> ${packet.toAddress}`;
    } else if (packet.toAddress == myCall) {
        marker += `< ${packet.fromAddress}`;
    } else {
        marker += `${packet.fromAddress} > ${packet.toAddress}`;
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
        marker += ' via ' + via.join(',');
    }
    marker += ` ${packet.type} `;
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
    const newPrompt = commandMode ? commandPrompt : dataPrompt;
    log.trace('terminal.prompt(%s)', newPrompt);
    terminal.prompt(newPrompt);
}

function toRemoteLine(line) {
    return shared.encode(line + decodedEOL, remoteEncoding);
}

function logDataSent(packetType, lines, remoteAddress, via) {
    logLines(`> ${remoteAddress}` + (via ? ` via ${via}` : '') + ` ${packetType} `,
             lines.split(allOS_EOLs).map(escapify));
}

function interpret(line) {
    try {
        if (commandMode) {
            execute(line);
        } else if (connected) {
            connected.connection.write(toRemoteLine(line), function sent() {
                logDataSent('I', line, connected.connection.remoteAddress);
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
            terminal.writeLine('(Where to? Enter "u callsign" to set a destination address.)');
            setCommandMode(true);
        }
    } catch(err) {
        log.error(err);
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
        logger: log,
    });
    newServer.on('error', function(err) {
        log.error('server error(%s)', err ? err : '');
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
        allConnections[from] = {connection: connection, received: ''};
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
            if (verbose) {
                terminal.writeLine(`(Listening to TNC port ${newPort}.)`);
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
    // A command line like "c a6call via" specifies no digipeaters.
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
            if (verbose
                || !(isRepetitive(packet) // Call isRepetitive first for its side effect.
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
            showVia(parts);
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
            nextCommandMode = false;
            bye();
            break;
        default:
            terminal.writeLine(command + '?');
            [
                "The available commands are:",
                "u[nproto] callsign [via callsign,...]",
                "          : Send the following data in UI packets to that call sign via",
                "          : those digipeaters.",
                "c[onnect] callsign [via callsign,...]",
                "          : Send the following data in a connection to that call sign via",
                "          : those digipeaters.",
                "d[isconnect] [callsign]",
                "          : Disconnect from that call sign or (with no call sign) disconnect",
                "          : from the station to which you're currently connected.",
                "via [digipeater,...]",
                "          : Set the default list of digipeaters via which to communicate with",
                "          : a new station. If you don't list any digipeaters, the default",
                "          : will be to communicate directly.",
                "via? [callsign]",
                "          : Show the current and default digipeaters via which to communicate",
                "          : with that call sign or (with no call sign) a new call sign.",
                "x[ecute] fileName",
                "          : Read a file and interpret it like input that you type.",
                "heard",
                "          : Show a list of source addresses received recently.",
                "hear number",
                "          : Set the maximum number of source addresses to remember.",
                "hide [<fromCall >toCall ...]",
                "          : Stop showing packets addressed from: fromCall or to: toCall.",
                "show [<fromCall >toCall ...]",
                "          : Resume showing packets addressed from: fromCall or to: toCall.",
                "hide?",
                "          : Show which packets are currently hidden.",
                "b[ye]",
                "          : Close all connections and exit.",
                "",
                "Commands are not case-sensitive.",

            ].forEach(function(line) {
                terminal.writeLine(line);
            });
        }
    } catch(err) {
        if (log.debug()) log.debug(err);
        nextCommandMode = true;
        terminal.writeLine('(' + err + ')');
    }
    setCommandMode(nextCommandMode);
} // execute

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
    if (verbose) {
        const viaNote = via ? ` via ${via}` : '';
        terminal.writeLine(`(Will send UI packets${viaNote} to ${remote}.)`);
    }
    return true;
} // unproto

class Receiver extends Stream.Writable {
    constructor(myConnection) {
        super();
        this.myConnection = myConnection;
    }
    _write(chunk, encoding, callback) {
        try {
            const data = (chunk == null) ? '' : chunk.toString('binary');
            if (log.trace()) {
                log.trace('onConnectedData(%s, %s, %s)', escapify(data), encoding, typeof callback);
            }
            const remoteAddress = this.myConnection.connection.remoteAddress;
            const that = this;
            const remainder = data.replace(eachLine, function(partialLine) {
                const line = that.myConnection.received + partialLine;
                const decoded = shared.decode(Buffer.from(line, 'binary'), remoteEncoding);
                logLines(`< ${remoteAddress} I `, [decoded]);
                that.myConnection.received = '';
                return '';
            });
            this.myConnection.received += remainder;
            if (this.myConnection === connected) {
                setDataPrompt();
            }
            if (commandMode) {
                if (callback) callback();
            } else {
                terminal.prompt(dataPrompt, callback);
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
        if (verbose) {
            const viaNote = existing.via ? ` via ${existing.via}`: '';
            terminal.writeLine(`(Will send I packets to ${remote}${viaNote}.)`);
        }
        return true;
    }
    const via = viaOption(remote, parts);
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
            const myConnection = {connection: newConnection, via: via || '', received: ''};
            connected = allConnections[remote] = myConnection;
            startSendingTo(remote, 'I');
            newConnection.pipe(new Receiver(myConnection));
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

function showAllConnections() {
    Object.keys(allConnections).forEach(function(remoteAddress) {
        const via = allConnections[remoteAddress].via;
        const viaNote = via ? ` via ${via}` : '';
        terminal.writeLine(`connect ${remoteAddress}${viaNote}`);
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
    const newPath = normalizePath(parts[1]);
    validatePath(newPath);
    defaultPath = newPath;
}

function showVia(parts) {
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
                messages.push(`It might be better to send to ${target} ${viaBest}.`);
                messages.push(`That path has been heard in ${best.counter} packets.`);
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

function show(parts) {
    for (var p = 1; p < parts.length; ++p) {
        var part = parts[p];
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
    terminal.on('SIGTERM', process.exit); // exit abruptly
    ['close', 'SIGINT'].forEach(function(event) { // exit gracefully
        terminal.on(event, function(info) {
            bye();
        });
    });
    terminal.on('escape', function() {
        if (commandMode && !(connected || remoteAddress)) {
            terminal.writeLine('(Enter "u <call sign>" or "c <call sign>" to set a destination address.)');
        } else {
            setCommandMode(!commandMode);
        }
    });
    setDataPrompt();
    setCommandMode(!remoteAddress);
    restartServer(tncPort);
    const first = args.xecute || args.x;
    if (first) first.split(';').forEach(interpret);
    terminal.on('line', interpret);
} catch(err) {
    log.error(err);
    showUsage(1);
}
