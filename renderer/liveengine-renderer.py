#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-2.0-or-later
"""LiveEngine wallpaper renderer: GTK4 + GStreamer gtk4paintablesink.

Runs out of process so a decoder fault cannot take down gnome-shell.
Controlled over session D-Bus (org.gnome.Shell.Extensions.LiveEngine).
"""

from __future__ import annotations

import os
import sys
import traceback

# Prefer the Intel/AMD iGPU for VA-API and never offload onto NVIDIA.
os.environ.setdefault("__NV_PRIME_RENDER_OFFLOAD", "0")
os.environ.setdefault("__GLX_VENDOR_LIBRARY_NAME", "mesa")
os.environ.setdefault("__VK_LAYER_NV_optimus", "non_NVIDIA_only")
os.environ.pop("CUDA_VISIBLE_DEVICES", None)
os.environ["CUDA_VISIBLE_DEVICES"] = ""
if os.environ.get("LIBVA_DRIVER_NAME", "").lower() in ("nvidia", "nvdec", "vdpau"):
    os.environ["LIBVA_DRIVER_NAME"] = "iHD"

import gi

gi.require_version("Gtk", "4.0")
gi.require_version("Gdk", "4.0")
gi.require_version("Gst", "1.0")
gi.require_version("GstPbutils", "1.0")
gi.require_version("Gio", "2.0")
gi.require_version("GLib", "2.0")

from gi.repository import Gdk, Gio, GLib, Gst, GstPbutils, Gtk

try:
    import cairo
except ImportError:
    cairo = None

BUS_NAME = "org.gnome.Shell.Extensions.LiveEngine"
OBJECT_PATH = "/org/gnome/Shell/Extensions/LiveEngine"
IFACE_NAME = "org.gnome.Shell.Extensions.LiveEngine"
APP_ID = "io.github.liveengine.Renderer"
WINDOW_TITLE_PREFIX = "LiveEngine-Wallpaper"

IFACE_XML = """
<node>
  <interface name="org.gnome.Shell.Extensions.LiveEngine">
    <method name="Play"/>
    <method name="Pause"/>
    <method name="Resume"/>
    <method name="Quit"/>
    <method name="SetSource">
      <arg type="s" name="path" direction="in"/>
    </method>
    <method name="SetMute">
      <arg type="b" name="mute" direction="in"/>
    </method>
    <method name="SetVolume">
      <arg type="d" name="volume" direction="in"/>
    </method>
    <method name="SetScaleMode">
      <arg type="s" name="mode" direction="in"/>
    </method>
    <method name="SetFps">
      <arg type="i" name="fps" direction="in"/>
    </method>
    <method name="SetCrossfade">
      <arg type="b" name="enabled" direction="in"/>
      <arg type="i" name="duration_ms" direction="in"/>
    </method>
    <method name="SetPausedMonitors">
      <arg type="ai" name="indexes" direction="in"/>
    </method>
    <method name="Validate">
      <arg type="s" name="path" direction="in"/>
      <arg type="b" name="ok" direction="out"/>
      <arg type="s" name="message" direction="out"/>
    </method>
    <method name="HasAudio">
      <arg type="b" name="has_audio" direction="out"/>
    </method>
    <signal name="Error">
      <arg type="s" name="message"/>
    </signal>
    <signal name="Ready"/>
    <signal name="Eos"/>
    <signal name="HasAudioChanged">
      <arg type="b" name="has_audio"/>
    </signal>
  </interface>
</node>
"""

CONTENT_FIT = {
    "fill": Gtk.ContentFit.COVER,
    "fit": Gtk.ContentFit.CONTAIN,
    "stretch": Gtk.ContentFit.FILL,
    "center": Gtk.ContentFit.SCALE_DOWN,
}

VA_DECODERS = (
    "vah264dec",
    "vah265dec",
    "vaav1dec",
    "vavp9dec",
    "vajpegdec",
    "vaapih264dec",
    "vaapih265dec",
    "vaapivp9dec",
    "vaapipostproc",
    "vapostproc",
)
NVIDIA_DECODERS = (
    "nvh264dec",
    "nvh265dec",
    "nvav1dec",
    "nvvp9dec",
    "nvv4l2decoder",
    "nvdec",
    "nvcudahybrid",
    "cudah264dec",
    "cudah265dec",
)

LONG_PAUSE_MS = 90_000

# VIDEO | AUDIO | SOFT_VOLUME | DEINTERLACE | SOFT_COLORBALANCE.
# Native-video overlays use a black colour-key, which makes dark pixels flicker.
PLAY_FLAGS = 0x0001 | 0x0002 | 0x0010 | 0x0200 | 0x0400

# GstGtk4Paintable stores GdkRGBA as 0xRRGGBBAA. Opaque black, not transparent.
OPAQUE_BLACK = 0x000000FF


def log(message: str) -> None:
    print(f"liveengine-renderer: {message}", file=sys.stderr, flush=True)


def prefer_vaapi() -> None:
    registry = Gst.Registry.get()
    for name in NVIDIA_DECODERS:
        feature = registry.find_feature(name, Gst.ElementFactory.__gtype__)
        if feature is not None:
            feature.set_rank(Gst.Rank.NONE)
    for name in VA_DECODERS:
        feature = registry.find_feature(name, Gst.ElementFactory.__gtype__)
        if feature is not None:
            feature.set_rank(Gst.Rank.PRIMARY + 256)


def path_to_uri(path: str) -> str:
    if path.startswith("file:"):
        return path
    return Gio.File.new_for_path(path).get_uri()


def looks_like_media(path: str) -> bool:
    lower = (path or "").lower()
    return lower.endswith((".mp4", ".m4v", ".webm", ".gif", ".mkv", ".mov"))


def source_is_readable(path: str) -> tuple[bool, str]:
    if not path:
        return False, "No file selected"
    file = Gio.File.new_for_path(path)
    if not file.query_exists(None):
        return False, f"File not found: {path}"
    if not looks_like_media(path):
        return False, "Unsupported type. Use MP4, WebM, MKV, MOV, or GIF."
    return True, "ok"


def validate_file(path: str) -> tuple[bool, str]:
    if not path:
        return False, "No file selected"
    file = Gio.File.new_for_path(path)
    if not file.query_exists(None):
        return False, f"File not found: {path}"
    try:
        discoverer = GstPbutils.Discoverer.new(5 * Gst.SECOND)
        info = discoverer.discover_uri(path_to_uri(path))
        result = info.get_result()
        if result != GstPbutils.DiscovererResult.OK:
            return False, f"Unsupported or corrupt media ({result.value_nick})"
        if info.get_video_streams():
            return True, "ok"
        # Animated GIFs sometimes surface as a container without a video stream
        # until decodebin runs; still accept common image/gif types.
        info_str = info.to_string() or ""
        if "image/gif" in info_str or path.lower().endswith(".gif"):
            return True, "ok"
        return False, "File has no video or animation track"
    except GLib.Error as err:
        return False, err.message


def _try_set(element, name: str, value) -> None:
    if element is None:
        return
    try:
        element.set_property(name, value)
    except Exception:
        pass


def make_video_sink(fps: int):
    """Opaque RGB sink. Avoid GL overlay/alpha paths that sparkle on black pixels."""
    gtksink = Gst.ElementFactory.make("gtk4paintablesink", "gtksink")
    if gtksink is None:
        raise RuntimeError(
            "GStreamer element gtk4paintablesink is missing. "
            "Install gstreamer1.0-gtk4."
        )
    _try_set(gtksink, "qos", False)
    _try_set(gtksink, "sync", True)

    paintable = gtksink.get_property("paintable")
    _try_set(paintable, "background-color", OPAQUE_BLACK)
    _try_set(paintable, "force-aspect-ratio", False)

    convert = Gst.ElementFactory.make("videoconvert", "videoconvert")
    _try_set(convert, "n-threads", 0)
    _try_set(convert, "qos", False)

    caps = Gst.ElementFactory.make("capsfilter", "opaque-caps")
    if caps is not None:
        caps.set_property(
            "caps",
            Gst.Caps.from_string("video/x-raw,format=(string){RGBx,BGRx}"),
        )

    rate = Gst.ElementFactory.make("videorate", "videorate")
    _try_set(rate, "max-rate", int(fps))
    _try_set(rate, "drop-only", True)
    _try_set(rate, "skip-to-first", True)

    chain = [item for item in (convert, rate, caps, gtksink) if item is not None]
    wrap = Gst.Bin.new("liveengine-videosink")
    for element in chain:
        wrap.add(element)

    linked = True
    for left, right in zip(chain, chain[1:]):
        if not left.link(right):
            linked = False
            break

    if not linked:
        wrap = Gst.Bin.new("liveengine-videosink")
        wrap.add(gtksink)
        chain = [gtksink]

    pad = chain[0].get_static_pad("sink")
    wrap.add_pad(Gst.GhostPad.new("sink", pad))
    wrap._videorate = rate if linked else None
    return wrap, paintable, (rate if linked else None)


class Player:
    def __init__(self, app: "RendererApp", slot: str):
        self.app = app
        self.slot = slot
        self.playbin = None
        self.paintable = None
        self.has_audio = False
        self.uri = ""
        self._bus = None
        self._about_id = None
        self._rate = None
        self._inv_id = 0
        self._ready_timeout_id = 0
        self._ready_cb = None
        self._ready_gen = 0
        self._ready_token = 0
        self._awaiting_preroll = False
        self._rebuild(app.fps)

    def _rebuild(self, fps: int) -> None:
        self.stop(to_null=True)
        self._disconnect_paintable()
        playbin = Gst.ElementFactory.make("playbin3", f"playbin-{self.slot}")
        if playbin is None:
            playbin = Gst.ElementFactory.make("playbin", f"playbin-{self.slot}")
        if playbin is None:
            raise RuntimeError("GStreamer playbin is not available")

        video_sink, paintable, rate = make_video_sink(fps)
        playbin.set_property("video-sink", video_sink)
        playbin.set_property("volume", self.app.volume)
        playbin.set_property("mute", self.app.mute)
        try:
            playbin.set_property("flags", PLAY_FLAGS)
        except Exception:
            pass

        self.playbin = playbin
        self.paintable = paintable
        self._rate = rate
        self._bus = playbin.get_bus()
        self._bus.add_signal_watch()
        self._bus.connect("message", self._on_bus)
        self._about_id = playbin.connect("about-to-finish", self._on_about_to_finish)

    def set_fps(self, fps: int) -> None:
        _try_set(self._rate, "max-rate", int(fps))

    def _disconnect_paintable(self) -> None:
        if self.paintable is not None and self._inv_id:
            try:
                self.paintable.disconnect(self._inv_id)
            except Exception:
                pass
        self._inv_id = 0

    def _cancel_ready(self) -> None:
        self._ready_gen += 1
        self._ready_cb = None
        self._awaiting_preroll = False
        if self._ready_timeout_id:
            GLib.Source.remove(self._ready_timeout_id)
            self._ready_timeout_id = 0
        self._disconnect_paintable()

    def set_uri(self, uri: str) -> None:
        self._cancel_ready()
        self.uri = uri
        if self.playbin is None:
            return
        # NULL first so playbin does not gapless-queue the URI behind the current clip.
        self.playbin.set_state(Gst.State.NULL)
        self.playbin.set_property("uri", uri)

    def play(self) -> None:
        if self.playbin is not None:
            self.playbin.set_state(Gst.State.PLAYING)

    def play_when_ready(self, callback) -> None:
        """Start playback and invoke callback after preroll (first frame at sink)."""
        self._cancel_ready()
        self._ready_token = self._ready_gen
        self._ready_cb = callback
        self._awaiting_preroll = True
        self._ready_timeout_id = GLib.timeout_add(2500, self._fire_ready)
        self.play()

    def _fire_ready(self, *_args) -> bool:
        if not self._awaiting_preroll or self._ready_token != self._ready_gen:
            return GLib.SOURCE_REMOVE
        cb = self._ready_cb
        if cb is None:
            return GLib.SOURCE_REMOVE
        self._awaiting_preroll = False
        self._ready_cb = None
        timeout_id = self._ready_timeout_id
        self._ready_timeout_id = 0
        if timeout_id:
            try:
                GLib.Source.remove(timeout_id)
            except Exception:
                pass
        self._disconnect_paintable()
        cb()
        return GLib.SOURCE_REMOVE

    def pause(self) -> None:
        if self.playbin is not None:
            self.playbin.set_state(Gst.State.PAUSED)

    def stop(self, to_null: bool = False) -> None:
        self._cancel_ready()
        if self.playbin is None:
            return
        self.playbin.set_state(Gst.State.NULL if to_null else Gst.State.READY)

    def seek_start(self) -> None:
        self.playbin.seek_simple(
            Gst.Format.TIME,
            Gst.SeekFlags.FLUSH | Gst.SeekFlags.KEY_UNIT | Gst.SeekFlags.SEGMENT,
            0,
        )

    def apply_audio(self) -> None:
        if self.playbin is None:
            return
        self.playbin.set_property("mute", self.app.mute)
        self.playbin.set_property("volume", max(0.0, min(1.0, self.app.volume)))

    def query_has_audio(self) -> bool:
        n = 0
        try:
            n = int(self.playbin.get_property("n-audio") or 0)
        except (TypeError, AttributeError):
            try:
                sink = self.playbin.get_property("audio-sink")
                if sink:
                    n = 1
            except Exception:
                n = 0
        self.has_audio = n > 0
        return self.has_audio

    def _on_about_to_finish(self, _playbin) -> None:
        if self.uri:
            self.playbin.set_property("uri", self.uri)

    def _on_bus(self, _bus, message) -> None:
        t = message.type
        if t == Gst.MessageType.ERROR:
            err, debug = message.parse_error()
            self.app.emit_error(f"{err.message} ({debug or ''})".strip())
        elif t == Gst.MessageType.EOS:
            self.seek_start()
            self.play()
            self.app.emit_signal("Eos", None)
        elif t == Gst.MessageType.STATE_CHANGED:
            if message.src == self.playbin:
                _old, new, _pending = message.parse_state_changed()
                if new == Gst.State.PLAYING:
                    has_audio = self.query_has_audio()
                    self.app.notify_has_audio(has_audio)
        elif t == Gst.MessageType.STREAM_COLLECTION:
            has_audio = self.query_has_audio()
            self.app.notify_has_audio(has_audio)
        elif t == Gst.MessageType.ASYNC_DONE:
            if message.src == self.playbin and self._awaiting_preroll:
                state = self.playbin.get_state(0)[1]
                if state in (Gst.State.PAUSED, Gst.State.PLAYING):
                    self._fire_ready()

    def dispose(self) -> None:
        self._cancel_ready()
        if self.playbin is None:
            return
        if self._bus is not None:
            self._bus.remove_signal_watch()
        if self._about_id is not None:
            try:
                self.playbin.disconnect(self._about_id)
            except Exception:
                pass
        self.playbin.set_state(Gst.State.NULL)
        self.playbin = None
        self._rate = None


class WallpaperWindow(Gtk.ApplicationWindow):
    def __init__(self, app: "RendererApp", monitor: Gdk.Monitor, index: int):
        super().__init__(application=app, title=f"{WINDOW_TITLE_PREFIX}-{index}")
        self.monitor_index = index
        self.set_decorated(False)
        self.set_resizable(False)
        self.set_deletable(False)
        self.set_focusable(False)
        self.set_can_focus(False)
        self.set_opacity(1.0)
        self.set_default_size(monitor.get_geometry().width, monitor.get_geometry().height)

        css = Gtk.CssProvider()
        css.load_from_data(
            b"window, overlay, picture { background-color: #000000; background: #000000; }"
        )
        self.get_style_context().add_provider(css, Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION)

        # Keep both pictures mapped so gtk4paintablesink can preroll the hidden
        # player. Gtk.Stack unmaps the hidden child, which made the first switch
        # flash black and keep the old file.
        self._overlay = Gtk.Overlay(hexpand=True, vexpand=True)
        self.picture_a = Gtk.Picture(hexpand=True, vexpand=True)
        self.picture_b = Gtk.Picture(hexpand=True, vexpand=True)
        fit = CONTENT_FIT.get(app.scale_mode, Gtk.ContentFit.COVER)
        self.picture_a.set_content_fit(fit)
        self.picture_b.set_content_fit(fit)
        self._overlay.set_child(self.picture_a)
        self._overlay.add_overlay(self.picture_b)
        self.picture_b.set_opacity(0.0)
        self.picture_a.set_opacity(1.0)
        self.set_child(self._overlay)
        self._slot = "a"
        self._fade_id = 0
        self._crossfade_ms = app.crossfade_ms if app.crossfade else 0

        self.connect("realize", self._on_realize)

    def _on_realize(self, *_args) -> None:
        try:
            surface = self.get_surface()
            if surface is None:
                return
            self._apply_surface_regions(surface)
            for name in ("notify::width", "notify::height", "layout"):
                try:
                    surface.connect(name, lambda *_: self._apply_surface_regions(surface))
                except TypeError:
                    pass
        except Exception as err:
            log(f"could not configure surface regions: {err}")

    def _apply_surface_regions(self, surface) -> None:
        if cairo is None:
            return
        try:
            width = max(1, surface.get_width())
            height = max(1, surface.get_height())
            full = cairo.Region(cairo.RectangleInt(0, 0, width, height))
            surface.set_opaque_region(full)
            surface.set_input_region(cairo.Region())
        except Exception as err:
            log(f"could not set opaque/input regions: {err}")

    def bind_paintables(self, a, b) -> None:
        if a is not None:
            self.picture_a.set_paintable(a)
        if b is not None:
            self.picture_b.set_paintable(b)

    def show_slot(self, slot: str) -> None:
        self.transition_to(slot, 0)

    def transition_to(self, slot: str, duration_ms: int) -> None:
        if self._fade_id:
            GLib.Source.remove(self._fade_id)
            self._fade_id = 0
        self._slot = slot
        target_a = 1.0 if slot == "a" else 0.0
        target_b = 1.0 if slot == "b" else 0.0
        if duration_ms <= 0:
            self.picture_a.set_opacity(target_a)
            self.picture_b.set_opacity(target_b)
            return

        start_a = self.picture_a.get_opacity()
        start_b = self.picture_b.get_opacity()
        t0 = GLib.get_monotonic_time()
        duration_us = max(1, int(duration_ms)) * 1000

        def tick():
            p = min(1.0, (GLib.get_monotonic_time() - t0) / duration_us)
            e = p * p * (3.0 - 2.0 * p)
            self.picture_a.set_opacity(start_a + (target_a - start_a) * e)
            self.picture_b.set_opacity(start_b + (target_b - start_b) * e)
            if p >= 1.0:
                self._fade_id = 0
                return GLib.SOURCE_REMOVE
            return GLib.SOURCE_CONTINUE

        self._fade_id = GLib.timeout_add(16, tick)

    def apply_scale(self, mode: str) -> None:
        fit = CONTENT_FIT.get(mode, Gtk.ContentFit.COVER)
        self.picture_a.set_content_fit(fit)
        self.picture_b.set_content_fit(fit)

    def apply_crossfade(self, enabled: bool, duration_ms: int) -> None:
        self._crossfade_ms = duration_ms if enabled else 0


class RendererApp(Gtk.Application):
    def __init__(self):
        super().__init__(application_id=APP_ID, flags=Gio.ApplicationFlags.NON_UNIQUE)
        self.windows: list[WallpaperWindow] = []
        self.player_a: Player | None = None
        self.player_b: Player | None = None
        self.active_slot = "a"
        self.mute = True
        self.volume = 0.0
        self.scale_mode = "fill"
        self.fps = 30
        self.crossfade = True
        self.crossfade_ms = 600
        self.paused_monitors: set[int] = set()
        self.user_paused = False
        self.has_audio = False
        self.connection = None
        self.owner_id = 0
        self.registration_id = 0
        self._long_pause_id = 0
        self._stop_id = 0
        self._switch_token = 0
        self._node_info = Gio.DBusNodeInfo.new_for_xml(IFACE_XML)

    def do_startup(self):
        Gtk.Application.do_startup(self)
        Gst.init([])
        GstPbutils.pb_utils_init()
        prefer_vaapi()
        self.player_a = Player(self, "a")
        self.player_b = Player(self, "b")
        self.owner_id = Gio.bus_own_name(
            Gio.BusType.SESSION,
            BUS_NAME,
            Gio.BusNameOwnerFlags.NONE,
            self._on_bus_acquired,
            self._on_name_acquired,
            self._on_name_lost,
        )

    def do_activate(self):
        if self.windows:
            return
        display = Gdk.Display.get_default()
        monitors = display.get_monitors()
        count = monitors.get_n_items()
        if count == 0:
            self.windows.append(self._fallback_window(0))
            return
        for i in range(count):
            monitor = monitors.get_item(i)
            win = WallpaperWindow(self, monitor, i)
            win.bind_paintables(self.player_a.paintable, self.player_b.paintable)
            win.show_slot(self.active_slot)
            win.present()
            self.windows.append(win)

    def _fallback_window(self, index):
        geo = Gdk.Rectangle()
        geo.width, geo.height = 640, 360
        class _Mon:
            def get_geometry(self_mon):
                return geo
        win = WallpaperWindow(self, _Mon(), index)
        win.bind_paintables(self.player_a.paintable, self.player_b.paintable)
        win.show_slot(self.active_slot)
        win.present()
        return win

    def _on_bus_acquired(self, connection, _name):
        self.connection = connection
        self.registration_id = connection.register_object(
            OBJECT_PATH,
            self._node_info.interfaces[0],
            self._on_method_call,
            None,
            None,
        )

    def _on_name_acquired(self, _connection, _name):
        self.emit_signal("Ready", None)
        log("D-Bus name acquired")

    def _on_name_lost(self, _connection, _name):
        log("D-Bus name lost")

    def emit_signal(self, name: str, params):
        if self.connection is None:
            return
        self.connection.emit_signal(None, OBJECT_PATH, IFACE_NAME, name, params)

    def emit_error(self, message: str) -> None:
        log(message)
        self.emit_signal("Error", GLib.Variant("(s)", (message,)))

    def notify_has_audio(self, has_audio: bool) -> None:
        if has_audio == self.has_audio:
            return
        self.has_audio = has_audio
        self.emit_signal("HasAudioChanged", GLib.Variant("(b)", (has_audio,)))

    def active_player(self) -> Player:
        return self.player_a if self.active_slot == "a" else self.player_b

    def inactive_player(self) -> Player:
        return self.player_b if self.active_slot == "a" else self.player_a

    def play_source(self, path: str) -> None:
        ok, message = source_is_readable(path)
        if not ok:
            self.emit_error(message)
            return
        uri = path_to_uri(path)
        current = self.active_player()
        if current.uri == uri:
            state = current.playbin.get_state(0)[1] if current.playbin else Gst.State.NULL
            if state in (Gst.State.PLAYING, Gst.State.PAUSED):
                if not self.user_paused:
                    current.play()
                return

        self._cancel_pending_stop()
        self._switch_token += 1
        token = self._switch_token
        outgoing = current if current.uri else None
        incoming = self.inactive_player() if outgoing is not None else current

        incoming.set_uri(uri)
        incoming.apply_audio()
        for window in self.windows:
            window.bind_paintables(self.player_a.paintable, self.player_b.paintable)

        def on_ready():
            if token != self._switch_token:
                return
            duration = self.crossfade_ms if (self.crossfade and outgoing is not None) else 0
            for window in self.windows:
                window.transition_to(incoming.slot, duration)
            self.active_slot = incoming.slot
            if outgoing is not None and outgoing is not incoming:
                delay = duration + 80
                self._stop_id = GLib.timeout_add(
                    max(80, delay), self._stop_outgoing, outgoing
                )
            self._cancel_long_pause()

        incoming.play_when_ready(on_ready)

    def _cancel_pending_stop(self) -> None:
        if self._stop_id:
            GLib.Source.remove(self._stop_id)
            self._stop_id = 0

    def _stop_outgoing(self, player: Player):
        self._stop_id = 0
        if player is not self.active_player():
            player.stop(to_null=True)
        return GLib.SOURCE_REMOVE

    def pause_playback(self) -> None:
        self.active_player().pause()
        self._schedule_long_pause()

    def resume_playback(self) -> None:
        self._cancel_long_pause()
        player = self.active_player()
        if not player.uri:
            return
        player.apply_audio()
        player.play()

    def _schedule_long_pause(self) -> None:
        self._cancel_long_pause()
        self._long_pause_id = GLib.timeout_add(LONG_PAUSE_MS, self._go_null)

    def _go_null(self):
        self.active_player().stop(to_null=True)
        self._long_pause_id = 0
        return GLib.SOURCE_REMOVE

    def _cancel_long_pause(self) -> None:
        if self._long_pause_id:
            GLib.Source.remove(self._long_pause_id)
            self._long_pause_id = 0

    def apply_paused_monitors(self) -> None:
        n = len(self.windows)
        all_paused = n > 0 and all(i in self.paused_monitors for i in range(n))
        for window in self.windows:
            hidden = window.monitor_index in self.paused_monitors
            window.set_opacity(0.0 if hidden else 1.0)
        if all_paused:
            self.pause_playback()
        elif not self.user_paused:
            self.resume_playback()

    def _on_method_call(
        self, _connection, _sender, _path, _iface, method, parameters, invocation
    ):
        try:
            self._dispatch(method, parameters, invocation)
        except Exception:
            self.emit_error(traceback.format_exc())
            invocation.return_error_literal(
                Gio.dbus_error_quark(),
                Gio.DBusError.FAILED,
                "LiveEngine renderer method failed",
            )

    def _dispatch(self, method, parameters, invocation):
        if method == "Play":
            self.resume_playback()
            invocation.return_value(None)
        elif method == "Pause":
            self.user_paused = True
            self.pause_playback()
            invocation.return_value(None)
        elif method == "Resume":
            self.user_paused = False
            self.resume_playback()
            invocation.return_value(None)
        elif method == "Quit":
            invocation.return_value(None)
            GLib.idle_add(self.quit)
        elif method == "SetSource":
            (path,) = parameters.unpack()
            self.play_source(path)
            invocation.return_value(None)
        elif method == "SetMute":
            (self.mute,) = parameters.unpack()
            self.player_a.apply_audio()
            self.player_b.apply_audio()
            invocation.return_value(None)
        elif method == "SetVolume":
            (self.volume,) = parameters.unpack()
            self.player_a.apply_audio()
            self.player_b.apply_audio()
            invocation.return_value(None)
        elif method == "SetScaleMode":
            (self.scale_mode,) = parameters.unpack()
            for window in self.windows:
                window.apply_scale(self.scale_mode)
            invocation.return_value(None)
        elif method == "SetFps":
            (self.fps,) = parameters.unpack()
            self.player_a.set_fps(self.fps)
            self.player_b.set_fps(self.fps)
            invocation.return_value(None)
        elif method == "SetCrossfade":
            enabled, duration = parameters.unpack()
            self.crossfade = bool(enabled)
            self.crossfade_ms = int(duration)
            for window in self.windows:
                window.apply_crossfade(self.crossfade, self.crossfade_ms)
            invocation.return_value(None)
        elif method == "SetPausedMonitors":
            (indexes,) = parameters.unpack()
            self.paused_monitors = set(int(i) for i in indexes)
            self.apply_paused_monitors()
            invocation.return_value(None)
        elif method == "Validate":
            (path,) = parameters.unpack()
            ok, message = validate_file(path)
            invocation.return_value(GLib.Variant("(bs)", (ok, message)))
        elif method == "HasAudio":
            invocation.return_value(GLib.Variant("(b)", (self.has_audio,)))
        else:
            invocation.return_error_literal(
                Gio.dbus_error_quark(),
                Gio.DBusError.UNKNOWN_METHOD,
                method,
            )

    def do_shutdown(self):
        self._switch_token += 1
        self._cancel_pending_stop()
        self._cancel_long_pause()
        if self.player_a:
            self.player_a.dispose()
        if self.player_b:
            self.player_b.dispose()
        if self.connection and self.registration_id:
            self.connection.unregister_object(self.registration_id)
        if self.owner_id:
            Gio.bus_unown_name(self.owner_id)
        Gtk.Application.do_shutdown(self)


def main() -> int:
    app = RendererApp()
    return app.run(sys.argv)


if __name__ == "__main__":
    sys.exit(main())
