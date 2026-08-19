=====================================================
 MemoAnima v1.3.0
 A fan-made desktop tool for flipbook animations
=====================================================

Japanese: see README.txt in this folder.
（日本語の説明は同梱の README.txt をご覧ください。）

== WHAT MEMOANIMA IS ==
Import the flipbook animations you made on a Nintendo 3DS (.kwz / .ppm) onto
your PC, edit them, and export to MP4 / GIF / APNG / a PNG sequence.
Windows only.
- An unofficial, non-commercial fan tool made by one person.
- It is a tool for editing animation data you created yourself, on your own PC.
- Your source data (the SD card and so on) is only ever READ. Nothing is
  written to it and nothing is changed.
- Editing happens on an independent copy inside your PC library.

== NEW IN v1.3.0 ==
<Added>
- The app is now available in 5 languages: Japanese, English, Spanish,
  Portuguese (Brazil) and Korean. It follows your Windows display language on
  first launch, and you can change it any time from the gear icon. The change
  takes effect right away - no restart.
- You can choose the drawing cursor (dot / cross / arrow), with an optional
  ring showing the area your nib would paint and an optional box around the
  single pixel under the cursor. Choose "Cross" to get the old look back.
- Pressing F5 or Ctrl+R while editing now asks for confirmation instead of
  reloading straight away (only when you have unsaved changes).

<Fixed>
- The hand and transform cursors never actually appeared over the canvas.
  They do now (this had been broken for a long time).
- "Save as" used to preselect the album you last saved into. It now
  preselects the album the animation itself lives in.
- The image-import palette named after another product has been renamed
  "Classic 6 colours".

Your animation files have not changed format. Everything you made before
opens as it is, and your settings and shortcuts carry over.

== WHAT YOU NEED ==
- Windows 10 / 11 (64-bit)
- Microsoft Edge WebView2 Runtime
  (normally already present on Windows 10/11. If it is missing, the app tells
   you at startup. Install the Evergreen Bootstrapper from Microsoft's WebView2
   download page. This app never downloads anything by itself.)

== GETTING STARTED ==
1. Unzip this anywhere you like (your desktop, D:\Tools, whatever suits you)
2. Double-click MemoAnima.exe
3. Follow the first-run guide: choose a library folder -> import -> edit -> export
Note: layers are shared across every frame (the standard way animation tools
work). Adding a frame gives you a blank frame with the same layer structure.

== IF WINDOWS SMARTSCREEN WARNS YOU ==
This is an unsigned app distributed by an individual, so the first launch may
show the blue "Windows protected your PC" screen. That is not a virus
detection - it means "the publisher is not verified". To run it:
  click "More info" -> click "Run anyway"
(If you would rather be careful, scan the file with your antivirus first.)

== ABOUT NETWORK ACCESS ==
This application never communicates over the internet. There is no update
check and nothing is sent anywhere. The video encoder (ffmpeg.wasm) is bundled,
so everything works offline.

== WHERE YOUR DATA LIVES ==
- Your animation library: the folder you chose in the first-run guide
- Settings and autosave: %APPDATA%\com.arcana.memoanima
To uninstall, delete the folder you unzipped and the folder above.

== DISCLAIMER ==
You use this software at your own risk. Your animations matter - please keep
your own backups of the library folder. The author accepts no liability for
any damage arising from the use of this software.

== LICENCE ==
The source code of this application is published under the GNU General Public
License v3 or later. Anyone can obtain the source, free of charge, at:
  https://github.com/OFF-Proxy/MemoAnima
Everything you draw, animate and export with this software is yours. This
licence does not extend to your work.

The bundled fonts are under separate licences (SIL Open Font License 1.1 /
M+ FONT LICENSE), not the application's. For the licences of the bundled open
source software, see LICENSES.txt. In particular, the ffmpeg.wasm core used for
video conversion (which includes FFmpeg and x264) is covered by the GPL; the
details and where to obtain the source are in LICENSES.txt.

== AUTHOR ==
arcana
X: @Arcana_Proxy (https://x.com/Arcana_Proxy)
Contact: aru.oribo@gmail.com
Art and other work: BOOTH https://shitamatsuge-com.booth.pm/

== WHAT THIS SOFTWARE IS, AND RIGHTS ==
This software is an unofficial, non-commercial fan tool made by an individual.
It has no connection to Nintendo Co., Ltd., its affiliates, or any other rights
holder, and it is not licensed, sponsored, endorsed or otherwise approved by
them.

This software is a tool for working with animation data that you created
yourself. It cannot run game software. It does not break any encryption. It has
no feature for obtaining or distributing other people's work over the internet
or anywhere else. It only reads files that are already on your PC - the
animation data the console saves as ordinary files, read as they are.

This software contains no programs, images, sounds, fonts, data or encryption
keys owned by Nintendo Co., Ltd.

"Nintendo 3DS", "Flipnote Studio" and other such names are trademarks or
registered trademarks of Nintendo Co., Ltd. This software mentions them only to
explain which file formats and which environments it supports.

This software assumes you will use it, at your own responsibility, with
animation data you legitimately own. Please do not use it in ways that infringe
anyone else's rights.

== TO RIGHTS HOLDERS ==
If you have any concern about the contents of this software, please contact us
at the address below. We will look into it promptly and take whatever action is
needed.
  Email: aru.oribo@gmail.com
  X (DM): @Arcana_Proxy  https://x.com/Arcana_Proxy
