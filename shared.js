/** A command to communicate via AX.25 in conversational style.
    A connection to another station is initiated. Subsequently, each
    line from stdin is transmitted, and received data are written to
    stdout. A simple command mode enables sending and receiving files.
 */
"use strict";
const OS = require('os');
const Stream = require('stream');
const util = require('util');

const BS = '\x08'; // un-type previous character
const DEL = '\x7F'; // un-type previous character
const EOT = '\x04'; // Ctrl+D = flush line, or EOF at the start of a raw line.
const INT = '\x03'; // Ctrl+C = graceful kill

const allNULs = new RegExp('\0', 'g');
const localEncoding = 'utf8';

const LogNothing = {
    child: function(){return LogNothing;},
    trace: function(){},
    debug: function(){},
    info: function(){},
    warn: function(){},
    error: function(){},
    fatal: function(){},
};

function newError(message, code) {
    const err = new Error(message);
    if (code) err.code = code;
    return err;
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

/** Convert a colloquial control character expression to an actual character. */
function fromASCII(s) {
    if (s) {
        var code = null;
        if (s.length == 2 && s.charAt(0) == '^') {
            code = s.charCodeAt(1);
        }
        if (s.length == 6 && s.toLowerCase().startsWith('ctrl+')) {
            code = s.charCodeAt(5);
        }
        if (code != null) {
            while (code >= 32) code = code - 32;
            return String.fromCharCode(code);
        }
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

function formatChunk(chunk, encoding) {
    if (Buffer.isBuffer(chunk)) {
        return hexBuffer(chunk);
    } else {
        return util.format('%s %j', encoding, chunk);
    }
}

function logChunk(log, level, format, chunk, encoding) {
    if (log && level && level.apply(log, [])) {
        level.apply(log, [format, formatChunk(chunk, encoding)]);
    }
}

function messageFromAGW(info) {
    return info && info.toString('latin1')
        .replace(allNULs, '')
        .replace(/^[\r\n]*/, '')
        .replace(/[\r\n]*$/, '')
        .replace(/[\r\n]+/g, OS.EOL);
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

/** A Transform that simply passes data but not 'end'.
    This is used to pipe multiple streams into one.
 */
class DataTo extends Stream.Transform {
    constructor(target, log, logFormat) {
        super({
            decodeStrings: false, // Don't convert strings to bytes
            encoding: null, // Don't convert bytes to strings
        });
        this.target = target;
        this.log = log || LogNothing;
        this.logFormat = logFormat;
    }
    _transform(chunk, encoding, callback) {
        try {
            if (this.logFormat) {
                logChunk(this.log, this.log.debug, this.logFormat, chunk, encoding);
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
    constructor(log) {
        super({
            decodeStrings: false, // Don't convert strings to bytes
            emitClose: false,
            encoding: null, // Don't convert bytes to strings
        });
        this.log = log || LogNothing;
    }
    _transform(chunk, encoding, callback) {
        logChunk(this.log, this.log.debug, '< %s', chunk, encoding);
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
        this.log.trace('Receiver.push(%j, %s)', data, localEncoding);
        this.push(data, localEncoding);
        if (this.copyTo) {
            this.copyTo.write(chunk, localEncoding, callback);
        } else if (callback) {
            callback();
        }
    }
    _flush(callback) {
        this.log.trace('Receiver._flush');
        if (this.copyTo) {
            this.copyTo.end(undefined, undefined, callback);
        } else if (callback) {
            callback();
        }
    }
}

/** If the input stream is a TTY, setRawMode and set this.isRaw = true.
    Emit events when input contains INT or TERM.
*/
class Breaker extends Stream.Transform {
    constructor(INT, TERM, log) {
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
        this.log = log || LogNothing;
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
                that.log.error(err);
            }
        });
    }
    _transform(chunk, encoding, callback) {
        logChunk(this.log, this.log.trace, 'Breaker._transform(%s)', chunk, encoding);
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

exports.BS = BS;
exports.DEL = DEL;
exports.EOT = EOT;
exports.INT = INT;

exports.Breaker = Breaker;
exports.controlify = controlify;
exports.DataTo = DataTo;
exports.decode = decode;
exports.encode = encode;
exports.encodingName = encodingName;
exports.formatChunk = formatChunk;
exports.fromASCII = fromASCII;
exports.hexBuffer = hexBuffer;
exports.hexByte = hexByte;
exports.localEncoding = localEncoding;
exports.logChunk = logChunk;
exports.messageFromAGW = messageFromAGW;
exports.newError = newError;
exports.Tee = Tee;
