=====================================================
 MemoAnima v1.5.1
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

== NEW IN v1.5.1 ==
- Batch image import: pick multiple images with the camera button to add
  them as frames (one image = one frame, after the current frame)
- "Don't show again" on confirmations (restore anytime in Settings)
- First-run guide updates and stability improvements

== NEW IN v1.5.0 (the v1.4 series, summarized) ==
- In-app updates (installer edition)
- Selection add/subtract with tinted display
- Multi-layer transform, separate W/H scaling, corner free transform
- Pinned all-frame layers and non-destructive layer color
- Enclose fill, tool mode strips, "My patterns" custom tones,
  per-frame dither shift, modifier+click shortcuts, MP4 loop export

== NEW IN v1.4.7 ==
- "My patterns": select part of your drawing and register it as a tone.
  It appears at the end of the tone list and works in any project (up to 12)
- Each use can keep the registered colors, or use the current color as a
  shape-only pattern
- Works with per-frame shift and the pattern eraser (shape only)

== NEW IN v1.4.6 ==
- New tone option "shift per frame": paint each frame and the dots shift
  slightly, giving a shimmering dither when played back
- Shortcuts can now use modifier + click (Alt+click is the eyedropper
  by default)
- MP4 export gains a "loop count": bake 2-3 seamless loops (audio included)
  into one video - handy for X's gapping loop playback

== NEW IN v1.4.5 ==
- Hover (or re-click) a tool button to see its modes in a strip and switch on the spot
- New "enclose fill" for the fill tool: draw a loop and the inside fills
  instantly with the current color (or the selected tone)
- The right panel is reorganized: tool options on top, a collapsible tone
  list, and the layer list is easier to reach
- The selection "fill with current color" button was removed (the fill tool
  covers it)

== NEW IN v1.4.4 ==
- Layers can be "shared across all frames" (pin): draw a background once and
  it appears on every frame; edit it once and every frame updates
- Layer color: show a layer's artwork in a different color without changing
  the data (light-blue rough sketch etc.). Turn it off anytime
- Fixed: the pen/eraser cursor could stay as a hand after using the hand tool

== NEW IN v1.4.3 ==
- Transform (rotate / scale / flip) now applies to all selected layers and
  folders at once - they rotate around a shared centre.
- Corner (free) transform now works on the drawn area of the layer: the frame
  appears around the artwork. Only the selected layers are affected; hidden
  layers are left alone.
- There are now 8 handles. Dragging the middle of an edge squashes or
  stretches from that side in one move.
- Scale can be applied separately for width and height (two numeric fields).
  When you drag an edge handle, the opposite edge stays put.
- Transform outlines and handles are now thin and stay thin at any zoom.

== NEW IN v1.4.2 ==
- Selections can now add (Shift) and subtract (Alt). Works with rectangle,
  lasso and auto-select; hold the key as you start the drag.
- The selected area is tinted so it is easier to see (turn it off with "Tint"
  in the selection tool's options).
- New "Fill with color": fills the selection with the current color. Combined
  with auto-select set to "whole layer", you can recolor all lines at once.
- New setting to skip the "delete these frames" confirmation (gear menu).
  Ctrl+Z still brings deleted frames back.

== NEW IN v1.4.1 ==
This is the public release, made after verifying the in-app update path with
the real distribution files. Features are the same as v1.4.0 below.

== NEW IN v1.4.0 ==
- There is now an installer. It does not need administrator rights (it installs
  only inside your own user account).
- The app can check whether a newer version is available and tell you about it.
  It never downloads anything on its own - it asks first.
  - It checks once, at startup. You can turn it off any time from the gear icon.
  - Turning it off does not limit any other feature.
  - Even with it off, "Check now" in the gear menu lets you check when you want.
- IMPORTANT: this portable (zip) version cannot update in place. If you press
  "Update now", the installer version is installed as a new copy. Use the
  installer version from then on (your library, settings and autosave carry
  over unchanged).

== NEW IN v1.3.0 ==
This release has two halves: the app now speaks 5 languages, and it carries
twelve milestones of features and fixes built after v1.2.0.

<Languages>
- The app is now available in 5 languages: Japanese, English, Spanish,
  Portuguese (Brazil) and Korean. It follows your Windows display language on
  first launch, and you can change it any time from the gear icon. The change
  takes effect right away - no restart.
- New album and layer names are created in the language you are using at the
  time. Names that already exist are never rewritten.

<Drawing>
- Clipping: show a layer only where the layer directly below it has something
  drawn. Toggle it with the arrow on the layer row.
- Thicken / thin lines by one pixel. Works inside a selection only, if there
  is one.
- Copy and paste a layer. You can also paste the same artwork into that layer
  on every frame - handy for logos and signatures.
- Paper colour can now be transparent. APNG and PNG sequences keep the
  transparency.
- The default palette is now 6 colours (black, white, red, blue, yellow,
  green). The old 14-colour set is still there as "Retro 14 colours".
- Added a pattern eraser and 5 more tone patterns.
- You can choose the drawing cursor (dot / cross / arrow), with an optional
  ring showing the area your nib would paint and an optional box around the
  single pixel under the cursor. Choose "Cross" to get exactly the old look
  back.

<Layout>
- Drag the dividers between the tool column, the right panel and the timeline
  to resize them. Double-click resets. Your layout is remembered.
- Fold each panel away on its own, or press the focus button to fold all three
  and leave just the canvas.
- The preview window can be docked in the timeline so it never covers the
  canvas (this is the new default). You can also float it or hide it.
- While you are drawing, the surrounding overlays fade out. They come back
  when you stop.
- On the home screen, the arrow keys step through frames.

<Exporting>
- Scale is now x1 / x2 / x4 / x8, and the default is x4. We heard from a lot
  of people whose animations looked mangled after posting - social sites
  upscale x1 (320x240) themselves and it falls apart. The dimensions and a
  note on what each scale suits are shown at all times.
- Fixed exported colours coming out duller than they should
  (MP4 now declares BT.709; PNG and APNG carry sRGB information). No pixel
  values were changed.
- Fixed GIF colour shifts and flicker. Animations with 256 colours or fewer
  now export with the colours exactly as drawn.
- Before a large export, MemoAnima now shows the estimated memory, the
  estimated time and how the next scale down would look, and asks you to
  confirm. It never refuses. While exporting, a rough time remaining is shown.

<Fixed>
- Rotation during a transform reached inside the frame, so on a small
  selection you could not move it at all - grabbing the middle rotated it.
  Rotation is now only within 12 pixels outside the frame.
- The hand and transform cursors never actually appeared over the canvas.
  They do now (this had been broken for a long time).
- Pressing F5 or Ctrl+R while editing now asks for confirmation instead of
  reloading straight away (only when you have unsaved changes).
- "Save as" used to preselect the album you last saved into. It now
  preselects the album the animation itself lives in.
- The selection was cleared after erasing its contents. It stays now.
- The timeline heading wrapped to two lines and ate vertical space.
- The image-import palette named after another product has been renamed
  "Classic 6 colours".

<Worth knowing>
- If you open an animation that uses clipping in an older version (v1.2.0 or
  earlier), the clipped parts will spill over. Nothing is damaged, and it
  looks right again in v1.3.0.
- x4 is the scale we recommend. GIF at x8 runs to tens of megabytes, so for
  social media use x4 or MP4.

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
Note: there is also an installer (MemoAnima_1.5.1_x64-setup.exe). Just
double-click it; no administrator rights are needed. IMPORTANT: this portable
(zip) version cannot update in place - accepting an update installs the
installer version instead (see ABOUT NETWORK ACCESS below). Moving from the
portable version to the installer keeps your library, settings and autosave
(they live in the same place either way).

== IF WINDOWS SMARTSCREEN WARNS YOU ==
This is an unsigned app distributed by an individual, so the first launch may
show the blue "Windows protected your PC" screen. That is not a virus
detection - it means "the publisher is not verified". To run it:
  click "More info" -> click "Run anyway"
(If you would rather be careful, scan the file with your antivirus first.)

Note: this warning can appear again each time you update. Unsigned software is
treated as "a file Windows has not seen before" every time the file changes.
The steps are always the same ("More info" -> "Run anyway").

== ABOUT NETWORK ACCESS ==
Drawing, editing and exporting are done entirely on your own device. Every
feature works with no internet connection. The video encoder (ffmpeg.wasm) is
bundled, so everything works offline.

In this version there is exactly one thing the app does on its own: it checks
whether a newer version has been released.
- It checks once, at startup. It only reads a small file at a fixed address that
  says which version is current; it sends nothing about you. The comparison
  happens inside the app on your machine.
- You can turn it off any time from the gear icon. Turning it off does not
  limit any other feature.
- Even when an update is found, nothing is downloaded until you say so.
- If it cannot reach the network, nothing is shown and everything keeps working.
- IMPORTANT: this portable (zip) version cannot update in place. If you press
  "Update now", the installer version is installed as a new copy and this zip
  stays at the old version. Use the installer version from then on (your
  library, settings and autosave carry over; you can delete the zip folder
  afterwards).

Apart from animations you choose to publish, your animation data is never sent
anywhere, and the author never collects a record of which features you use.
This will not change in any future version, on any platform.

== WHERE YOUR DATA LIVES ==
- Your animation library: the folder you chose in the first-run guide
- Settings and autosave: %APPDATA%\com.arcana.memoanima
- Installer version, program files: %LOCALAPPDATA%\MemoAnima

Uninstalling never deletes your animations, your library or your settings.
- Portable version: delete the folder you unzipped.
- Installer version: remove it from "Apps & features" in Windows.
Either way, if you want everything gone, delete the folders above yourself.

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
yourself. It cannot run game software. It does not break any encryption. 3DS
animation files (.kwz / .ppm) are only read from your own device - there is no
feature for obtaining or distributing them over the internet. It reads the
animation data the console saves as ordinary files, as they are.

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
