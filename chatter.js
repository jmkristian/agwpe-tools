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
    'boolean': ['debug', 'trace', 'verbose', 'v'],
    'string': ['encoding', 'eol', 'escape', 'port', 'tnc-port', 'tncport', 'via'],
});
const log = Bunyan.createLogger({
    name: 'chatter',
    level: args.trace ? Bunyan.TRACE : args.debug ? Bunyan.DEBUG : Bunyan.INFO,
    stream: bunyanFormat({outputMode: 'short', color: false}, process.stderr),
});
const controlCharacters = new RegExp('[\x00-\x1F]|[\x7F-\uFFFF]', 'g');
const ESC = (args.escape == undefined) ? '\x1D' // GS = Ctrl+]
      : shared.fromASCII(args.escape);
const frameLength = parseInt(args['frame-length'] || '128');
const host = args.host || '127.0.0.1'; // localhost, IPv4
const port = args.port || args.p || 8000;
const remoteEOL = shared.fromASCII(args.eol) || '\r';
const remoteEncoding = shared.encodingName((args.encoding || 'binary').toLowerCase());
const verbose = args.verbose || args.v;

var allConnections = {};
var bestPathTo = {};
var myCall = '';
var tncPort = 0;
var lastPacketBetween = {};

/** Convert s to a javascript string literal (without the quotation marks.) */
function escapify(s) {
    return s && s
        .replace(/\\/g, '\\\\')
        .replace(/\r/g, '\\r')
        .replace(/\n/g, '\\n')
        .replace(controlCharacters, function(c) {
            const code = c.charCodeAt(0);
            if (code <= 0xFF) {
                return '\\x' + (code + 0x100).toString(16).substring(1).toUpperCase();
            } else {
                return '\\u' + (code + 0x100000).toString(16).substring(4).toUpperCase();
            }
        });
}

function splitLines(from) {
    if (from == null) return from;
    if (from == '') return [from];
    var into = [];
    var last = null;
    from.split(remoteEOL).forEach(function(line) {
        into.push(line + remoteEOL);
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

function isRepetitive(packet) {
    try {
        const current = packet.type
              + ' ' + packet.NR + ' ' + packet.NS +
              + ' ' + (packet.P || packet.F)
              + (packet.info ? ' ' + packet.info.toString('binary') : '');
        const key = validateCallSign('source', packet.fromAddress)
              + '>' + validateCallSign('destination', packet.toAddress);
        const recent = lastPacketBetween[key];
        if (current == recent) {
            return true; // repetitive
        } else {
            lastPacketBetween[key] = current;
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

function showUsage(exitCode) {
    const arg0 = path.basename(process.argv[0]);
    const myName = arg0 + ((arg0 == 'chatter.exe') ? '' : (' ' + path.basename(process.argv[1])));
    process.stderr.write([
        '', // blank line
        `usage: ${myName} [options] <local call sign> [remote call sign]`,
        `Supported options are:`,
        `--host <address>    : TCP host of the TNC. Default: 127.0.0.1`,
        `--port N            : TCP port of the TNC. Default: 8000`,
        `--tnc-port N        : TNC port (sound card number). range 0-255. Default: 0`,
        `--via <repeater,...>: a comma-separated list of digipeaters via which to relay packets.`,
        `--encoding <string> : encoding of characters exchanged with the remote station. Default: UTF-8`,
        `                      Other supported encodings are "Windows-1252" and "ISO 8859-1".`,
        `--eol <string>      : represents end-of-line to the remote station. Default: CR`,
        `--escape <character>: switches from sending data to entering a command. Default: Ctrl+]`,
        `--verbose           : output more information about what's happening.`,
        '',
    ].join(OS.EOL));
    if (exitCode != null) process.exit(exitCode);
}

function summarize(packet, terminal) {
    var marker = '';
    if (packet.fromAddress == myCall) {
        marker += '>' + packet.toAddress;
    } else if (packet.toAddress == myCall) {
        if (packet.type == 'I' && allConnections[packet.fromAddress]) {
            return; // Don't output it twice.
        }
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
    splitLines((packet.info || '').toString(remoteEncoding)).forEach(function(line) {
        terminal.writeLine(`${marker} ${escapify(line)}`);
    });
}

class Interpreter {

    constructor(terminal, logger) {
        this.terminal = terminal;
        this.log = logger || shared.LogNothing;
        this.commandMode = false;
        this.prompt = 'cmd:';
        this.pathTo = {};
        this.remoteAddress = args._[1];
        if (this.remoteAddress) validateCallSign('remote', this.remoteAddress);
        if (ESC.length > 1) {
            throw shared.newError(
                `--escape must specify a single character (not ${JSON.stringify(ESC)}).`,
                'ERR_INVALID_ARG_VALUE');
        }
        if (verbose) {
            if (this.remoteAddress) {
                this.terminal.writeLine(`(Transmit UI packets to ${this.remoteAddress}.)`);
            }
        }
        const that = this;
        this.terminal.on('escape', function() {
            that.commandMode = !that.commandMode;
            that.terminal.prompt(that.commandMode ? that.prompt : '');
        });
        this.terminal.on('line', function(line) {
            try {
                var info = line + remoteEOL;
                if (that.commandMode) {
                    that.execute(line);
                } else if (that.connection) {
                    that.connection.write(info, function sent() {
                        that.terminal.writeLine(
                            '>' + that.connection.remoteAddress + ' I ' + escapify(info));
                    });
                } else if (that.remoteAddress) {
                    const via = that.getPathTo(that.remoteAddress);
                    socket.send({
                        port: tncPort,
                        type: 'UI',
                        toAddress: that.remoteAddress,
                        fromAddress: myCall,
                        via: via || undefined,
                        info: Buffer.from(info),
                    }, function sent() {
                        that.terminal.writeLine(
                            '>' + that.remoteAddress
                                + (via ? ' via ' + via : '')
                                + ' UI ' + escapify(info));
                    });
                } else {
                    that.terminal.writeLine('(Where to? Enter "u <call sign>" to set a destination address.)');
                    that.commandMode = true;
                    that.terminal.prompt(that.prompt);
                }
            } catch(err) {
                log.error(err);
            }
        });
        this.restartServer();
    }

    restartServer() {
        const that = this;
        if (this.server) this.server.close();
        this.server = new AGWPE.Server({
            host: host,
            port: port,
            logger: log,
        });
        this.server.on('connection', function(connection) {
            const remoteAddress = connection.remoteAddress.toUpperCase();
            allConnections[remoteAddress] = connection;
            that.terminal.writeLine(
                `(Received a connection.`
                    + `The command "C ${remoteAddress}" will start sending data there.)`);
        });
        this.server.on('error', function(err) {
            that.log.error(err);
        });
        this.server.listen({
            host: myCall,
            port: tncPort,
        }, function listening() {
            if (verbose) {
                that.terminal.writeLine(`(Listening for connections on TNC port ${tncPort}.)`);
            }
        });
    } // restartServer

    getPathTo(remoteAddress) {
        var best = bestPathTo[remoteAddress];
        var path = this.pathTo[remoteAddress];
        if (path == null) {
            if (best) path = best.path.join(',');
        } else if (best && best.path.length < path.split(/[\s,]+/).length
                   && [4, 8, 16, 32].indexOf(best.counter) >= 0) {
            this.terminal.writeLine(`(${best.path.join(',')} looks like a better path than ${path}.)`);
        }
        this.log.trace('getPathTo(%s) = %s', remoteAddress, path);
        return path;
    }

    setPathTo(remoteAddress, path) {
        this.log.trace('setPathTo(%s, %s)', remoteAddress, path);
        if (path != null) {
            this.pathTo[remoteAddress] = path;
        }
        return path;
    }

    onPacket(packet) {
        try {
            if (packet.port == tncPort) {
                noteReturnPath(packet);
                if (verbose) {
                    summarize(packet, this.terminal);
                } else {
                    switch(packet.type) {
                    case 'I':
                    case 'UI':
                        summarize(packet, this.terminal);
                        break;
                    default:
                    }
                }
            }
        } catch(err) {
            this.log.error(err);
        }
    }

    viaOption(remoteAddress, parts) {
        // A command line like "c a6call via" specifies no repeaters.
        // But "c a6call" means use a recent path or the best observed path.
        if (parts.length < 3 || parts[2].toLowerCase() != 'via') {
            return this.getPathTo(remoteAddress);
        } else {
            return this.setPathTo(remoteAddress, parseVia(parts[3]) || '');
        }
    }

    execute(command) {
        this.log.trace(`cmd:${command}`);
        try {
            const that = this;
            const parts = command.trim().split(/\s+/);
            this.commandMode = false;
            switch(parts[0].toLowerCase()) {
            case '':
                break;
            case 'u':
            case 'ui':
            case 'unproto':
                this.unproto(parts);
                break;
            case 'c':
            case 'connect':
                this.connect(parts);
                break;
            case 'd':
            case 'disconnect':
                this.disconnect(parts[1]);
                break;
            case 'p':
            case 'port':
                const newPort = AGWPE.validatePort(parts[1] || '0');
                if (tncPort != newPort) {
                    tncPort = newPort;
                    this.restartServer();
                }
                if (verbose) {
                    this.terminal.writeLine(`(Communicating via TNC port ${tncPort}.)`);
                }
                break;
            case 'b':
            case 'bye':
                this.bye();
                break;
            default:
                this.terminal.writeLine(command + '?');
                [
                    "The available commands are:",
                    "U[nproto] <call sign> [via <call sign>,...]",
                    "          : Start sending data in UI packets to",
                    "          : this call sign via these digipeaters.",
                    "C[onnect] <call sign> [via <call sign>,...]",
                    "          : Start sending data in a connection to",
                    "          : this call sign via these digipeaters.",
                    "D[isconnect] [call sign]",
                    "          : Disconnect from this call sign or,",
                    "          : (with no call sign) disconnect from the",
                    "          : station to which you're currently connected.",
                    "P[ort] <number>",
                    "          : Send and receive data via this AGWPE port (sound card).",
                    "B[ye]",
                    "          : Close all connections and exit.",
                ].forEach(function(line) {
                    that.terminal.writeLine(line);
                });
                this.commandMode = true;;
            }
        } catch(err) {
            this.log.error(err);
            this.commandMode = true;;
        }
        this.terminal.prompt(this.commandMode ? this.prompt : '');
    } // execute

    unproto(parts) {
        const remoteAddress = validateCallSign('remote', parts[1]);
        const via = this.viaOption(remoteAddress, parts);
        this.remoteAddress = remoteAddress;
        if (verbose) {
            const viaNote = via ? ` via ${via}` : '';
            this.terminal.writeLine(`(Transmit UI packets${viaNote} to ${remoteAddress}.)`);
        }
    } // unproto

    connect(parts) {
        const remoteAddress = validateCallSign('remote', parts[1]);
        const via = this.viaOption(remoteAddress, parts);
        const viaNote = via ? ` via ${via}` : '';
        this.connection = allConnections[remoteAddress];
        if (this.connection) {
            if (verbose) {
                this.terminal.writeLine(`(Transmit I packets${viaNote} to ${remoteAddress}.)`);
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
            this.terminal.writeLine(`(Connecting${viaNote} to ${remoteAddress}...)`);
            const that = this;
            const newConnection = AGWPE.createConnection(options, function connected() {
                try {
                    that.connection = allConnections[remoteAddress] = newConnection;
                    that.connection.pipe(new Stream.Writable({
                        write: function _write(chunk, encoding, callback) {
/* We must consume the received data, but this.onPacket will log it.
                            try {
                                splitLines(chunk.toString(remoteEncoding)).forEach(function(line) {
                                    that.terminal.writeLine(`<${remoteAddress} I ${escapify(line)}`);
                                });
                            } catch(err) {
                                that.log.error(err);
                            }
*/
                            if (callback) callback();
                        },
                    }));
                    that.terminal.writeLine(`(Connected to ${remoteAddress}.)`);
                } catch(err) {
                    that.log.error(err);
                }
            });
            ['end'].forEach(function(event) {
                newConnection.on(event, function(info) {
                    if (info) {
                        that.terminal.writeLine(
                            '(' + escapify(info.toString(remoteEncoding)) + ')');
                    } else if (verbose) {
                        that.terminal.writeLine(`(Disconnected from ${remoteAddress}.)`);
                    }
                    delete allConnections[remoteAddress];
                    if (that.connection === newConnection) {
                        delete that.connection;
                    }
                    if (that.ending && Object.keys(allConnections).length <= 0) {
                        process.exit();
                    }
                });
            });
            ['error', 'timeout'].forEach(function(event) {
                newConnection.on(event, function(err) {
                    that.terminal.writeLine(`(${event} ${err || ''} from ${remoteAddress})`);
                    delete allConnections[remoteAddress];
                    if (that.connection === newConnection) {
                        delete that.connection;
                    }
                });
            });
        }
    } // connect

    disconnect(arg) {
        var remoteAddress = (arg || '').toUpperCase();
        if (!remoteAddress && this.connection) {
            remoteAddress = this.connection.remoteAddress.toUpperCase();
        }
        if (!remoteAddress) {
            this.terminal.writeLine(`(You're not connected.)`);
        } else {
            validateCallSign('remote', remoteAddress);
            var target = allConnections[remoteAddress];
            if (!target) {
                this.terminal.writeLine(`(You haven't connected to ${remoteAddress}.)`);
            } else {
                this.terminal.writeLine(`>${remoteAddress} DISC`);
                target.end();
            }
        }
    } // disconnect

    bye() {
        try {
            for (var remoteAddress in allConnections) {
                this.ending = true;
                allConnections[remoteAddress].end();
            }
            if (this.ending) {
                setTimeout(process.exit, 10000);
            } else {
                process.exit();
            }
        } catch(err) {
            this.log.error(err);
        }
    } // bye
} // Interpreter

try {
    myCall = validateCallSign('local', args._[0]);
    tncPort = AGWPE.validatePort(args['tnc-port'] || args.tncport || 0);
    log.debug('%s"', {
        verbose: verbose,
        myCall: myCall,
        tncPort: tncPort,
        remoteEOL: remoteEOL,
    });
    const terminal = new Lines(ESC, log);
    terminal.on('SIGTERM', process.exit);
    const interpreter = new Interpreter(terminal, log);
    ['close', 'SIGINT'].forEach(function(event) {
        terminal.on(event, function(info) {
            interpreter.bye();
        });
    });
    const socket = AGWPE.raw.createSocket({
        host: host,
        port: port,
        logger: log,
    }, function connected() {
        if (ESC) terminal.writeLine(`(Type ${shared.controlify(ESC)} to enter a command.)`);
    });
    socket.on('packet', function(packet) {
        interpreter.onPacket(packet);
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
