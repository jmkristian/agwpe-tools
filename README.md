# agwpe-tools
Communicate via [AX.25](https://www.tapr.org/pdf/AX25.2.2.pdf),
using an AGWPE-compatible TNC (e.g.
[Direwolf](https://github.com/wb2osz/direwolf),
[SoundModem](http://uz7.ho.ua/packetradio.htm) or
[AGWPE](https://www.sv2agw.com/downloads/)).

This package contains two programs `converse` and `chatter`,
which you can use to interact with other stations via AX.25.
They run in a command line window, for example
"Command Prompt" on Windows or a shell window on Linux.

`converse` communicates with one station, via an AX.25 connection.
It's useful for interacting with a BBS.
`chatter` communicates with multiple stations, using connections
and/or UI packets (also known as unproto packets).
It's useful for participating in a multi-station chat session.

### Converse on Windows

To get started:
1. Download the latest version of converse.exe
   [here](https://github.com/jmkristian/agwpe-tools/releases).
   It's in the Assets section of each release.
2. Start your TNC (e.g. Direwolf or SoundModem).
3. Open a PowerShell or Command Prompt (CMD) window.
4. `cd` to the folder that contains converse.exe.
5. Enter the command line:

`.\converse.exe <your call sign> <remote call sign> --verbose`

You can watch a [demonstration video](https://youtu.be/lRvlnEeBrow/).

To see a summary of the command line options, run `.\converse.exe` (with no arguments).

Characters in your command line window are encoded in UTF-8.
Characters sent to the remote station and received from the remote station
are encoded as specified by the command line option --encoding.

To communicate large amounts of text,
you can copy-n-paste to or from your command line window.
To copy all the text from a command line window,
be sure to select the complete width of the screen buffer.

You can customize converse.exe.
For example, see [Polling a BBS](BBS_polling.md).

### Chatter on Windows

You can download and run chatter.exe the same way.
To see a summary of its command line options, run `.\chatter.exe` (with no arguments).
After you start it with your call sign, enter the command '?' to see
a summary of all its commands.

Chatter outputs a summary of all the data that AGWPE receives.
You can filter out some of the data using `hide` and `show` commands.

To send data, either give the destination call sign on the command line
(after your call sign)
or run an `unproto` or `connect` command.
Then type the data you want to send.

Chatter hides repetitive packets, by default.
Usually this means packets that are retransmitted by repeaters.
In general, it won't show a packet that's
the same (except for repeaters) as another packet it heard recently.
To see the repetitive packets, add --verbose to the command line.

If you don't specify the 'via' option to 'connect' or 'unproto' commands,
chatter will try to use the best sequence of repeaters.
To do this, it listens to all packets,
observes the repeaters that other stations use
and picks out the shortest sequence that it heard directly from a repeater.
If it hears directly from a source station, it will choose no repeaters.
Of course, it takes time to build up this information by hearing packets.
If you know the right repeaters,
use the 'via' command to set the default for all stations,
or specify a 'via' option to a 'connect' or 'unproto' command.
Then chatter will use the repeaters you specify.
It might suggest a shorter sequence if it hears one repeatedly,
but it won't override your choice.

### Linux

These programs work similarly on Linux and other platforms that support
[node.js](https://nodejs.org/en/download/).
To get started:

1. Get node.js version 8.17 or later.
   Check your current version by running the command `node --version`.
   If you don't have this command, [install node.js](https://nodejs.org/en/download/)
   and start a new shell.
   If you have an old version, you can use `nvm` to
   [install a new version](https://heynode.com/tutorial/install-nodejs-locally-nvm/).
2. [Clone](https://www.techrepublic.com/article/how-to-clone-github-repository/)
   the [agwpe-tools](https://github.com/jmkristian/agwpe-tools) repository.
3. Start a shell and `cd` into your clone.
4. Run the command `npm install` to download other node packages that you'll need.
   Ignore messages about finding Python; they're harmless.
5. Start your TNC (e.g. Direwolf).
6. Run one of the programs, either:
   - `node ./converse.js --verbose <your call sign> <remote call sign>`
   - `node ./chatter.js --verbose <your call sign>`

To see a summary of the command line options, run either program with no arguments.

This software requires node.js version 8.17 or later.
It works on Windows 8 and Ubuntu 20, with
[Direwolf](https://github.com/wb2osz/direwolf) version 1.7
and [UZ7HO SoundModem](http://uz7.ho.ua/packetradio.htm) version 1.13.
It might work with other versions or on Mac.

The Windows executable files were built by `build.sh`,
running on node.js version 12.22.12.
