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


def make_video_sink(fps: int):
    gtksink = Gst.ElementFactory.make("gtk4paintablesink", "gtksink")
    if gtksink is None:
        raise RuntimeError(
            "GStreamer element gtk4paintablesink is missing. "
            "Install gstreamer1.0-gtk4."
        )
    paintable = gtksink.get_property("paintable")

    rate = Gst.ElementFactory.make("videorate", "videorate")
    if rate is not None:
        try:
            rate.set_property("max-rate", int(fps))
        except Exception:
            pass

    wrap = Gst.Bin.new("liveengine-videosink")
    sink_tail = gtksink
    gl_context = None
    try:
        gl_context = paintable.get_property("gl-context")
    except Exception:
        gl_context = None

    if gl_context is not None:
        glbin = Gst.ElementFactory.make("glsinkbin", "glsinkbin")
        if glbin is not None:
            glbin.set_property("sink", gtksink)
            sink_tail = glbin

    if rate is not None:
        wrap.add(rate)
        wrap.add(sink_tail)
        if not rate.link(sink_tail):
            wrap.remove(rate)
            pad = sink_tail.get_static_pad("sink")
            wrap.add_pad(Gst.GhostPad.new("sink", pad))
        else:
            pad = rate.get_static_pad("sink")
            wrap.add_pad(Gst.GhostPad.new("sink", pad))
    else:
        wrap.add(sink_tail)
        pad = sink_tail.get_static_pad("sink")
        wrap.add_pad(Gst.GhostPad.new("sink", pad))

    return wrap, paintable


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
        self._rebuild(app.fps)

    def _rebuild(self, fps: int) -> None:
        self.stop(to_null=True)
        playbin = Gst.ElementFactory.make("playbin3", f"playbin-{self.slot}")
        if playbin is None:
            playbin = Gst.ElementFactory.make("playbin", f"playbin-{self.slot}")
        if playbin is None:
            raise RuntimeError("GStreamer playbin is not available")

        video_sink, paintable = make_video_sink(fps)
        playbin.set_property("video-sink", video_sink)
        playbin.set_property("volume", self.app.volume)
        playbin.set_property("mute", self.app.mute)

        flags = playbin.get_property("flags")
        # Keep audio + video; buffer and vis off. Soft-volume stays on.
        try:
            playbin.set_property("flags", flags | 0x0003)
        except Exception:
            pass

        self.playbin = playbin
        self.paintable = paintable
        self._bus = playbin.get_bus()
        self._bus.add_signal_watch()
        self._bus.connect("message", self._on_bus)
        self._about_id = playbin.connect("about-to-finish", self._on_about_to_finish)

    def set_fps(self, fps: int) -> None:
        uri = self.uri
        state = self.playbin.get_state(0)[1] if self.playbin else Gst.State.NULL
        self._rebuild(fps)
        if uri:
            self.set_uri(uri)
            if state == Gst.State.PLAYING:
                self.play()
            elif state == Gst.State.PAUSED:
                self.pause()

    def set_uri(self, uri: str) -> None:
        self.uri = uri
        self.playbin.set_property("uri", uri)

    def play(self) -> None:
        self.playbin.set_state(Gst.State.PLAYING)

    def pause(self) -> None:
        self.playbin.set_state(Gst.State.PAUSED)

    def stop(self, to_null: bool = False) -> None:
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
        # playbin3 doesn't have 'n-audio' property; try multiple approaches
        try:
            n = int(self.playbin.get_property("n-audio") or 0)
        except TypeError:
            # playbin3: check n-audio on the underlying uridecodebin/decoder
            try:
                n = int(self.playbin.get_property("n-audio") or 0)
            except TypeError:
                # Fallback: query via get_property on the actual audio sink or use stream collection
                # For now, assume has audio if any audio pad exists
                n = 0
                try:
                    # Try to get audio pads from the pipeline
                    pads = self.playbin.get_property("audio-sink")
                    if pads:
                        n = 1
                except:
                    pass
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

    def dispose(self) -> None:
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


class WallpaperWindow(Gtk.ApplicationWindow):
    def __init__(self, app: "RendererApp", monitor: Gdk.Monitor, index: int):
        super().__init__(application=app, title=f"{WINDOW_TITLE_PREFIX}-{index}")
        self.monitor_index = index
        self.set_decorated(False)
        self.set_resizable(False)
        self.set_deletable(False)
        self.set_focusable(False)
        self.set_can_focus(False)
        self.set_default_size(monitor.get_geometry().width, monitor.get_geometry().height)

        css = Gtk.CssProvider()
        css.load_from_data(b"window { background: #000; }")
        self.get_style_context().add_provider(css, Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION)

        self.stack = Gtk.Stack(
            transition_type=Gtk.StackTransitionType.CROSSFADE,
            transition_duration=app.crossfade_ms if app.crossfade else 0,
            hexpand=True,
            vexpand=True,
        )
        self.picture_a = Gtk.Picture(hexpand=True, vexpand=True)
        self.picture_b = Gtk.Picture(hexpand=True, vexpand=True)
        self.picture_a.set_content_fit(CONTENT_FIT.get(app.scale_mode, Gtk.ContentFit.COVER))
        self.picture_b.set_content_fit(CONTENT_FIT.get(app.scale_mode, Gtk.ContentFit.COVER))
        self.stack.add_named(self.picture_a, "a")
        self.stack.add_named(self.picture_b, "b")
        self.set_child(self.stack)

        self.connect("realize", self._on_realize)

    def _on_realize(self, *_args) -> None:
        try:
            surface = self.get_surface()
            if surface is not None and cairo is not None:
                surface.set_input_region(cairo.Region())
        except Exception as err:
            log(f"could not clear input region: {err}")

    def bind_paintables(self, a, b) -> None:
        if a is not None:
            self.picture_a.set_paintable(a)
        if b is not None:
            self.picture_b.set_paintable(b)

    def show_slot(self, slot: str) -> None:
        self.stack.set_visible_child_name(slot)

    def apply_scale(self, mode: str) -> None:
        fit = CONTENT_FIT.get(mode, Gtk.ContentFit.COVER)
        self.picture_a.set_content_fit(fit)
        self.picture_b.set_content_fit(fit)

    def apply_crossfade(self, enabled: bool, duration_ms: int) -> None:
        self.stack.set_transition_duration(duration_ms if enabled else 0)
        self.stack.set_transition_type(
            Gtk.StackTransitionType.CROSSFADE if enabled else Gtk.StackTransitionType.NONE
        )


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
            window = Gtk.ApplicationWindow(application=self, title=f"{WINDOW_TITLE_PREFIX}-0")
            window.set_default_size(640, 360)
            self.windows.append(self._fallback_window(window, 0))
            return
        for i in range(count):
            monitor = monitors.get_item(i)
            win = WallpaperWindow(self, monitor, i)
            win.bind_paintables(self.player_a.paintable, self.player_b.paintable)
            win.show_slot(self.active_slot)
            win.present()
            self.windows.append(win)

    def _fallback_window(self, window, index):
        window.set_decorated(False)
        stack = Gtk.Stack()
        pa = Gtk.Picture()
        pb = Gtk.Picture()
        stack.add_named(pa, "a")
        stack.add_named(pb, "b")
        window.set_child(stack)
        window.stack = stack
        window.picture_a = pa
        window.picture_b = pb
        window.monitor_index = index
        window.bind_paintables = lambda a, b: (pa.set_paintable(a), pb.set_paintable(b))
        window.show_slot = stack.set_visible_child_name
        window.apply_scale = lambda mode: (
            pa.set_content_fit(CONTENT_FIT.get(mode, Gtk.ContentFit.COVER)),
            pb.set_content_fit(CONTENT_FIT.get(mode, Gtk.ContentFit.COVER)),
        )
        window.apply_crossfade = lambda enabled, ms: stack.set_transition_duration(ms if enabled else 0)
        window.bind_paintables(self.player_a.paintable, self.player_b.paintable)
        window.show_slot(self.active_slot)
        window.present()
        return window

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
        ok, message = validate_file(path)
        if not ok:
            self.emit_error(message)
            return
        uri = path_to_uri(path)
        incoming = self.inactive_player() if self.crossfade else self.active_player()
        incoming.set_uri(uri)
        incoming.apply_audio()
        incoming.play()
        next_slot = incoming.slot
        for window in self.windows:
            window.bind_paintables(self.player_a.paintable, self.player_b.paintable)
            window.show_slot(next_slot)
        if self.crossfade and incoming is not self.active_player():
            outgoing = self.active_player()
            GLib.timeout_add(self.crossfade_ms + 50, self._stop_outgoing, outgoing)
        self.active_slot = next_slot
        self._cancel_long_pause()

    def _stop_outgoing(self, player: Player):
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
            uri_a = self.player_a.uri
            uri_b = self.player_b.uri
            active = self.active_slot
            self.player_a.set_fps(self.fps)
            self.player_b.set_fps(self.fps)
            for window in self.windows:
                window.bind_paintables(self.player_a.paintable, self.player_b.paintable)
            if active == "a" and uri_a:
                self.player_a.set_uri(uri_a)
                self.player_a.play()
            elif uri_b:
                self.player_b.set_uri(uri_b)
                self.player_b.play()
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
