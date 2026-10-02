# LiveEngine

Live video/GIF wallpapers for **GNOME Shell 49 and 50** on **Ubuntu 26.04 LTS**. Wayland is the supported session. X11 is best-effort.

LiveEngine is a two-process GNOME Shell extension: gnome-shell owns lifecycle, settings, and stacking; a separate GTK4 + GStreamer process decodes frames. A decoder crash cannot take down the shell.

## Architecture

### Why not in-shell Clutter / Gst?

Playing GStreamer inside gnome-shell (the Hanabi / BenthicBloom approach) is simpler to composite: you attach a `Clutter.Actor` to `Main.layoutManager._backgroundGroup` and never fight Wayland stacking. The cost is that a bad file, a VA-API reset, or a Gst plugin abort kills the compositor.

LiveEngine therefore **decodes out of process** with `gtk4paintablesink`, as specified.

### How LiveEngine occupies the GNOME wallpaper layer

Mutter does **not** implement `zwlr_layer_shell_v1`. A normal GTK window cannot put itself behind other clients. LiveEngine uses a Mutter-owned Wayland client and makes its compositor actor the visible wallpaper layer:

1. The extension starts the renderer with `Meta.WaylandClient.new_subprocess(global.context, launcher, argv)` so Mutter owns a trusted Wayland socket (`WAYLAND_SOCKET`).
2. When the window appears, the extension calls GNOME 49/50 APIs: `Meta.Window.set_type(DESKTOP)` and `Meta.Window.hide_from_window_list()`.
3. The window actor is reparented into `_backgroundGroup`, sized to the monitor, and raised above the static wallpaper actor.
4. Existing static wallpaper actors are hidden while LiveEngine is active, so Mutter does not alternate between the stock and live layers during app creation, focus changes, or minimization.
5. The GTK surface uses an empty input region so clicks pass through to the desktop.

Fallback: if `new_subprocess` is missing or fails, a plain `Gio.Subprocess` is used. This fallback may have less reliable Wayland stacking.

### IPC

Session D-Bus name `org.gnome.Shell.Extensions.LiveEngine`, object `/org/gnome/Shell/Extensions/LiveEngine`:

`Play`, `Pause`, `Resume`, `Quit`, `SetSource`, `SetMute`, `SetVolume`, `SetScaleMode`, `SetFps`, `SetCrossfade`, `SetPausedMonitors`, `Validate`, `HasAudio`.

Signals: `Ready`, `Error`, `Eos`, `HasAudioChanged`.

### Hybrid GPU

The renderer process is launched with `__NV_PRIME_RENDER_OFFLOAD=0`, empty `CUDA_VISIBLE_DEVICES`, and NVIDIA Gst elements ranked `NONE`. VA-API decoders (`vah264dec`, `vah265dec`, `vaav1dec`, …) are ranked above software. The dGPU should stay in D3 if the compositor itself is not using it.

## Features

- MP4 (H.264/H.265/AV1 where Gst + VA-API allow), WebM, MKV/MOV, animated GIF
- Seamless loop via `playbin` `about-to-finish`
- Fill / fit / stretch / center
- Same wallpaper on every monitor (one decoder, many `Gtk.Picture` widgets sharing the `GdkPaintable`)
- Folder or explicit playlist, 1–15 minute interval, sequential or shuffle, live interval changes
- Optional crossfade (`Gtk.Stack`)
- `session-modes`: `user` + `unlock-dialog`; optional pause on the lock screen
- Pause when fullscreen (per monitor) or when a maximized window covers the monitor
- Pause on low battery via UPower `DisplayDevice` property changes (hidden when there is no battery)
- Mute default on; live volume; no error when the file has no audio
- Frame-rate cap (default 30) via `videorate max-rate`
- Pipeline `PAUSED` when idle; `NULL` after 90 seconds to free the decoder
- Auto-restart with exponential backoff, max 3 times, then a shell notification
- Suspend/resume via `org.freedesktop.login1.Manager.PrepareForSleep`
- Monitor hotplug: wallpaper windows are re-claimed and re-laid out
- App open, focus, and minimize transitions preserve the live wallpaper layer without replacing it

## Install (Ubuntu 26.04)

```bash
chmod +x install.sh
./install.sh
```

The script installs GStreamer/GTK GI packages, compiles `schemas/`, and copies the extension to `~/.local/share/gnome-shell/extensions/liveengine@gurmeet-gupta.github.io`.

**Wayland:** log out and back in after installation or code updates, then enable LiveEngine in the Extensions app (or `gnome-extensions enable liveengine@gurmeet-gupta.github.io`). GNOME Shell does not reliably hot-reload this extension on Wayland.

Open **LiveEngine Settings**, pick an MP4 or GIF, and wait for the startup delay (1.5 s by default).

Enjoy!!