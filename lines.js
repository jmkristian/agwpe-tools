'use strict';

const EventEmitter = require('events');
const fs = require('fs');
const OS = require('os');
const shared = require('./shared.js');
const Stream = require('stream');

class FileHelper extends Stream.Writable {

    constructor(lines) {
        super({
            decodeStrings: false, // Don't convert strings to bytes
        });
        this.lines = lines;
        this.ESC = lines.ESC;
        this.buffer = '';
    }

    _write(chunk, encoding, callback) {
        try {
            var data = (typeof chunk) == 'string' ? chunk
                : chunk == null ? '' // That's weird.
                : chunk.toString();
            for (var d = 0; d < data.length; ++d) {
                var c = data.charAt(d);
                switch(c) {
                case shared.BS:
                case shared.DEL:
                    if (this.buffer.length > 0) {
                        this.buffer = this.buffer.substring(0, this.buffer.length - 1);
                    }
                    break;
                case '\x15': // Ctrl+U erase buffer
                    this.buffer = '';
                    break;
                case this.ESC:
                    this.buffer = '';
                    this.lines.emit('escape');
                    break;
                default:
                    this.buffer += c;
                }
                if (this.buffer.endsWith(OS.EOL)) {
                    this.buffer = this.buffer.substring(0, this.buffer.length - OS.EOL.length);
                    this.lines.emit('line', this.buffer);
                    this.buffer = '';
                }
            }
        } catch(err) {
            this.lines.emit('error', err);
        }
        if (callback) callback();
    }
} // FileHelper

class StdHelper extends Stream.Writable {

    constructor(lines, stdout) {
        super({
            decodeStrings: false, // Don't convert strings to bytes
            encoding: 'binary',
            highWaterMark: 128,
        });
        this.lines = lines;
        this.stdout = stdout;
        this.ESC = lines.ESC;
        this.buffer = '';
        this.prefix = '';
        this.INT = shared.INT;
        this.TERM = shared.TERM;
        const specials = [this.INT, this.TERM].filter(function(c) {return c;});
        if (specials.length > 0) {
            this.pattern = new RegExp(specials.join('|'), 'g');
        }
        const that = this;
        this.on('pipe', function(from) {
            that.isRaw = false;
            try {
                if (from.isTTY && from.setRawMode) {
                    from.setRawMode(true);
                    that.isRaw = true;
                }
            } catch(err) {
                that.lines.emit('error', err);
            }
        });
    }

    prompt(prefix, callback) {
        if (this.prefix == prefix) {
            if (callback) callback();
        } else {
            var output = '';
            for (var b = this.prefix.length + this.buffer.length; b > 0 ; --b) {
                output += '\b \b';
            }
            this.prefix = '' + prefix;
            output += this.prefix + this.buffer;
            this.stdout.write(output, callback);
        }
    }

    clearBuffer() {
        this.stdout.write(this.buffer.replace(/./g, '\b \b'));
        this.buffer = '';
    }

    emitBuffer() {
        const line = this.buffer;
        this.clearBuffer();
        this.lines.emit('line', line);
    }

    /** Show a line to the user. */
    writeLine(chunk, encoding, callback) {
        const line = (typeof chunk) == 'string' ? chunk : chunk.toString();
        var output = '';
        var b = this.prefix.length + this.buffer.length;
        // Erase part of the buffered line:
        for (; b > line.length; --b) {
            output += '\b \b';
        }
        // Move the cursor all the way to the left:
        for (; b > 0; --b) {
            output += '\b';
        }
        output += line // Over-write the buffered line with the new line,
            + OS.EOL + this.prefix + this.buffer; // and restore the buffered line.
        this.stdout.write(output, callback);
    }

    /** Handle input coming from the user. */
    _write(chunk, encoding, callback) {
        var data = (typeof chunk) == 'string' ? chunk
            : chunk == null ? '' // That's weird.
            : chunk.toString();
        if (this.pattern) {
            const that = this;
            data = data.replace(this.pattern, function(found) {
                if (found == that.INT) that.lines.emit('SIGINT');
                else if (found == that.TERM) that.lines.emit('SIGTERM');
                return '';
            });
        }
        var output = '';
        for (var d = 0; d < data.length; ++d) {
            var c = data.charAt(d);
            switch(c) {
            case shared.BS:
            case shared.DEL:
                if (this.buffer.length > 0) {
                    output += '\b \b';
                    this.buffer = this.buffer.substring(0, this.buffer.length - 1);
                }
                break;
            case '\x15': // Ctrl+U erase buffer
                for (var b = this.buffer.length; b > 0; --b) {
                    output += '\b \b';
                }
                this.buffer = '';
                break;
            case '\n':
            case '\r':
                this.emitBuffer();
                break;
            case this.ESC:
                this.clearBuffer();
                this.lines.emit('escape');
                break;
            case shared.EOT:
                if (this.buffer) {
                    this.emitBuffer();
                } else {
                    this.lines.emit('close');
                }
                break;
            case shared.INT:
                this.lines.emit('SIGINT');
                break;
            default:
                this.buffer += c;
                output += c;
            }
        }
        this.stdout.write(output, callback);
    }

} // StdHelper

class Lines extends EventEmitter {

    constructor(ESC) {
        super();
        this.ESC = ESC;
        this.std = new StdHelper(this, process.stdout);
        process.stdin.pipe(this.std);
    }

    /** Use this prefix to prompt the user for input. */
    prompt(prefix, callback) {
        this.std.prompt(prefix, callback);
    }

    /** Show a line to the user. */
    writeLine(chunk, encoding, callback) {
        this.std.writeLine(chunk, encoding, callback);
    }

    /** Emit all the lines contained in the given file. */
    readFile(fileName) {
        try {
            const that = this;
            const reader = fs.createReadStream(fileName);
            reader.on('error', function(err) {
                that.emit('error', err);
            });
            reader.on('open', function(fileDescriptor) {
                reader.pipe(new FileHelper(that));
            });
        } catch(err) {
            this.emit('error', err);
        }
    }

} // Lines

exports.Lines = Lines;
