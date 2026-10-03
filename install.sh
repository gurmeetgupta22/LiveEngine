#!/usr/bin/env bash
# LiveEngine installer for Ubuntu 26.04 (GNOME Shell 49/50).
set -euo pipefail

UUID="liveengine@gurmeet-gupta.github.io"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SRC="${ROOT}"
DEST="${HOME}/.local/share/gnome-shell/extensions/${UUID}"

if [[ ! -d "${SRC}" ]]; then
    echo "Cannot find ${SRC}" >&2
    exit 1
fi

echo "==> Installing packages (sudo)…"
if command -v apt-get >/dev/null 2>&1; then
    sudo apt-get update
    sudo apt-get install -y \
        python3 \
        python3-gi \
        python3-gi-cairo \
        python3-cairo \
        gir1.2-gtk-4.0 \
        gir1.2-adw-1 \
        gir1.2-gstreamer-1.0 \
        gir1.2-gst-plugins-base-1.0 \
        gir1.2-upowerglib-1.0 \
        gstreamer1.0-plugins-base \
        gstreamer1.0-plugins-good \
        gstreamer1.0-plugins-bad \
        gstreamer1.0-libav \
        gstreamer1.0-vaapi \
        gstreamer1.0-gtk4 \
        gstreamer1.0-gl \
        libspa-0.2-libcamera \
        gnome-shell-extension-prefs \
        libglib2.0-bin
else
    echo "apt-get not found. Install GTK4, PyGObject, and GStreamer gtk4/vaapi plugins yourself." >&2
fi

echo "==> Compiling GSettings schema…"
glib-compile-schemas "${SRC}/schemas"

echo "==> Installing extension to ${DEST}…"
mkdir -p "$(dirname "${DEST}")"
rm -rf "${DEST}"
cp -a "${SRC}" "${DEST}"
chmod 755 "${DEST}/renderer/liveengine-renderer.py"

echo "==> Compiling installed schema…"
glib-compile-schemas "${DEST}/schemas"

if command -v gnome-extensions >/dev/null 2>&1; then
    gnome-extensions enable "${UUID}" || true
fi

echo
echo "LiveEngine installed."
echo "On Wayland you must log out and back in (or reboot) before the extension loads."
echo "Then open Extensions → LiveEngine → Settings and pick a video or GIF."
echo
echo "Nested test session:"
echo "  dbus-run-session -- gnome-shell --devkit"
echo "Debug the shell:"
echo "  journalctl -f -o cat /usr/bin/gnome-shell"
echo "Debug the renderer:"
echo "  journalctl --user -f | grep liveengine-renderer"
