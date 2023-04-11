# agwpe-tools
Communicate via [AX.25](https://www.tapr.org/pdf/AX25.2.2.pdf),
using an AGWPE-compatible TNC (e.g.
[Direwolf](https://github.com/wb2osz/direwolf),
[SoundModem](http://uz7.ho.ua/packetradio.htm) or
[AGWPE](https://www.sv2agw.com/downloads/)).

### Windows

This package provides a Windows program `converse.exe`,
which you can use to interact with another station
via an AX.25 connection.
The program runs in a command line window.
You can watch a [demonstration video](https://youtu.be/lRvlnEeBrow/).

To get started:
1. Download the latest version of converse.exe
   [here](https://github.com/jmkristian/agwpe-tools/releases).
   It's in the Assets section of each release.
2. Start your TNC (e.g. Direwolf or SoundModem).
3. Open a PowerShell or Command Prompt (CMD) window.
4. `cd` to the folder that contains converse.exe.
5. Enter the command line:

`.\converse.exe <your call sign> <remote call sign> --verbose`

To see a summary of the command line options, run `.\converse.exe` (with no arguments).

To communicate large amounts of text,
you can copy-n-paste to or from your command line window.
To copy all the text from a command line window,
be sure to select the complete width of the screen buffer.

You can customize converse.exe.
For example, see [Polling a BBS](BBS_polling.md).

### Linux

A similar program works on Linux and other platforms that support
[node.js](https://nodejs.org/en/download/).
To get started:

1. [Clone](https://www.techrepublic.com/article/how-to-clone-github-repository/)
   the [agwpe-tools](https://github.com/jmkristian/agwpe-tools) repository.
2. Start a shell and `cd` into your clone.
3. Get node.js version 8.17 or later.
   Check your current version by running the command `node --version`.
   If you don't have this command, [install node.js](https://nodejs.org/en/download/)
   and start a new shell.
   If you have an old version, you can use `nvm` to
   [install a new version](https://heynode.com/tutorial/install-nodejs-locally-nvm/).
4. Download node modules, by running the command `npm install`.
   Ignore messages about finding Python; they're harmless.
5. Start your TNC (e.g. Direwolf).
6. Run the command `node ./converse.js <your call sign> <remote call sign> --verbose`.

To see a summary of the command line options, run `node ./converse.js` (with no arguments).

The converse.js software requires node.js version 8.17 or later.
It works on Windows 8 and Ubuntu 20, with
[Direwolf](https://github.com/wb2osz/direwolf) version 1.7
and [UZ7HO SoundModem](http://uz7.ho.ua/packetradio.htm) version 1.13.
It might work with other versions or on Mac.

The converse.exe program for Windows was built by `build.sh`,
running on node.js version 12.22.12.
