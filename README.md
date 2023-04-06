# agwpe-tools
Communicate via [AX.25](https://www.tapr.org/pdf/AX25.2.2.pdf),
using an AGWPE-compatible TNC (e.g.
[Direwolf](https://github.com/wb2osz/direwolf),
[SoundModem](http://uz7.ho.ua/packetradio.htm) or
[AGWPE](https://www.sv2agw.com/downloads/)).

### Windows

This package provides a Windows program `converse.exe`,
which you can use to interact with another station.
It runs in a command line window.
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
it's convenient to copy-n-paste to or from your command line window.
I recommend enabling
[QuickEdit Mode](https://www.techjunkie.com/boost-productivity-quickedit-mode-windows-command-prompt/).
To copy all the data, be sure to select the complete width of the screen buffer.
To handle long lines of text, I recommend increasing the width of the screen buffer and window
(in the Layout tab of the Properties dialog).

You can create a small .cmd script to run converse.exe with your favorite arguments, like this:
```
@.\converse.exe w6jmk w1xsc-1
@pause
```
The
[pause](https://learn.microsoft.com/en-us/windows-server/administration/windows-commands/pause)
command prevents the window from closing immediately after disconnecting from the remote station.
You can create a
[shortcut](https://www.computerhope.com/issues/ch000739.htm)
to the .cmd script, to customize the properties of the command line window.

### Linux

A similar program works on Linux and other platforms that support
[node.js](https://nodejs.org/en/download/).
To get started:

1. [Clone](https://www.techrepublic.com/article/how-to-clone-github-repository/)
   the [agwpe-tools](https://github.com/jmkristian/agwpe-tools) repository.
2. Start a shell and `cd` into your clone.
3. Check whether node.js is installed, by running the command `node --version`.
   If not, [install node.js](https://nodejs.org/en/download/).
   You'll need node version 8.0 or later.
   If you need to upgrade, you can use `nvm` to
   [install a new version](https://heynode.com/tutorial/install-nodejs-locally-nvm/).
4. Download node modules, by running the command `npm install`.
   Ignore messages about finding Python; they're harmless.
5. Start your TNC (e.g. Direwolf or SoundModem).
6. Run the command `node ./converse.js <your call sign> <remote call sign> --verbose`.

To see a summary of the command line options, run `node ./converse.js` (with no arguments).

The converse.js software requires node.js version 8 or later.
It works on Windows 8 and Ubuntu 20, with
[Direwolf](https://github.com/wb2osz/direwolf) version 1.7
and [UZ7HO SoundModem](http://uz7.ho.ua/packetradio.htm) version 1.13.
It might work with other versions or on Mac.

The converse.exe program for Windows was built by `build.sh`,
running on node.js version 18.15.0.
