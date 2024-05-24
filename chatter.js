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
const lastEOL = new RegExp(remoteEOL + '$');
const remoteEncoding = shared.encodingName((args.encoding || 'binary').toLowerCase());
const verbose = args.verbose || args.v;

var allConnections = {};
var tncPort = 0;
var myCall = args._[0];

/** Convert s to a javascript string literal (without the quotation marks.) */
function escapify(s) {
    return s && s
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

function parseVia(via) {
    if (!via) return null;
    const parts = via.trim().split(/[\s,]+/);
    var result = '';
    for (var p = 0; p < parts.length; ++p) {
        parts[p] = parts[p].replace(/\*$/, '');
        AGWPE.validateCallSign('digipeater', parts[p]);
        if (result) result += ',';
        result += parts[p].toUpperCase();
    }
    return result;
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
        `--via <digis>       : a comma-separated list of digipeater call signs.`,
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
    if (!(verbose || packet.type == 'UI')) {
        return;
    }
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
        var line = 'via ';
        for (var v = 0; v < packet.via.length; ++v) {
            if (v > 0) line += ',';
            line += packet.via[v];
        }
        terminal.writeLine(`${marker} ${escapify(line)}`);
    }
    marker += ` ${packet.type}`;
    (packet.info || '').toString(remoteEncoding)
        .replace(lastEOL, '')
        .split(remoteEOL)
        .forEach(function(line) {
            terminal.writeLine(`${marker} ${escapify(line)}`);
        });
}

class Interpreter {

    constructor(terminal, logger) {
        this.terminal = terminal;
        this.log = logger || shared.LogNothing;
        this.commandMode = false;
        this.prompt = 'cmd:';
        this.remoteAddress = args._[1];
        this.via = parseVia(args.via);
        if (this.remoteAddress) AGWPE.validateCallSign('remote', this.remoteAddress);
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
                        var summary = '>' + that.connection.remoteAddress;
                        summary += ' I ' + escapify(info);
                        that.terminal.writeLine(summary);
                    });
                } else {
                    if (that.remoteAddress) {
                        var via = that.via;
                        socket.send({
                            port: tncPort,
                            type: 'UI',
                            toAddress: that.remoteAddress,
                            fromAddress: myCall,
                            via: via ? via.split(/,+/) : undefined,
                            info: Buffer.from(info),
                        }, function sent() {
                            var summary = '>' + that.remoteAddress;
                            if (via) summary += ' via ' + via;
                            summary += ' UI ' + escapify(info);
                            that.terminal.writeLine(summary);
                        });
                    } else {
                        that.terminal.writeLine('(Where to? Enter "u <call sign>" to set a destination address.)');
                        that.commandMode = true;
                        that.terminal.prompt(that.prompt);
                    }
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
        this.terminal.writeLine(`(Listening for connections on TNC port ${tncPort}.)`);
        this.server.listen({
            host: myCall,
            port: tncPort,
        }, function listening() {
        });
    } // restartServer

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
                this.remoteAddress = parts[1].toUpperCase();
                AGWPE.validateCallSign('remote', this.remoteAddress);
                delete this.connection;
                if (verbose) {
                    this.terminal.writeLine(`(Transmit UI packets to ${this.remoteAddress}.)`);
                }
                break;
            case 'c':
            case 'connect':
                this.connect(parts[1].toUpperCase());
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
            case 'v':
            case 'via':
                const newVia = parseVia(parts[1]);
                if (this.via != newVia) {
                    this.via = newVia;
                    if (this.connection) {
                        var remoteAddress = this.connection.remoteAddress.toUpperCase();
                        this.disconnect(null);
                        this.connect(remoteAddress);
                    }
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
                    "U[nproto] <call sign>   : Start sending data in UI packets to the given call sign.",
                    "C[onnect] <call sign>   : Start sending data in a connection to the given call sign.",
                    "V[ia] [<call sign>,...] : Start sending data via the given digipeaters.",
                    "D[isconnect] [call sign]: Disconnect from the given call sign, or (with no call sign)",
                    "                          the station to which you're currently connected.",
                    "P[ort] <number>         : Send and receive data via the given AGWPE port (sound card).",
                    "B[ye]                   : Close all connections and exit.",
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

    connect(remoteAddress) {
        AGWPE.validateCallSign('remote', remoteAddress);
        this.connection = allConnections[remoteAddress];
        if (this.connection) {
            if (verbose) {
                this.terminal.writeLine(`(Transmit I packets to ${remoteAddress}.)`);
            }
        } else {
            const options = {
                host: host,
                port: port,
                localPort: tncPort,
                localAddress: myCall,
                remoteAddress: remoteAddress,
                via: this.via,
            };
            const via = options.via ? ` via ${options.via}` : '';
            this.terminal.writeLine(`(Connecting${via} to ${remoteAddress}...)`);
            const that = this;
            const newConnection = AGWPE.createConnection(options, function connected() {
                try {
                    that.connection = allConnections[remoteAddress] = newConnection;
                    that.connection.pipe(new Stream.Writable({
                        write: function _write(chunk, encoding, callback) {
                            try {
                                chunk.toString(remoteEncoding)
                                    .replace(lastEOL, '')
                                    .split(remoteEOL)
                                    .forEach(function(line) {
                                        that.terminal.writeLine(`<${remoteAddress} I ${escapify(line)}`);
                                    });
                            } catch(err) {
                                that.log.error(err);
                            }
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
                            '(' + escapify(info.toString(remoteEncoding).replace(lastEOL, '')) + ')');
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
            AGWPE.validateCallSign('remote', remoteAddress);
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
    log.debug(JSON.stringify({
        myCall: myCall,
        remoteEOL: remoteEOL,
        verbose: verbose,
    }));
    AGWPE.validateCallSign('local', myCall);
    tncPort = AGWPE.validatePort(args['tnc-port'] || args.tncport || 0);
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
        if (packet.port == tncPort) {
            summarize(packet, terminal);
        }
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
