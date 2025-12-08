# agwpe-tools
Communicate via [AX.25](https://www.tapr.org/pdf/AX25.2.2.pdf),
using an AGWPE-compatible TNC (e.g.
[Direwolf](https://github.com/wb2osz/direwolf),
[SoundModem](http://uz7.ho.ua/packetradio.htm) or
[AGWPE](https://www.sv2agw.com/downloads/)).

This package contains two programs `converse` and `chatter`,
which you can use to interact with other stations via AX.25.
They run in a command line window, for example
"Command Prompt" on Windows or a terminal emulator window on Linux.

`converse` communicates with one station, via an AX.25 connection.
It's useful for interacting with a BBS.
`chatter` communicates with multiple stations, using connections
and/or UI packets (also known as unproto packets).
It's useful for participating in a multi-station chat session.

### Converse

First start your TNC (e.g. Direwolf or SoundModem).

On Windows:
1. Download `converse.exe` from the Assets section of the
   [Latest release](https://github.com/jmkristian/agwpe-tools/releases).
2. Open a PowerShell or Command Prompt (CMD) window.
3. `cd` to the folder that contains converse.exe.
4. `.\converse.exe --verbose <your call sign> <remote call sign>`

On Linux:
1. Download `converse` from the Assets section of the
   [Latest release](https://github.com/jmkristian/agwpe-tools/releases).
2. Open a terminal emulator (shell) window.
3. `cd` to the directory that contains converse.
4. `chmod +x converse`
5. `./converse --verbose <your call sign> <remote call sign>`

On Raspberry Pi:
1. Download `converse.armv7` from the Assets section of the
   [Latest release](https://github.com/jmkristian/agwpe-tools/releases).
2. Open a terminal emulator (shell) window.
3. `cd` to the directory that contains converse.armv7.
4. `chmod +x converse.armv7`
5. `./converse.armv7 --verbose <your call sign> <remote call sign>`

You can watch a video demonstrating this
on [Windows](https://youtu.be/lRvlnEeBrow/)
or [Linux](https://youtu.be/3QpdWmihQBI).

To see a summary of the command line options, run converse with no arguments.
To see a summary of commands you can give to converse, run converse,
pause the conversation and enter ? (a question mark).

To communicate large amounts of text,
you can copy-n-paste to or from your command line window.
To copy all the text from a command line window,
be sure to select the complete width of the screen buffer.

Characters sent to the remote station and received from the remote station
are encoded as specified by the command line option --encoding.

You can make your own software that uses converse.
For example, see how to poll a BBS
on [Windows](BBS_polling.md)
or [Linux](BBS_polling_linux.md).

### Chatter

Download and run chatter the same way as converse.
On Linux, run `chmod +x chatter` after you download it.
On Raspberry Pi, run `chmod +x chatter.armv7` after you download it.
To see a summary of its command line options, run it with no arguments.

To get started using chatter, first start your TNC (e.g. Direwolf or SoundModem).
Then run
`.\chatter.exe <your call sign>` on Windows or
`./chatter <your call sign>` on Linux or
`./chatter.armv7 <your call sign>` on Raspberry Pi.
Then enter `?` to see a summary of all the commands.
To send data, enter an `unproto` or `connect` command;
then type the data you want to send.

Chatter outputs a summary of all the packets that the TNC receives.
You can filter out some of the packets using `hide` and `show` commands.
By default, chatter hides packets that it receives repeatedly.
Usually this means packets that are retransmitted by digipeaters.
In general, it won't show a packet that's
the same (except for digipeaters) as another packet it received recently.
To see the repetitive packets, enter the command `show repeats`.

If you don't specify the 'via' option to `connect` or `unproto` commands,
chatter will try to use a short sequence of digipeaters.
To do this, it listens to all packets,
observes the digipeaters that other stations use
and picks out the shortest sequence that it received directly from a digipeater.
If it receives directly from a source station,
it will send to that station directly, without using digipeaters.
This system depends on receiving packets, so it doesn't work immediately.
If you know the digipeaters you want to use,
specify a 'via' option to a `connect` or `unproto` command or
use the `via` command to set the default for all stations.
Chatter will use the digipeaters you specify.
It might suggest a shorter sequence, but it won't override your choice.

### Using node

In case the executable files don't work,
you can use [node.js](http://nodejs.org) to run these commands.
Here's how:

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
   - `node ./chatter.js <your call sign>`

To see a summary of the command line options, run either program with no arguments.

### Details
This software requires node.js version 8.17 or later.
It works on Windows 8, Ubuntu 20, Raspbian 10 (Buster) and MacOS 14.4.1 (Sonoma),
with [Direwolf](https://github.com/wb2osz/direwolf) version 1.7
and [UZ7HO SoundModem](http://uz7.ho.ua/packetradio.htm) version 1.13.
It might work with other versions.

The executable files were built using node.js version 18.20.8.
The Windows executable files were built by `build.cmd` on Windows 11.
The Linux executable files were built by `build.sh` on Ubuntu 20.04.6 LTS (64 bit)
on a VirtualBox machine hosted by Windows 11.
The armv7 executable files were built by `build.armv7` on Debian GNU/Linux 13 (trixie)
on a Raspberry Pi 3 Model B+.

If you're willing to help make executable files for MacOS,
please add a comment to
[issue #5](https://github.com/jmkristian/agwpe-tools/issues/5).

[John Kristian](https://github.com/jmkristian) \<jmkristian@gmail.com\>
created and maintains this project.
