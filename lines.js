'use strict';

const OS = require('os');
const shared = require('./shared.js');
const Stream = require('stream');

const localEncoding = 'utf8';
const remoteEncoding = 'binary'; // TODO

class Lines extends Stream.Writable {

    constructor(escape, logger) {
        super({
            decodeStrings: false, // Don't convert strings to bytes
            encoding: remoteEncoding,
            highWaterMark: 128,
        });
        this.ESC = escape;
        this.INT = shared.INT;
        this.TERM = shared.TERM;
        if (this.INT || this.TERM) {
            this.pattern = new RegExp(`${this.INT}|${this.TERM}`, 'g');
        }
        this.log = logger || shared.LogNothing;
        this.buffer = '';
        this.prefix = '';
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
        process.stdin.pipe(this);
    }

    prompt(prefix) {
        if (this.prefix != prefix) {
            var data = '';
            if (this.prefix) {
                for (var p = 0; p < this.prefix.length; ++p) {
                    data += '\b \b';
                }
            }
            for (var b = 0; b < this.buffer.length; ++b) {
                data += '\b';
            }
            this.prefix = prefix;
            data += this.prefix + this.buffer;
            process.stdout.write(data);
        }
    }

    _clearLine() {
        var data = '';
        for (var d = this.prefix.length + this.buffer.length; d > 0; --d) {
            data += '\b \b';
        }
        process.stdout.write(data);
        this.prefix = '';
        this.buffer = '';
    }

    _emitLine() {
        const line = this.buffer;
        this._clearLine();
        this.emit('line', line);
    }

    writeLine(chunk, encoding, callback) {
        const line = Buffer.isBuffer(chunk) ? chunk.toString(encoding)
              : (typeof chunk) == 'string' ? chunk
              : '' + chunk;
        var extra = line.length - (this.prefix.length + this.buffer.length);
        var output = '';
        for (var e = 0; e < extra; ++e) {
            output += '\b \b';
        }
        for (var c = 0; c < line.length; ++c) {
            output += '\b';
        }
        output += line + OS.EOL + this.prefix + this.buffer;
        process.stdout.write(output, callback);
    }

    _write(chunk, encoding, callback) {
        shared.logChunk(this.log, this.log.trace, 'Lines._write(%s)', chunk, encoding);
        var data = Buffer.isBuffer(chunk) ? chunk.toString(localEncoding) : chunk;
        if (this.pattern) {
            const that = this;
            data = data.replace(this.pattern, function(found) {
                if (found == that.INT) that.emit('SIGINT');
                else if (found == that.TERM) that.emit('SIGTERM');
                return '';
            });
        }
        for (var d = 0; d < data.length; ++d) {
            var c = data.substring(d, d + 1);
            switch(c) {
            case shared.BS:
            case shared.DEL:
                if (this.buffer.length) {
                    process.stdout.write('\b \b');
                    this.buffer = this.buffer.substring(0, this.buffer.length - 1);
                }
                break;
            case '\x15': // erase buffer
                var data = '';
                for (var d = this.buffer.length; d > 0; --d) {
                    data += '\b \b';
                }
                process.stdout.write(data);
                this.buffer = '';
                break;
            case '\n':
            case '\r':
                this._emitLine();
                break;
            case this.ESC:
                this._clearLine();
                this.emit('escape');
                break;
            case shared.EOT:
                if (this.buffer) {
                    this._emitLine();
                } else {
                    this.emit('close');
                }
                break;
            case shared.INT:
                this.emit('SIGINT');
                break;
            default:
                this.buffer += c;
                process.stdout.write(c);
            }
        }
        if (callback) callback();
    }

} // Lines

exports.Lines = Lines;
