'use strict';

const OS = require('os');
const shared = require('./shared.js');
const Stream = require('stream');

class Lines extends Stream.Writable {

    constructor(stdout, escape, log) {
        super({
            decodeStrings: false, // Don't convert strings to bytes
            encoding: 'binary',
            highWaterMark: 128,
        });
        this.stdout = stdout;
        this.ESC = escape;
        this.log = log || shared.LogNothing;
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
                that.log.error(err);
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
        var output = '';
        for (var b = this.prefix.length + this.buffer.length; b > 0; --b) {
            output += '\b \b';
        }
        this.stdout.write(output);
        this.prefix = '';
        this.buffer = '';
    }

    emitBuffer() {
        const line = this.buffer;
        this.clearBuffer();
        this.emit('line', line);
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
        shared.logChunk(this.log, this.log.trace, 'Lines._write(%s)', chunk, encoding);
        var data = (typeof chunk) == 'string' ? chunk
            : chunk == null ? '' // That's weird.
            : chunk.toString();
        if (this.pattern) {
            const that = this;
            data = data.replace(this.pattern, function(found) {
                if (found == that.INT) that.emit('SIGINT');
                else if (found == that.TERM) that.emit('SIGTERM');
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
                this.emit('escape');
                break;
            case shared.EOT:
                if (this.buffer) {
                    this.emitBuffer();
                } else {
                    this.emit('close');
                }
                break;
            case shared.INT:
                this.emit('SIGINT');
                break;
            default:
                this.buffer += c;
                output += c;
            }
        }
        this.stdout.write(output, callback);
    }

} // Lines

exports.Lines = Lines;
