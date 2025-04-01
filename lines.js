'use strict';

const EventEmitter = require('events');
const fs = require('fs');
const OS = require('os');
const shared = require('./shared.js');
const Stream = require('stream');

class FileHelper extends Stream.Writable {

    constructor(buffer) {
        super({
            decodeStrings: false, // Don't convert strings to bytes
        });
        this.buffer = buffer;
    }

    _write(chunk, encoding, callback) {
        this.buffer.push(chunk && chunk.toString(shared.localEncoding));
        this.buffer.push(callback);
        this.emit('input');
    }

    _final(callback) {
        this.buffer.push(callback);
        this.emit('input');
    }
} // FileHelper

class StdHelper extends FileHelper {

    constructor(buffer) {
        super(buffer);
        const that = this;
        this.on('pipe', function(from) {
            try {
                if (from.isTTY && from.setRawMode) {
                    from.setRawMode(true);
                    that.isRaw = true;
                }
            } catch(err) {
                that.emit('error', err);
            }
        });
    }
} // StdHelper

class Lines extends EventEmitter {

    constructor(onLine, ESC) {
        super();
        this.onLine = onLine;
        this.ESC = ESC;
        this.stdout = process.stdout;
        this.buffer = '';
        this.prompt = '';
        const input = {data: []};
        this.inputs = [input];
        this.std = new StdHelper(input.data);
        this.watchHelper(this.std);
        process.stdin.pipe(this.std);
    }

    watchHelper(helper) {
        const that = this;
        helper.on('error', function(err) {
            that.emit('error', err);
        });
        helper.on('input', function() {
            that.continueInput();
        });
        helper.on('finish', function() {
            helper.buffer.push(function() {
                that.emit('debug', `${that.inputs.length} finish`);
                that.inputs.pop();
            });
        });
    }

    /** Emit an 'escape' event when the user types this character. */
    setEscape(escape) {
        this.ESC = escape;
    }

    /** Use this to prompt the user for input. */
    setPrompt(prompt, callback) {
        if (this.prompt == prompt) {
            if (callback) callback();
        } else {
            const newPrompt = prompt ? prompt.toString() : '';
            const oldLength = this.prompt.length + this.buffer.length;
            const newLength = newPrompt.length + this.buffer.length;
            var output = '';
            for (var b = oldLength; b > newLength; --b) {
                output += '\b \b';
            }
            for (; b > 0; --b) {
                output += '\b';
            }
            this.prompt = newPrompt;
            output += this.prompt + this.buffer;
            this.stdout.write(output, callback);
        }
    }

    /** Show a line to the user. */
    writeLine(chunk, callback) {
        const line = chunk ? chunk.toString() : '';
        var output = '';
        var b = this.prompt.length + this.buffer.length;
        // Erase part of the buffered line:
        for (; b > line.length; --b) {
            output += '\b \b';
        }
        // Move the cursor all the way to the left:
        for (; b > 0; --b) {
            output += '\b';
        }
        output += line // Over-write the buffered line with the new line,
            + OS.EOL + this.prompt + this.buffer; // and restore the buffered line.
        this.stdout.write(output, callback);
    }

    clearBuffer() {
        this.stdout.write(this.buffer.replace(/./g, '\b \b'));
        this.buffer = '';
    }

    emitBuffer() {
        const line = this.buffer;
        this.clearBuffer();
        this.inputPaused = true;
        const that = this;
        this.onLine(line, function callback() {
            delete that.inputPaused;
            // onLine may callback synchronously or asynchronously.
            // If it's synchronous, continueInput will continue immediately.
            // In case it's asynchronous:
            setTimeout(function() {
                that.continueInput(); // not recursive
            }, 1);
        });
    }

    /** Process this.inputs if !this.inputPaused && there's any input data available. */
    continueInput() {
        var inputCount;
        while (!this.inputPaused && (inputCount = this.inputs.length) > 0) {
            const input = this.inputs[inputCount - 1];
            if (input.data.length <= 0) {
                // For example, data were added to a different member of this.inputs.
                break; // wait for another call to continueInput
            }
            const item = input.data.shift();
            var event = null;
            var output = '';
            if ((typeof item) == 'function') { // callback or finish
                item();
                // The item may modify this.inputs. So re-examine them.
            } else if (item) { // input character string
                this.emit('debug', `${this.inputs.length} ${input.sawCR} continueInput ${JSON.stringify(item)})`);
                var i;
                for (i = 0; !event && i < item.length; ++i) {
                    var c = item.charAt(i);
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
                    case '\r':
                        event = 'line';
                        break;
                    case '\n': // '\r\n' is the end-of-line marker on some computers.
                        if (!input.sawCR) event = 'line';
                        break;
                    case this.ESC:
                        event = 'escape';
                        this.clearBuffer();
                        break;
                    case shared.EOT:
                        event = this.buffer ? 'line' : 'close';
                        break;
                    case shared.INT:
                        event = 'SIGINT';
                        break;
                    default:
                        this.buffer += c;
                        if (inputCount > 1 || this.std.isRaw) {
                            output += c;
                        }
                    }
                    input.sawCR = (c == '\r');
                }
                // An event handler might modify this.inputs, for example by calling this.readFile.
                // So, don't parse any more input characters yet:
                if (i < item.length) {
                    input.data.unshift(item.substring(i));
                }
            }
            if (output) this.stdout.write(output);
            if (event == 'line') {
                this.emitBuffer();
            } else if (event) {
                this.emit(event);
            }
            // ... and re-examine this.inputs, in the next iteration.
        }
    }

    /** Emit all the lines contained in the given file. */
    readFile(fileName) {
        try {
            const input = {data: []};
            this.inputs.push(input);
            const helper = new FileHelper(input.data);
            this.watchHelper(helper);
            const that = this;
            const reader = fs.createReadStream(fileName);
            reader.on('error', function(err) {
                helper.end(function() {
                    that.emit('error', err);
                });
            });
            reader.on('open', function(fileDescriptor) {
                reader.pipe(helper);
            });
        } catch(err) {
            this.emit('error', err);
        }
    }

} // Lines

exports.Lines = Lines;
