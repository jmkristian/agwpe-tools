/** A command to communicate via AX.25 in conversational style.
    A connection to another station is initiated. Subsequently, each
    line from stdin is transmitted, and received data are written to
    stdout. A simple command mode enables sending and receiving files.
 */
"use strict";
const AGWPE = require('@jmkristian/node-agwpe');
const Bunyan = require('bunyan');
const bunyanFormat = require('bunyan-format');
const fs = require('fs');
const minimist = require('minimist');
const OS = require('os');
const path = require('path');
const Stream = require('stream');
const util = require('util');

function newError(message, code) {
    const err = new Error(message);
    if (code) err.code = code;
    return err;
}

function fromASCII(s) {
    if (s && s.length == 2 && s.charAt(0) == '^') {
        var code = s.charCodeAt(1);
        while (code >= 32) code = code - 32;
        return String.fromCharCode(code);
    }
    switch(s) {
    case 'ETX': return '\x03';
    case 'EOT': return '\x04';
    case 'CR': return '\r';
    case 'LF': return '\n';
    case 'CR LF': return '\r\n';
    case 'CRLF': return '\r\n';
    case 'FS': return '\x1C';
    case 'GS': return '\x1D';
    default: return s;
    }
}

function encodingName(e) {
    switch(e) {
    case 'cp1252':
    case 'cp-1252':
        return 'windows-1252';
    case 'iso 8859-1':
    case 'iso-8859-1':
    case 'iso_8859-1':
    case 'iso8859-1':
    case 'latin1':
    case 'latin-1':
    case 'cp-819':
    case 'cp819':
        // https://www.rfc-editor.org/rfc/rfc1345.html
        return 'binary';
    case 'utf-8':
        return 'utf8';
    default:
    }
    return e;
}

const args = minimist(process.argv.slice(2), {
    'boolean': ['debug', 'trace', 'debugTNC', 'traceTNC', 'verbose', 'v'],
    'string': ['via'],
});
const localAddress = args._[0];
const localEncoding = 'utf8';
const remoteAddress = args._[1];
const remoteEncoding = encodingName((args.encoding || 'UTF-8').toLowerCase());
const frameLength = parseInt(args['frame-length'] || '128');
const host = args.host || '127.0.0.1'; // localhost, IPv4
const ID = args.ID || args.id;
const localPort = args['tnc-port'] || args.tncport || 0;
const port = args.port || args.p || 8000;
const remoteEOL = fromASCII(args.eol) || '\r';
const verbose = args.verbose || args.v;
const via = args.via;

const ESC = (args.escape == undefined) ? '\x1D' // GS = Ctrl+]
    : fromASCII(args.escape);
const TERM = (args.kill == undefined) ? '\x1C' // FS = Windows Ctrl+Break
      : fromASCII(args.kill);

const SeveralFrames = 4 * frameLength; // The number of bytes in several frames.

const BS = '\x08'; // un-type previous character
const DEL = '\x7F'; // un-type previous character
const EOT = '\x04'; // Ctrl+D = flush line, or EOF at the start of a raw line.
const INT = '\x03'; // Ctrl+C = graceful kill
const prompt = 'cmd:';

const allNULs = new RegExp('\0', 'g');
const allRemoteEOLs = new RegExp(remoteEOL, 'g');
const inputBreak = new RegExp('\r|\n|' + EOT + (ESC ? ('|' + ESC) : ''));

const logStream = bunyanFormat({outputMode: 'short', color: false}, process.stderr);
const log = Bunyan.createLogger({
    name: 'Converse',
    level: args.trace ? Bunyan.TRACE : args.debug ? Bunyan.DEBUG : Bunyan.INFO,
    stream: logStream,
});
const agwLogger = Bunyan.createLogger({
    name: 'AGWPE',
    level: args.traceTNC ? Bunyan.TRACE : args.debugTNC ? Bunyan.DEBUG : Bunyan.INFO,
    stream: logStream,
});
['error', 'timeout'].forEach(function(event) {
    logStream.on(event, function(err) {
        console.error('logStream emitted ' + event + '(' + (err || '') + ')');
    });
});

log.debug('%j', {
    localPort: localPort,
    localAddress: localAddress,
    localEncoding: localEncoding,
    remoteAddress: remoteAddress,
    remoteEncoding: remoteEncoding,
    EOL: remoteEOL,
    ESC: ESC,
    INT: INT,
    TERM: TERM,
});

/** Convert control characters to 'Ctrl+X format. */
function controlify(from) {
    var into = '';
    var wasControl = false;
    for (var f = 0; f < from.length; ++f) {
        var c = from.charCodeAt(f);
        if (c >= 32) {
            if (wasControl) into += ' ';
            into += from.charAt(f);
            wasControl = false;
        } else { // a control character
            if (into) into += ' ';
            into += 'Ctrl+' + String.fromCharCode(c + 64);
            wasControl = true;
        }
    }
    return into;
}

// Windows-1252 is the same as binary (ISO 8859-1), except for:
const decodeWindows1252 = {
    '\u0080': '\u20AC', // EURO SIGN
    '\u0082': '\u201A', // SINGLE LOW-9 QUOTATION MARK
    '\u0083': '\u0192', // LATIN SMALL LETTER F WITH HOOK
    '\u0084': '\u201E', // DOUBLE LOW-9 QUOTATION MARK
    '\u0085': '\u2026', // HORIZONTAL ELLIPSIS
    '\u0086': '\u2020', // DAGGER
    '\u0087': '\u2021', // DOUBLE DAGGER
    '\u0088': '\u02C6', // MODIFIER LETTER CIRCUMFLEX ACCENT
    '\u0089': '\u2030', // PER MILLE SIGN
    '\u008A': '\u0160', // LATIN CAPITAL LETTER S WITH CARON
    '\u008B': '\u2039', // SINGLE LEFT-POINTING ANGLE QUOTATION MARK
    '\u008C': '\u0152', // LATIN CAPITAL LIGATURE OE
    '\u008E': '\u017D', // LATIN CAPITAL LETTER Z WITH CARON
    '\u0091': '\u2018', // LEFT SINGLE QUOTATION MARK
    '\u0092': '\u2019', // RIGHT SINGLE QUOTATION MARK
    '\u0093': '\u201C', // LEFT DOUBLE QUOTATION MARK
    '\u0094': '\u201D', // RIGHT DOUBLE QUOTATION MARK
    '\u0095': '\u2022', // BULLET
    '\u0096': '\u2013', // EN DASH
    '\u0097': '\u2014', // EM DASH
    '\u0098': '\u02DC', // SMALL TILDE
    '\u0099': '\u2122', // TRADE MARK SIGN
    '\u009A': '\u0161', // LATIN SMALL LETTER S WITH CARON
    '\u009B': '\u203A', // SINGLE RIGHT-POINTING ANGLE QUOTATION MARK
    '\u009C': '\u0153', // LATIN SMALL LIGATURE OE
    '\u009E': '\u017E', // LATIN SMALL LETTER Z WITH CARON
    '\u009F': '\u0178', // LATIN CAPITAL LETTER Y WITH DIAERESIS
};
const encodeWindows1252 = function invert(map) {
    var result = {};
    for (var key in map) {
        result[map[key]] = key;
    }
    return result;
}(decodeWindows1252);
const specialWindows1252 = new RegExp('[' + Object.keys(encodeWindows1252).join('') + ']', 'g');

/** Decode a string from a Buffer. */
function decode(buffer, encoding) {
    if (encoding == 'windows-1252') {
        return buffer.toString('binary')
            .replace(/[\u0080-\u009F]/g, function(c) {
                return decodeWindows1252[c] || c;
            });
    } else {
        return buffer.toString(encoding);
    }
}

/** Encode a string into a Buffer. */
function encode(data, encoding) {
    if (encoding == 'windows-1252') {
        return Buffer.from(
            data.replace(specialWindows1252, function(c) {
                return encodeWindows1252[c] || c;
            }),
            'binary');
    } else {
        return Buffer.from(data, encoding);
    }
}

/** A Transform that optionally copies data into a second stream
    (in addition to pushing it). Interpreter.transcribe uses this
    to implement the 't' command.
 */
class Tee extends Stream.Transform {
    constructor() {
        super({
            decodeStrings: false, // Don't convert strings to bytes
            encoding: null, // Don't convert bytes to strings
            // Don't buffer very much data. The writer will
            // handle flow control if the reader is slow.
            readableHighWaterMark: 256,
            writableHighWaterMark: 256,
        });
    }
    _transform(chunk, encoding, callback) {
        this.push(chunk, encoding);
        if (this.copyTo) {
            this.copyTo.write(chunk, encoding, callback);
        } else if (callback) {
            callback();
        }
    }
    _flush(callback) {
        log.trace('Tee._flush');
        if (this.copyTo) {
            this.copyTo.end(undefined, undefined, callback);
        } else if (callback) {
            callback();
        }
    }
}
const terminal = new Tee();
terminal.pipe(process.stdout);

function showUsage(exitCode) {
    const arg0 = path.basename(process.argv[0]);
    const myName = arg0 + ((arg0 == 'converse.exe') ? '' : (' ' + path.basename(process.argv[1])));
    terminal.write([
        '', // blank line
        `usage: ${myName} [options] <local call sign> <remote call sign>`,
        `Supported options are:`,
        `--host <address>: TCP host of the TNC. default: 127.0.0.1`,
        `--port N: TCP port of the TNC. default: 8000`,
        `--tnc-port N: TNC port (sound card number). range 0-255. default: 0`,
        `--via <digis>: A comma-separated list of digipeater call signs.`,
        `--ID <string>: identifies this station, e.g. when the local call sign is tactical.`,
        `--encoding <string>: encoding of characters exchanged with the remote station. default: UTF-8`,
        `  Other supported encodings are "Windows-1252" and "ISO 8859-1".`,
        `--eol <string>: represents end-of-line to the remote station. default: CR`,
        `--escape <character>: switch from conversation to command mode. default: Ctrl+]`,
        `--frame-length N: maximum number of bytes per frame transmitted to the TNC. default: 128`,
        `--verbose: output more information about what's happening.`,
        '',
    ].join(OS.EOL));
    if (exitCode != null) process.exit(exitCode);
}

function assertOneCharacter(value, name, err) {
    if (value && value.length > 1) {
        terminal.write(`The ${name} value must be a single character (not ${controlify(value)}).${OS.EOL}`)
        showUsage(err);
    }
}
assertOneCharacter(ESC, 'escape', 1);
assertOneCharacter(INT, 'interrupt', 3);
assertOneCharacter(TERM, 'kill', 2);

function messageFromAGW(info) {
    return info && info.toString('latin1')
        .replace(allNULs, '')
        .replace(/^[\r\n]*/, '')
        .replace(/[\r\n]*$/, '')
        .replace(/[\r\n]+/g, OS.EOL);
}

function disconnectGracefully(signal) {
    log.debug('disconnectGracefully(%s)', signal || '');
    connection.end(); // should cause a 'close' event, eventually.
    // But in case it doesn't:
    setTimeout(function() {
        log.info(`Connection didn't close.`);
        process.exit(3);
    }, 5000);
}

function hexByte(from) {
    return ((from >> 4) & 0x0F).toString(16) + (from & 0x0F).toString(16)
}

function hexBuffer(buffer) {
    var hex = '';
    for (var f = 0; f < buffer.length; ++f) {
        if (hex) hex += ' ';
        hex += hexByte(buffer[f]);
    }
    return hex;
}

function formatChunk(chunk, encoding) {
    if (Buffer.isBuffer(chunk)) {
        return hexBuffer(chunk);
    } else {
        return util.format('%s %j', encoding, chunk);
    }
}

function logChunk(level, format, chunk, encoding) {
    if (level.apply(log, [])) {
        level.apply(log, [format, formatChunk(chunk, encoding)]);
    }
}

/** A Transform that simply passes data but not 'end'.
    This is used to pipe multiple streams into one.
 */
class DataTo extends Stream.Transform {
    constructor(target, logFormat) {
        super({
            decodeStrings: false, // Don't convert strings to bytes
            encoding: null, // Don't convert bytes to strings
        });
        this.target = target;
        this.logFormat = logFormat;
    }
    _transform(chunk, encoding, callback) {
        try {
            if (this.logFormat) {
                logChunk(log.debug, this.logFormat, chunk, encoding);
            }
            this.target.write(chunk, encoding, callback);
        } catch(err) {
            log.debug(err);
            if (callback) callback(err);
        }
    }
    _flush(callback) {
        if (callback) callback();
        // But don't molest the target.
    }
}

/** A Transform that changes remoteEOL to OS.EOL, and
    optionally copies the original data into a second stream.
 */
class Receiver extends Stream.Transform {
    constructor() {
        super({
            decodeStrings: false, // Don't convert strings to bytes
            emitClose: false,
            encoding: null, // Don't convert bytes to strings
        });
    }
    _transform(chunk, encoding, callback) {
        logChunk(log.debug, '< %s', chunk, encoding);
        var data = Buffer.isBuffer(chunk) ? decode(chunk, remoteEncoding) : chunk;
        if (this.partialEOL && data.startsWith(remoteEOL.charAt(1))) {
            data = data.substring(1);
        }
        if (remoteEOL.length > 1 && data.endsWith(remoteEOL.charAt(0))) {
            data += remoteEOL.substring(1);
            this.partialEOL = true;
        } else {
            this.partialEOL = false;
        }
        data = data.replace(allRemoteEOLs, OS.EOL);
        log.trace('Receiver.push(%j, %s)', data, localEncoding);
        this.push(data, localEncoding);
        if (this.copyTo) {
            this.copyTo.write(chunk, localEncoding, callback);
        } else if (callback) {
            callback();
        }
    }
    _flush(callback) {
        log.trace('Receiver._flush');
        if (this.copyTo) {
            this.copyTo.end(undefined, undefined, callback);
        } else if (callback) {
            callback();
        }
    }
}
const receiver = new Receiver();

/** If the input stream is a TTY, setRawMode and set this.isRaw = true.
    Emit events when input contains INT or TERM.
*/
class Breaker extends Stream.Transform {
    constructor(INT, TERM) {
        super({
            decodeStrings: false, // Don't convert strings to bytes
            encoding: null, // Don't convert bytes to strings
            readableHighWaterMark: 128,
            writableHighWaterMark: 128,
        });
        this.INT = INT;
        this.TERM = TERM;
        if (INT || TERM) {
            this.pattern = new RegExp(`${INT}|${TERM}`, 'g');
        }
        const that = this;
        this.on('pipe', function(from) {
            that.isRaw = false;
            try {
                if (from.isTTY) {
                    if (from.setEncoding) from.setEncoding(localEncoding);
                    if (from.setRawMode) {
                        from.setRawMode(true);
                        that.isRaw = true;
                    }
                }
            } catch(err) {
                that.log.warn(err);
            }
        });
    }
    _transform(chunk, encoding, callback) {
        logChunk(log.trace, 'Breaker._transform(%s)', chunk, encoding);
        var result = Buffer.isBuffer(chunk) ? chunk.toString(localEncoding) : chunk;
        if (this.pattern) {
            const that = this;
            result = result.replace(this.pattern, function(found) {
                if (found == that.INT) that.emit('SIGINT');
                else if (found == that.TERM) that.emit('SIGTERM');
                return '';
            });
        }
        this.push(result, localEncoding);
        if (callback) callback();
    }
} // Breaker

/** Handle input from stdin. When conversing, pipe it (to a connection).
    Otherwise interpret it as commands. We trust that conversation data
    may come fast (e.g. from copy-n-paste), but command data come slowly
    from a human being or a short script. Otherwise input may be lost,
    since we have flow control via pipe to a connection, but not flow
    control via write to stdout.
*/
class Interpreter extends Stream.Transform {
    constructor(terminal) {
        super({
            decodeStrings: false, // Don't convert strings to bytes
            encoding: null, // Don't convert bytes to strings
            emitClose: false,
            readableHighWaterMark: SeveralFrames,
            writableHighWaterMark: SeveralFrames,
        });
        const that = this;
        this.log = log;
        this.terminal = terminal;
        this.isConversing = true;
        this.exBuf = [];
        this.inBuf = '';
        this.cursor = 0;
        this.on('pipe', function(from) {
            that.isRaw = from.isRaw;
        });
        if (!this.isConversing) this.outputData(prompt);
    }
    _transform(chunk, encoding, callback) {
        //logChunk(log.trace, 'Interpreter._transform(%s)', chunk, encoding);
        this.exBuf.push(Buffer.isBuffer(chunk) ? chunk.toString(localEncoding) : chunk);
        this.flushExBuf(callback);
    }
    _flush(callback) {
        this.flushExBuf(callback);
    }
    flushExBuf(callback) {
        if (callback) this.exBuf.push(callback);
        while (this.exBuf.length > 0 && !this.isWaiting) {
            var item = this.exBuf.shift();
            if ((typeof item) == 'function') {
                item(); // callback
            } else if (item) {
                this.parseInput(item);
            }
        }
    }
    outputData(data) {
        if (this.isConversing) {
            const chunk = encode(data, remoteEncoding);
            logChunk(log.debug, '> %s', chunk);
            this.push(chunk);
        } else {
            this.terminal.write(data);
        }
    }
    outputLine(line) {
        this.terminal.write((line != null ? line : '') + OS.EOL);
    }
    parseInput(input) {
        log.trace('Interpreter.parseInput(%s)', input);
        this.inBuf += input;
        if (EOT) {
            const eot = this.inBuf.indexOf(EOT);
            if (eot == 0 && this.isRaw) {
                this.log.debug('EOT raw = end of file');
                this.inBuf = '';
                this.end(); // end of file
            } else if (eot >= 0) { // flush partial line
                this.log.debug('EOT');
                if (this.isConversing) {
                    this.outputData(this.inBuf.substring(0, eot));
                    this.inBuf = this.inBuf.substring(eot + EOT.length);
                } else {
                    this.inBuf = this.inBuf.substring(0, eot)
                        + this.inBuf.substring(eot + EOT.length);
                }
            }
        }
        for (var brk; brk = this.inBuf.match(inputBreak); ) {
            var end = brk.index;
            brk = brk[0];
            switch(brk) {
            case '\n':
                if (end == 0 && this.foundCR) {
                    // Skip this '\n':
                    this.foundCR = false;
                    this.inBuf = this.inBuf.substring(1);
                    break;
                }
                // Don't break; continue with:
            case '\r':
                this.foundCR = (brk == '\r');
                var line = this.inBuf.substring(0, end);
                if (this.isRaw) {
                    var echo = (line + OS.EOL).substring(this.cursor);
                    this.log.trace('Interpreter echo %j', echo);
                    this.terminal.write(echo);
                }
                if (this.isConversing) {
                    this.outputData(line + remoteEOL);
                } else {
                    this.executeCommand(line);
                }
                this.cursor = 0;
                this.inBuf = this.inBuf.substring(end + 1);
                break;
            default: // ESC
                this.log.debug('ESC %j', brk);
                if (this.isConversing) {
                    this.outputData(this.inBuf.substring(0, end));
                    this.inBuf = this.inBuf.substring(end + brk.length);
                    this.isConversing = false;
                    this.cursor = 0;
                    this.outputLine(OS.EOL + (
                        verbose ? `(Pausing conversation with ${remoteAddress}.)` : ''));
                    this.outputData(prompt);
                } else { // already in command mode
                    // Ignore the ESC:
                    this.inBuf = this.inBuf.substring(0, end)
                        + this.inBuf.substring(end + brk.length);
                }
            }
        }
        if (this.isRaw) {
            while (this.inBuf.endsWith(BS) || this.inBuf.endsWith(DEL)) {
                this.inBuf = this.inBuf.substring(0, this.inBuf.length - BS.length - 1);
            }
            var echo = '';
            for ( ; this.cursor > this.inBuf.length; --this.cursor) {
                echo += BS + ' ' + BS;
            }
            if (this.cursor < this.inBuf.length) {
                echo += this.inBuf.substring(this.cursor);
                this.cursor = this.inBuf.length;
            }
            if (echo) this.terminal.write(echo);
        }
    } // parseInput
    executeCommand(line) {
        const that = this;
        try {
            this.log.debug('executeCommand(%j)', line);
            if (!this.isRaw) {
                this.terminal.write(line + OS.EOL);
            }
            const found = line.trim().match(/([^\s]+)\s*(.*)/);
            const verb = found ? found[1].toLowerCase() : '';
            const arg = found && found[2];
            switch (verb) {
            case '': // do nothing
                break;
            case 'b': // disconnect
                connection.end();
                return; // no prompt
            case 'c': // converse
                if (verbose) {
                    var message = `(Resuming conversation with ${remoteAddress}.`;
                    if (ESC) {
                        message += ` Type ${controlify(ESC)} to pause the conversation.`;
                    }
                    this.outputLine(message + ')' + OS.EOL);
                }
                this.isConversing = true;
                return; // no prompt
            case 'r': // receive a file
                this.receiveFile(arg);
                break;
            case 's': // send a file
                this.sendFile(arg);
                break;
            case 't':
                this.transcribe(arg);
                break;
            case 'w': // wait
                if (arg) {
                    const secs = parseInt(arg);
                    if (isNaN(secs)) {
                        throw newError(`${arg} isn't an integer.`,
                                       'ERR_INVALID_ARG_VALUE');
                    }
                    this.outputLine(`Wait for ${secs} seconds ...`);
                    setTimeout(function(that) {
                        that.outputData(OS.EOL + prompt);
                        that.isWaiting = false;
                        that.flushExBuf();
                    }, secs * 1000, this);
                } else {
                    this.outputLine(`Wait until ${remoteAddress} disconnects ...`);
                }
                this.isWaiting = true;
                return; // no prompt
            case 'x':
                this.outputData(prompt); // first, then:
                this.execute(arg);
                return; // no prompt
            case '?':
            case 'h': // show all available commands
                this.outputLine([
                    'Available commands are:',
                    'B: disconnect from the remote station.',
                    'C: converse with the remote station.',
                    'R [file name]: receive a binary file from the remote station',
                    '  If no file name is given, stop receiving to the file.',
                    'S [file name]: send a binary file to the remote station.',
                    '  If no file name is given, stop sending from the file.',
                    'T [file name]: save a copy of all output to a file.',
                    '  If no file name is given, stop saving the output.',
                    'X [file name]: take input from a file.',
                    'W [N]: wait for N seconds.',
                    '  If N is not given, wait until disconnected.',
                    '',
                    'Commands are not case-sensitive.',
                    '',].join(OS.EOL));
                break;
            default:
                this.outputLine(`${line}?${OS.EOL}Type H to see a list of commands.`);
            }
        } catch(err) {
            this.log.warn(err);
        }
        this.outputData(prompt);
    } // executeCommand

    receiveFile(path) {
        const that = this;
        if (receiver.copyTo) {
            receiver.copyTo.end();
            delete receiver.copyTo;
        }
        if (path) {
            const toFile = fs.createWriteStream(path, {encoding: 'binary'});
            toFile.on('error', function(err) {
                log.warn(err);
            });
            toFile.on('close', function() {
                const bytes = toFile.bytesWritten;
                that.outputLine(OS.EOL + `Received ${bytes} bytes from ${remoteAddress}.`);
                if (!that.isConversing) that.outputData(prompt);
                delete receiver.copyTo;
            });
            receiver.copyTo = toFile;
            this.outputLine(`Receiving from ${remoteAddress} to ${path}.`);
        }
    }

    sendFile(path) {
        const that = this;
        if (this.fromFile) {
            this.fromFile.destroy();
            delete this.fromFile;
        }
        if (path) {
            this.fromFile = fs.createReadStream(path, {
                encoding: null, // Don't convert bytes to characters
                highWaterMark: SeveralFrames,
            });
            this.fromFile.on('error', function(err) {
                log.warn(err);
            });
            this.fromFile.on('close', function() {
                const bytes = that.fromFile.bytesRead;
                // Often, most of the bytes haven't been transmitted yet.
                // So it's more accurate to say 'sending' instead of 'sent'.
                that.outputLine(OS.EOL + `Sending ${bytes} bytes to ${remoteAddress}.`);
                if (!that.isConversing) that.outputData(prompt);
                delete that.fromFile;
            });
            this.outputLine(`Sending to ${remoteAddress} from ${path}.`);
            this.fromFile.pipe(new DataTo(connection, '> %s'));
        }
    }

    transcribe(path) {
        const that = this;
        if (this.terminal.copyTo) {
            this.terminal.copyTo.end();
            delete this.terminal.copyTo;
        }
        if (path) {
            const toFile = fs.createWriteStream(path, {encoding: localEncoding});
            toFile.on('error', function(err) {
                log.warn(err);
            });
            toFile.on('close', function() {
                const bytes = toFile.bytesWritten;
                that.outputLine(OS.EOL + `Transcribed ${bytes} bytes into ${path}.`);
                if (!that.isConversing) that.outputData(prompt);
                delete that.terminal.copyTo;
            });
            this.outputLine(`Transcribing into ${path}...`);
            this.terminal.copyTo = toFile;
        }
    }

    execute(path) {
        if (path) {
            const source = fs.createReadStream(path, {encoding: localEncoding});
            source.on('error', function(err) {
                log.warn(err);
            });
            source.pipe(new DataTo(this));
        }
    }

} // Interpreter

const breaker = new Breaker(INT, TERM);
process.stdin.pipe(breaker);
// At this point, the user can type INT or TERM to generate events,
// but other input is simply buffered, not even echoed.

const interpreter = new Interpreter(terminal);
var connection = null;
try {
    if (verbose) terminal.write('Connecting ...' + OS.EOL);
    connection = AGWPE.createConnection({
        host: host,
        port: port,
        remoteAddress: remoteAddress,
        localAddress: localAddress,
        localPort: localPort,
        via: via,
        ID: ID,
        frameLength: frameLength,
        logger: agwLogger,
    }, function connectListener(info) {
        breaker.pipe(interpreter).pipe(connection);
        interpreter.outputLine(messageFromAGW(info) || `Connected to ${remoteAddress}`);
        if (ESC) {
            interpreter.outputLine(`(Type ${controlify(ESC)} to pause the conversation.)`
                                   + OS.EOL); // blank line
        }
    });
} catch(err) {
    log.warn(err);
    showUsage(4);
}
connection.on('end', function(info) {
    if (log.debug()) log.debug('connection emitted end(%s)', (info == null) ? '' : formatChunk(info, remoteEncoding));
    terminal.write((messageFromAGW(info) || `Disconnected from ${remoteAddress}`) + OS.EOL);
});
connection.on('close', function(info) {
    log.debug('connection emitted close(%s)', info || '')
    setTimeout(process.exit, 10);
});
['error', 'timeout'].forEach(function(event) {
    connection.on(event, function(err) {
        terminal.write(`Connection ${event} ${err||''}${OS.EOL}`);
    });
});

connection.pipe(receiver).pipe(new DataTo(terminal));
['end', 'close'].forEach(function(event) {
    receiver.on(event, function(info) {
        log.debug('receiver emitted %s(%s)', event, info || '');
    });
    interpreter.on(event, function(info) {
        log.debug('interpreter emitted %s(%s)', event, info || '');
        disconnectGracefully();
    });
});
['drain', 'pause', 'resume'].forEach(function(event) {
    interpreter.on(event, function(info) {
        log.trace('interpreter emitted %s(%s)', event, info || '');
    });
});
[
    'SIGHUP', // disconnected or console window closed
    'SIGINT', // Ctrl+C
].forEach(function(signal) {
    process.on(signal, function(info) {
        log.debug('process received %s(%s)', signal, info || '');
        disconnectGracefully(signal);
    });
    breaker.on(signal, function(info) {
        log.debug('interpreter emitted %s(%s)', signal, info || '');
        disconnectGracefully(signal);
    });
});
process.on('SIGTERM', function(info) {
    log.debug('process received SIGTERM(%s)', info || '');
    setTimeout(process.exit, 10);
});
breaker.on('SIGTERM', function(info) {
    log.debug('interpreter emitted SIGTERM(%s)', info || '');
    setTimeout(process.exit, 10);
});

connection.on('frameReceived', function(frame) {
    try {
        switch(frame.dataKind) {
        case 'G':
            log.debug('frameReceived G');
            const availablePorts = frame.data.toString('ascii');
            const parts = availablePorts.split(';');
            const portCount = parseInt(parts[0]);
            if (localPort >= portCount) {
                const message = `The TNC has no port ${localPort}.`;
                const lines = []; // a blank line
                if (portCount <= 0) {
                    lines.push(message);
                } else {
                    lines.push(message + ' The available ports are:');
                    for (var p = 0; p < portCount; ++p) {
                        var description = parts[p + 1];
                        var sp = description.match(/\s+/);
                        if (sp) description = description.substring(sp.index + sp[0].length);
                        lines.push(p + ': ' + description);
                    }
                }
                terminal.write(lines.join(OS.EOL) + OS.EOL + OS.EOL);
                connection.destroy();
            }
            break;
        case 'X':
            if (!(frame.data && frame.data.toString('binary') == '\x01')) {
                connection.destroy();
            }
            break;
        default:
        }
    } catch(err) {
        log.error(err);
    }
});
