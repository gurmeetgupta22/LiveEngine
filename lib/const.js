export const BUS_NAME = 'org.gnome.Shell.Extensions.LiveEngine';
export const OBJECT_PATH = '/org/gnome/Shell/Extensions/LiveEngine';
export const IFACE_NAME = 'org.gnome.Shell.Extensions.LiveEngine';

export const RENDERER_APP_ID = 'io.github.liveengine.Renderer';
export const WINDOW_TITLE_PREFIX = 'LiveEngine-Wallpaper';

export const MEDIA_SUFFIXES = ['.mp4', '.m4v', '.webm', '.gif', '.mkv', '.mov'];

export const IFACE_XML = `
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
</node>`;
