import Clutter from 'gi://Clutter';
import Cogl from 'gi://Cogl';
import GObject from 'gi://GObject';
import Graphene from 'gi://Graphene';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import St from 'gi://St';
import * as Background from 'resource:///org/gnome/shell/ui/background.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as Workspace from 'resource:///org/gnome/shell/ui/workspace.js';
import * as WorkspaceThumbnail from 'resource:///org/gnome/shell/ui/workspaceThumbnail.js';

import { RENDERER_APP_ID, WINDOW_TITLE_PREFIX } from './const.js';
import * as Log from './logger.js';

// ---------------------------------------------------------------------------
// RoundedCornersEffect
//
// A Shell.GLSLEffect that clips a Clutter actor to an anti-aliased rounded
// rectangle.  The clipping happens in offscreen-texture space so it remains
// correct even when the actor is scaled by GNOME Shell's overview layout
// engine.  Ported directly from Hanabi (jeffshee/gnome-ext-hanabi).
// ---------------------------------------------------------------------------
const _FRAG_DECLS = [
    'uniform vec4  bounds;',
    'uniform float clip_radius;',
    'uniform vec2  pixel_step;',
    '',
    'float',
    'rounded_rect_coverage(vec2 p)',
    '{',
    '  float center_left  = bounds.x + clip_radius;',
    '  float center_right = bounds.z - clip_radius;',
    '  float center_x;',
    '  if      (p.x < center_left)  center_x = center_left;',
    '  else if (p.x > center_right) center_x = center_right;',
    '  else    return 1.0;',
    '  float center_top    = bounds.y + clip_radius;',
    '  float center_bottom = bounds.w - clip_radius;',
    '  float center_y;',
    '  if      (p.y < center_top)    center_y = center_top;',
    '  else if (p.y > center_bottom) center_y = center_bottom;',
    '  else    return 1.0;',
    '  vec2  delta = p - vec2(center_x, center_y);',
    '  float d2    = dot(delta, delta);',
    '  float outer = clip_radius + 0.5;',
    '  if (d2 >= outer * outer) return 0.0;',
    '  float inner = clip_radius - 0.5;',
    '  if (d2 <= inner * inner) return 1.0;',
    '  return outer - sqrt(d2);',
    '}',
].join('\n');

const _FRAG_CODE = [
    'vec2 tc = cogl_tex_coord0_in.xy / pixel_step;',
    'bool inside = tc.x >= bounds.x && tc.x <= bounds.z',
    '           && tc.y >= bounds.y && tc.y <= bounds.w;',
    'if (clip_radius > 0.0 && !inside)',
    '    cogl_color_out = vec4(0.0);',
    'else if (clip_radius > 0.0)',
    '    cogl_color_out *= rounded_rect_coverage(tc);',
].join('\n');

/**
 * Computes the offset between the actor's allocation origin and the
 * upper-left corner of the off-screen FBO that mutter creates for a
 * Shell.GLSLEffect.  Needed to correctly map logical-pixel uniforms to
 * texture pixels.  Logic ported verbatim from Hanabi.
 */
function _getFboOffset(actor) {
    function enlarge(x1, y1, w, h) {
        if (w <= 0 || h <= 0) return [x1, y1];
        const x2 = Math.ceil(x1 + w + 0.75);
        const y2 = Math.ceil(y1 + h + 0.75);
        return [x2 - Math.round(w) - 3, y2 - Math.round(h) - 3];
    }
    try {
        const vol = actor.get_paint_volume();
        if (vol) {
            const o = vol.get_origin();
            const [x, y] = enlarge(o.x, o.y, vol.get_width(), vol.get_height());
            return [Math.trunc(x), Math.trunc(y)];
        }
    } catch { /* ignore */ }
    const box = actor.get_allocation_box();
    const [x, y] = enlarge(box.x1, box.y1, box.x2 - box.x1, box.y2 - box.y1);
    return [Math.trunc(x - box.x1), Math.trunc(y - box.y1)];
}

const RoundedCornersEffect = GObject.registerClass(
    class RoundedCornersEffect extends Shell.GLSLEffect {
        _bounds      = [0, 0, 0, 0];
        _clipRadius  = 0;
        _dirty       = true;
        _cacheW      = 0;
        _cacheH      = 0;
        _cacheScale  = 0;
        _cacheOffX   = 0;
        _cacheOffY   = 0;

        vfunc_build_pipeline() {
            this.add_glsl_snippet(Cogl.SnippetHook.FRAGMENT, _FRAG_DECLS, _FRAG_CODE, false);
        }

        vfunc_paint_target(node, paintContext) {
            this._upload();
            super.vfunc_paint_target(node, paintContext);
        }

        _upload() {
            const tex   = this.get_texture();
            const actor = this.get_actor();
            if (!tex || !actor) return;

            const w     = tex.get_width();
            const h     = tex.get_height();
            const scale = actor.get_resource_scale();
            const [offX, offY] = _getFboOffset(actor);

            if (!this._dirty &&
                w === this._cacheW && h === this._cacheH &&
                scale === this._cacheScale &&
                offX === this._cacheOffX && offY === this._cacheOffY)
                return;

            this._dirty    = false;
            this._cacheW   = w;    this._cacheH   = h;
            this._cacheScale = scale;
            this._cacheOffX = offX; this._cacheOffY = offY;

            this.set_uniform_float(
                this.get_uniform_location('pixel_step'), 2, [1 / w, 1 / h]);

            const [x1, y1, x2, y2] = this._bounds;
            this.set_uniform_float(
                this.get_uniform_location('bounds'), 4, [
                    (x1 - offX) * scale,
                    (y1 - offY) * scale,
                    (x2 - offX) * scale,
                    (y2 - offY) * scale,
                ]);

            this.set_uniform_float(
                this.get_uniform_location('clip_radius'), 1, [this._clipRadius * scale]);
        }

        setBounds(bounds) {
            this._bounds = bounds;
            this._dirty  = true;
        }

        setClipRadius(radius) {
            this._clipRadius = radius;
            this._dirty      = true;
        }
    }
);

// ---------------------------------------------------------------------------
// LiveWallpaperActor
//
// An St.Widget that lives as a child of a Meta.BackgroundActor and displays
// a Clutter.Clone of the renderer window.  A RoundedCornersEffect is attached
// to the *backgroundActor* (same level as Meta.BackgroundContent) so the GLSL
// shader clips the entire tile — both the stock background and the live feed —
// to the correct rounded rectangle.  Architecture mirrors Hanabi's LiveWallpaper.
// ---------------------------------------------------------------------------
const LiveWallpaperActor = GObject.registerClass(
    class LiveWallpaperActor extends St.Widget {
        constructor(backgroundActor, rendererActor) {
            super({
                layout_manager: new Clutter.BinLayout(),
                // Match the background actor's current size; x/y_expand keeps
                // it filling the actor if it ever gets resized.
                width:    backgroundActor.width,
                height:   backgroundActor.height,
                x_expand: true,
                y_expand: true,
                // Start invisible and fade in after the clone is ready.
                opacity: 0,
            });

            // Tag so _injectIntoExistingBackgrounds can detect us.
            this._isLiveWallpaper = true;
            this._bgActor         = backgroundActor;
            this._monitorIndex    = backgroundActor.monitor;

            // Give the background actor a BinLayout so our St.Widget fills it.
            backgroundActor.layout_manager = new Clutter.BinLayout();
            backgroundActor.add_child(this);

            // Attach the GLSL rounded-corners effect to the background actor.
            // (Same design as Hanabi: effect lives on backgroundActor, not on this.)
            this._effect = new RoundedCornersEffect();
            backgroundActor.add_effect(this._effect);
            this._updateBounds();
            this._effect.setClipRadius(0);

            // Recompute bounds whenever our allocation changes.
            this._allocId = this.connect('notify::allocation', () => this._updateBounds());

            // Create the live-wallpaper clone and add it.
            this._clone = new Clutter.Clone({
                source:      rendererActor,
                pivot_point: new Graphene.Point({ x: 0.5, y: 0.5 }),
            });
            this._clone.connect('destroy', () => { this._clone = null; });
            this.add_child(this._clone);

            // Fade in smoothly.
            this.ease({
                opacity:  255,
                duration: 1000,
                mode:     Clutter.AnimationMode.EASE_OUT_QUAD,
            });

            this.connect('destroy', () => {
                try { backgroundActor.remove_effect(this._effect); } catch { /* ignore */ }
                this._effect       = null;
                this._bgActor      = null;
            });
        }

        /** Recompute the clip bounds, accounting for the panel offset. */
        _updateBounds() {
            if (!this._bgActor || !this._effect) return;
            const monitor = Main.layoutManager.monitors[this._monitorIndex];
            if (!monitor) return;
            const workArea    = Main.layoutManager.getWorkAreaForMonitor(this._monitorIndex);
            const panelOffset = (workArea.y - monitor.y) / monitor.height * this._bgActor.height;
            this._effect.setBounds([0, panelOffset, this.width, this.height]);
        }

        /** Called by the _updateBorderRadius hook with the animated radius. */
        setRoundedClipRadius(radius) {
            this._effect?.setClipRadius(radius);
            this._bgActor?.queue_redraw();
        }
    }
);

// Reference to WorkspaceBackground prototype for optional patches.
const _WorkspaceBackground = Workspace.WorkspaceBackground ?? null;

// ---------------------------------------------------------------------------
// BackgroundPatcher
//
// Monkey-patches Background.BackgroundManager._createBackgroundActor so that
// a Clutter.Clone of each managed renderer window actor is injected into *every*
// background layer GNOME Shell creates: the regular desktop, the Activities
// overview, and the lock-screen shield.  This is the standard approach used by
// GNOME-Shell live-wallpaper extensions (e.g. Hanabi).
// ---------------------------------------------------------------------------
export class BackgroundPatcher {
    constructor(settings) {
        this._settings = settings;
        this._originalMethod = null;
        // Set of all live Clutter.Clone actors we own.
        this._clones = new Set();
        // Reference to the current renderer window actor (may be null).
        this._rendererActor = null;
        // Signal IDs for overview / workspace signals.
        this._overviewShowingId = 0;
        this._workspaceAddedId = 0;
        this._workspaceRemovedId = 0;
        this._workspaceSwitchedId = 0;
    }

    // Call once after the renderer window has been claimed and positioned.
    setRendererActor(actor) {
        this._rendererActor = actor;
        // Rebuild any clones that might have already been created but are now
        // sourcing a stale actor (e.g. after a renderer restart).
        this._refreshClones();
    }

    // Install the prototype patch and immediately inject into existing backgrounds.
    enable() {
        if (this._originalMethod)
            return; // Already patched.

        const self = this;
        this._originalMethod = Background.BackgroundManager.prototype._createBackgroundActor;

        Background.BackgroundManager.prototype._createBackgroundActor = function () {
            // Call the original implementation to get the stock background actor.
            const bgActor = self._originalMethod.call(this);

            // Determine whether this background belongs to the lock-screen shield.
            const isLockScreen =
                this._container?.style_class?.includes('screen-shield-background') ?? false;

            // Respect the user's "play on lock screen" preference.
            if (isLockScreen && !self._settings.get_boolean('play-on-lock-screen')) {
                Log.debug('BackgroundPatcher: skipping lock-screen background (disabled in settings)');
                return bgActor;
            }

            // If the renderer window actor is not yet available we still return the
            // bgActor — _refreshClones() will inject into it later when the renderer
            // becomes ready (setRendererActor → _refreshClones → _injectIntoExistingBackgrounds).
            if (!self._rendererActor) {
                Log.debug('BackgroundPatcher: renderer actor not ready yet, will inject later');
                return bgActor;
            }

            // Store the live-wallpaper actor on the BackgroundManager so the
            // _updateBorderRadius hook can reach it via this._bgManager.liveWallpaperActor.
            this.liveWallpaperActor = self._injectClone(bgActor);
            return bgActor;
        };

        // Patch overview & thumbnail helpers so the renderer window does not
        // appear as a regular application window inside the Activities view.
        this._patchOverviewWindowFilter();

        // Re-inject clones every time the overview becomes visible — this covers
        // the case where new WorkspaceBackground actors are created after the
        // renderer is already running (e.g. the first time the overview opens,
        // or when new workspaces are added).
        this._overviewShowingId = Main.overview.connect('showing', () => {
            Log.debug('BackgroundPatcher: overview showing — refreshing clones');
            // Use an idle to let GNOME Shell finish building the overview layout
            // (WorkspaceBackground actors are created during the 'showing' phase)
            // before we try to inject into them.
            GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
                this._injectIntoExistingBackgrounds();
                return GLib.SOURCE_REMOVE;
            });
        });

        // Also refresh when workspaces are added / removed, since that creates
        // fresh WorkspaceBackground instances.
        const wm = global.workspace_manager;
        if (wm) {
            this._workspaceAddedId = wm.connect('workspace-added', () => {
                GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
                    this._injectIntoExistingBackgrounds();
                    return GLib.SOURCE_REMOVE;
                });
            });
            this._workspaceRemovedId = wm.connect('workspace-removed', () => {
                // Stale clones auto-clean via the 'destroy' signal on the bgActor.
            });
            // When the active workspace changes inside the overview the shell
            // may create new WorkspaceBackground actors for newly-visible
            // workspaces.  Re-inject on idle to catch those.
            this._workspaceSwitchedId = global.window_manager.connect(
                'switch-workspace', () => {
                    GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
                        this._injectIntoExistingBackgrounds();
                        return GLib.SOURCE_REMOVE;
                    });
                }
            );
        }

        // Inject into backgrounds that already exist (created before enable()).
        this._injectIntoExistingBackgrounds();
    }

    // Remove the prototype patch and destroy all clones.
    disable() {
        if (this._originalMethod) {
            Background.BackgroundManager.prototype._createBackgroundActor = this._originalMethod;
            this._originalMethod = null;
        }
        if (this._overviewShowingId) {
            Main.overview.disconnect(this._overviewShowingId);
            this._overviewShowingId = 0;
        }
        const wm = global.workspace_manager;
        if (wm) {
            if (this._workspaceAddedId) {
                wm.disconnect(this._workspaceAddedId);
                this._workspaceAddedId = 0;
            }
            if (this._workspaceRemovedId) {
                wm.disconnect(this._workspaceRemovedId);
                this._workspaceRemovedId = 0;
            }
        }
        if (this._workspaceSwitchedId) {
            global.window_manager.disconnect(this._workspaceSwitchedId);
            this._workspaceSwitchedId = 0;
        }
        this._unpatchOverviewWindowFilter();
        this._destroyAllClones();
    }

    destroy() {
        this.disable();
        this._settings = null;
        this._rendererActor = null;
    }

    // ------------------------------------------------------------------
    // Private helpers
    // ------------------------------------------------------------------

    /**
     * Create a LiveWallpaperActor inside @bgActor and return it.
     * Returns null on failure.
     */
    _injectClone(bgActor) {
        if (!this._rendererActor)
            return null;
        try {
            const lwa = new LiveWallpaperActor(bgActor, this._rendererActor);
            this._clones.add(lwa);
            lwa.connect('destroy', () => this._clones.delete(lwa));
            Log.debug(`BackgroundPatcher: injected LiveWallpaperActor (monitor ${bgActor.monitor ?? '?'})`);
            return lwa;
        } catch (e) {
            Log.warn(`BackgroundPatcher: failed to inject clone: ${e.message}`);
            return null;
        }
    }

    // Called when the renderer actor changes (renderer restart, etc.).
    _refreshClones() {
        // Destroy stale clones – they will be re-created as backgrounds
        // are next updated.  Also proactively inject into current backgrounds.
        this._destroyAllClones();
        this._injectIntoExistingBackgrounds();
    }

    _destroyAllClones() {
        for (const clone of this._clones) {
            try {
                clone.destroy();
            } catch {
                // Already destroyed.
            }
        }
        this._clones.clear();
    }

    // Walk the existing background groups and inject clones into any background
    // actors that don't already have one.
    _injectIntoExistingBackgrounds() {
        if (!this._rendererActor)
            return;

        // Collect all Meta.BackgroundActor instances from the scene graph.
        const bgActors = this._collectAllBackgroundActors();
        for (const bgActor of bgActors) {
            // Skip if we already injected a LiveWallpaperActor into this bgActor.
            const alreadyInjected = bgActor.get_children().some(c => c._isLiveWallpaper === true);
            if (!alreadyInjected)
                this._injectClone(bgActor);
        }
    }

    /**
     * Recursively walk an actor subtree and collect all Meta.BackgroundActor
     * nodes into @out (an Array).
     */
    _walkForBackgroundActors(actor, out, depth) {
        if (!actor || depth > 30)
            return;
        try {
            // Use instanceof for reliable native GObject type detection.
            // Also guard with typeof actor.monitor === 'number' as a fast pre-check.
            if (actor instanceof Meta.BackgroundActor)
                out.push(actor);
            const n = actor.get_n_children?.() ?? 0;
            for (let i = 0; i < n; i++) {
                try {
                    this._walkForBackgroundActors(actor.get_child_at_index(i), out, depth + 1);
                } catch {
                    // ignore
                }
            }
        } catch {
            // ignore
        }
    }

    /**
     * Collect every Meta.BackgroundActor that is currently live in the scene.
     * This covers:
     *  - Main.layoutManager._backgroundGroup  (desktop)
     *  - WorkspaceBackground._backgroundGroup  (overview, one per workspace×monitor)
     *  - Lock-screen shield backgrounds
     */
    _collectAllBackgroundActors() {
        const found = [];

        // 1. Regular desktop background group.
        const bgGroup = Main.layoutManager._backgroundGroup;
        if (bgGroup)
            this._walkForBackgroundActors(bgGroup, found, 0);

        // 2. Overview workspace backgrounds.
        //    Path: overview → _overview → _controls → _workspacesDisplay
        //          → _workspacesViews[] → _workspaces[] → _background → _backgroundGroup
        //    We don't hard-code the path; instead we walk the overview actor tree.
        try {
            const overviewActor = Main.overview._overview;
            if (overviewActor)
                this._walkForBackgroundActors(overviewActor, found, 0);
        } catch {
            // overview may not be initialised yet.
        }

        // 3. Lock-screen shield backgrounds.
        try {
            const shieldActor = Main.screenShield?._dialog;
            if (shieldActor)
                this._walkForBackgroundActors(shieldActor, found, 0);
        } catch {
            // screenShield may not exist.
        }

        // De-duplicate (same actor found via multiple paths).
        return [...new Set(found)];
    }

    // ------------------------------------------------------------------
    // Overview window-filter patches
    //
    // Without these the renderer window would appear as a regular app
    // window inside the Activities overview grid and thumbnail strip.
    // ------------------------------------------------------------------

    _patchOverviewWindowFilter() {
        try { this._patchWorkspace(); }
        catch (e) { Log.warn(`BackgroundPatcher: workspace patch failed: ${e.message}`); }
        try { this._patchWorkspaceThumbnail(); }
        catch (e) { Log.warn(`BackgroundPatcher: workspaceThumbnail patch failed: ${e.message}`); }
        // Hook WorkspaceBackground._updateBorderRadius so the GLSL effect
        // receives the animated corner radius as the overview opens/closes.
        // This is exactly what Hanabi does.
        try { this._patchWorkspaceBackground(); }
        catch (e) { Log.warn(`BackgroundPatcher: workspaceBackground patch failed: ${e.message}`); }
    }

    _unpatchOverviewWindowFilter() {
        if (this._origIsOverviewWindowWS) {
            const proto = Workspace.Workspace?.prototype ?? Workspace.WorkspaceLayout?.prototype;
            if (proto)
                proto._isOverviewWindow = this._origIsOverviewWindowWS;
            this._origIsOverviewWindowWS = null;
        }
        if (this._origIsOverviewWindowWT) {
            const proto = WorkspaceThumbnail.WorkspaceThumbnail?.prototype;
            if (proto)
                proto._isOverviewWindow = this._origIsOverviewWindowWT;
            this._origIsOverviewWindowWT = null;
        }
        this._unpatchWorkspaceBackground();
    }

    _patchWorkspace() {
        const proto = Workspace.Workspace?.prototype ?? Workspace.WorkspaceLayout?.prototype;
        if (!proto?._isOverviewWindow) return;
        const orig = (this._origIsOverviewWindowWS = proto._isOverviewWindow);
        proto._isOverviewWindow = function (win) {
            return isRendererWindow(win) ? false : orig.call(this, win);
        };
    }

    _patchWorkspaceThumbnail() {
        const proto = WorkspaceThumbnail.WorkspaceThumbnail?.prototype;
        if (!proto?._isOverviewWindow) return;
        const orig = (this._origIsOverviewWindowWT = proto._isOverviewWindow);
        proto._isOverviewWindow = function (win) {
            return isRendererWindow(win) ? false : orig.call(this, win);
        };
    }

    // ------------------------------------------------------------------
    // WorkspaceBackground._updateBorderRadius hook
    //
    // GNOME Shell calls _updateBorderRadius on every animation frame as
    // the overview opens/closes (via _stateAdjustment 0→1).  By hooking
    // it we feed that animated value into the GLSL clip radius so the
    // corners animate in perfect sync — exactly as Hanabi does.
    // ------------------------------------------------------------------

    _patchWorkspaceBackground() {
        const proto = _WorkspaceBackground?.prototype;
        if (!proto?._updateBorderRadius) return;
        const orig = (this._origUpdateBorderRadius = proto._updateBorderRadius);

        proto._updateBorderRadius = function () {
            orig.call(this);
            try {
                const { scaleFactor } = St.ThemeContext.get_for_stage(global.stage);
                // corner-radius in logical pixels (matches GNOME Shell default of ~12px).
                const CORNER_PX = 12;
                const radius    = scaleFactor * CORNER_PX * (this._stateAdjustment?.value ?? 1);

                // Update our GLSL effect via the reference stored on the bgManager.
                this._bgManager?.liveWallpaperActor?.setRoundedClipRadius(radius);

                // Also round the stock background content so it matches.
                const bgContent = this._bgManager?.backgroundActor?.content;
                if (bgContent)
                    bgContent.rounded_clip_radius = radius;

                // Apply border-radius CSS to the WorkspaceBackground container
                // (rounds its own corners, consistent with GNOME Shell behaviour).
                this.style = `border-radius: ${CORNER_PX}px`;
            } catch { /* non-fatal */ }
        };
    }

    _unpatchWorkspaceBackground() {
        const proto = _WorkspaceBackground?.prototype;
        if (proto && this._origUpdateBorderRadius) {
            proto._updateBorderRadius = this._origUpdateBorderRadius;
            this._origUpdateBorderRadius = null;
        }
    }
}

function isRendererWindow(win) {
    if (!win)
        return false;
    const title = win.get_title?.() ?? '';
    if (title.startsWith(WINDOW_TITLE_PREFIX))
        return true;
    const gtkId = win.get_gtk_application_id?.();
    if (gtkId === RENDERER_APP_ID)
        return true;
    const wmClass = (win.get_wm_class?.() || '').toLowerCase();
    return wmClass.includes('liveengine');
}

function setDesktopWindow(win, waylandClient) {
    try {
        if (typeof win.unmake_fullscreen === 'function')
            win.unmake_fullscreen();
    } catch (e) {
        Log.warn(`unmake_fullscreen failed: ${e.message}`);
    }

    try {
        if (waylandClient?.owns_window?.(win)) {
            if (typeof win.set_type === 'function')
                win.set_type(Meta.WindowType.DESKTOP);
            else if (typeof waylandClient.make_desktop === 'function')
                waylandClient.make_desktop(win);
        } else if (typeof win.set_type === 'function') {
            win.set_type(Meta.WindowType.DESKTOP);
        }
    } catch (e) {
        Log.warn(`set_type DESKTOP failed: ${e.message}`);
    }

    try {
        if (typeof win.hide_from_window_list === 'function')
            win.hide_from_window_list();
        else if (typeof waylandClient?.hide_from_window_list === 'function')
            waylandClient.hide_from_window_list(win);
    } catch (e) {
        Log.warn(`hide_from_window_list failed: ${e.message}`);
    }

    try {
        win.stick();
    } catch {
        // Not all window types can stick.
    }

    try {
        win.make_above = false;
    } catch {
        // Property may be read-only.
    }
}

function reparentToBackground(win) {
    const actor = win.get_compositor_private();
    const group = Main.layoutManager._backgroundGroup;
    if (!actor || !group)
        return;

    const parent = actor.get_parent();
    try {
        if (parent === group) {
            group.set_child_above_sibling(actor, null);
        } else {
            parent?.remove_child(actor);
            group.add_child(actor);
        }
        actor.reactive = false;
    } catch (e) {
        Log.warn(`reparent failed: ${e.message}`);
    }
}

function positionOnMonitor(win) {
    const actor = win.get_compositor_private();
    if (!actor)
        return;
    const index = typeof win.get_monitor === 'function' ? win.get_monitor() : 0;
    const monitor = Main.layoutManager.monitors[index] ?? Main.layoutManager.monitors[0];
    if (!monitor)
        return;
    actor.set_position(monitor.x, monitor.y);
    actor.set_size(monitor.width, monitor.height);
}

export class WallpaperWindows {
    constructor() {
        this._waylandClient = null;
        this._createdId = 0;
        this._focusId = 0;
        this._monitorsId = 0;
        this._managed = new Set();
        this._searchId = 0;
        this._layoutId = 0;
        this._stockBackgroundActors = new Map();
        // Optional BackgroundPatcher reference — set by RendererProcess.
        this.backgroundPatcher = null;
    }

    setWaylandClient(client) {
        this._waylandClient = client;
    }

    start() {
        this.stop();
        this._createdId = global.display.connect('window-created', (_d, win) => {
            GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
                this._claim(win);
                this._scheduleScan();
                this._scheduleLayout();
                return GLib.SOURCE_REMOVE;
            });
        });
        this._focusId = global.display.connect('notify::focus-window', () => {
            this._scheduleLayout();
        });
        this._monitorsId = Main.layoutManager.connect('monitors-changed', () => {
            this._scheduleScan();
        });
        this._scan();
    }

    _scheduleScan() {
        if (this._searchId)
            GLib.Source.remove(this._searchId);
        this._searchId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 400, () => {
            this._searchId = 0;
            this._scan();
            return GLib.SOURCE_REMOVE;
        });
    }

    _scheduleLayout() {
        if (this._layoutId)
            GLib.Source.remove(this._layoutId);
        this._layoutId = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            this._layoutId = 0;
            for (const win of this._managed)
                this._layout(win);
            return GLib.SOURCE_REMOVE;
        });
    }

    _scan() {
        const actors = global.get_window_actors();
        Log.debug(`Scanning ${actors.length} window actors`);
        for (const actor of actors)
            this._claim(actor.meta_window);
        for (const win of this._managed)
            this._layout(win);
        this._hideStockBackground();
    }

    _hideStockBackground() {
        const group = Main.layoutManager._backgroundGroup;
        if (!group)
            return;
        for (const actor of group.get_children()) {
            if (this._managed.has(actor.meta_window))
                continue;
            if (!this._stockBackgroundActors.has(actor))
                this._stockBackgroundActors.set(actor, actor.visible);
            actor.hide();
        }
    }

    _restoreStockBackground() {
        for (const [actor, visible] of this._stockBackgroundActors) {
            if (visible)
                actor.show();
        }
        this._stockBackgroundActors.clear();
    }

    _claim(win) {
        const title = win.get_title?.() ?? '';
        const gtkId = win.get_gtk_application_id?.();
        const wmClass = win.get_wm_class?.() || '';
        const isOurs = isRendererWindow(win);
        const isOwned = this._owned(win);
        Log.warn(`Window check: title="${title}" gtkId="${gtkId}" wmClass="${wmClass}" isOurs=${isOurs} isOwned=${isOwned}`);
        if (!isOurs && !isOwned)
            return;
        Log.warn(`Claiming window: ${title}`);
        if (this._managed.has(win)) {
            this._layout(win);
            return;
        }
        this._managed.add(win);
        try {
            win.connect('unmanaged', () => this._managed.delete(win));
        } catch {
            // ignore
        }
        this._layout(win);
    }

    _owned(win) {
        try {
            const owned = Boolean(this._waylandClient?.owns_window?.(win));
            if (owned) Log.debug(`Window ${win.get_title?.() ?? 'no-title'} is owned by WaylandClient`);
            return owned;
        } catch {
            return false;
        }
    }

    _layout(win) {
        Log.warn(`Laying out window: ${win.get_title?.() ?? 'no-title'}`);
        setDesktopWindow(win, this._waylandClient);
        reparentToBackground(win);
        positionOnMonitor(win);

        // Notify the BackgroundPatcher so it can inject/update clones of this
        // actor into the overview and lock-screen background layers.
        const actor = win.get_compositor_private();
        if (actor && this.backgroundPatcher)
            this.backgroundPatcher.setRendererActor(actor);
    }

    stop() {
        if (this._createdId) {
            global.display.disconnect(this._createdId);
            this._createdId = 0;
        }
        if (this._focusId) {
            global.display.disconnect(this._focusId);
            this._focusId = 0;
        }
        if (this._monitorsId) {
            Main.layoutManager.disconnect(this._monitorsId);
            this._monitorsId = 0;
        }
        if (this._searchId) {
            GLib.Source.remove(this._searchId);
            this._searchId = 0;
        }
        if (this._layoutId) {
            GLib.Source.remove(this._layoutId);
            this._layoutId = 0;
        }
        this._managed.clear();
        this._restoreStockBackground();
        this._waylandClient = null;
        // Clear the renderer actor reference in the patcher when renderer stops.
        this.backgroundPatcher?.setRendererActor(null);
    }

    destroy() {
        this.stop();
    }
}

function findRendererScript(extensionDir) {
    const script = extensionDir.get_child('renderer').get_child('liveengine-renderer.py');
    return script.get_path();
}

function applyHybridGpuEnv(launcher) {
    launcher.setenv('__NV_PRIME_RENDER_OFFLOAD', '0', true);
    launcher.setenv('__GLX_VENDOR_LIBRARY_NAME', 'mesa', true);
    launcher.setenv('__VK_LAYER_NV_optimus', 'non_NVIDIA_only', true);
    launcher.setenv('CUDA_VISIBLE_DEVICES', '', true);
    launcher.setenv('GST_GL_PLATFORM', 'egl', false);
    const driver = GLib.getenv('LIBVA_DRIVER_NAME');
    if (driver && ['nvidia', 'nvdec', 'vdpau'].includes(driver.toLowerCase()))
        launcher.setenv('LIBVA_DRIVER_NAME', 'iHD', true);
}

function isWaylandSession() {
    return GLib.getenv('XDG_SESSION_TYPE') === 'wayland' ||
        Boolean(GLib.getenv('WAYLAND_DISPLAY'));
}

function makeLauncher(extension) {
    const launcher = new Gio.SubprocessLauncher({
        flags: Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE,
    });
    applyHybridGpuEnv(launcher);
    const isWayland = isWaylandSession();
    launcher.setenv('GDK_BACKEND', isWayland ? 'wayland' : 'x11', true);
    launcher.set_cwd(extension.dir.get_path());
    return launcher;
}

export class RendererProcess {
    constructor(extension) {
        this._extension = extension;
        this._proc = null;
        this._waylandClient = null;
        this._crashes = 0;
        this._restartId = 0;
        this._waitCancellable = null;
        this._stopping = false;
        this.onCrashExhausted = null;
        this.windows = new WallpaperWindows();
        // BackgroundPatcher is set by the extension after construction.
        this.backgroundPatcher = null;
    }

    get waylandClient() {
        return this._waylandClient;
    }

    start() {
        this.stop();
        this._stopping = false;
        // Wire the patcher into the windows helper so _layout can call setRendererActor.
        this.windows.backgroundPatcher = this.backgroundPatcher;
        this.windows.start();
        this._spawn();
    }

    _spawn() {
        const script = findRendererScript(this._extension.dir);
        const python = GLib.find_program_in_path('python3') || '/usr/bin/python3';
        const argv = [python, script];

        try {
            const isWayland = isWaylandSession();
            const canOwnClient = isWayland &&
                typeof Meta.WaylandClient?.new_subprocess === 'function' &&
                global.context;
            Log.debug(`Spawning renderer: isWayland=${isWayland}, canOwnClient=${canOwnClient}, hasNewSubprocess=${typeof Meta.WaylandClient?.new_subprocess === 'function'}, hasContext=${!!global.context}`);
            if (canOwnClient) {
                try {
                    this._waylandClient = Meta.WaylandClient.new_subprocess(
                        global.context,
                        makeLauncher(this._extension),
                        argv
                    );
                    this._proc = this._waylandClient.get_subprocess();
                    Log.debug('WaylandClient spawn succeeded');
                } catch (e) {
                    Log.warn(`WaylandClient spawn failed, using Gio.Subprocess: ${e.message}`);
                    this._waylandClient = null;
                }
            }
            if (!this._proc) {
                this._proc = makeLauncher(this._extension).spawnv(argv);
                Log.debug('Gio.Subprocess spawn used');
            }
        } catch (e) {
            Log.error(`Failed to start renderer: ${e.message}`);
            this._scheduleRestart();
            return;
        }

        this.windows.setWaylandClient(this._waylandClient);
        this._waitCancellable = new Gio.Cancellable();
        const proc = this._proc;
        proc.communicate_utf8_async(null, this._waitCancellable, (_proc, result) => {
            let output;
            try {
                output = proc.communicate_utf8_finish(result);
            } catch (e) {
                if (e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                    return;
                Log.warn(`Could not read renderer output: ${e.message}`);
            }
            if (output?.[1])
                Log.debug(`Renderer stdout: ${output[1].trim()}`);
            if (output?.[2])
                Log.error(`Renderer stderr: ${output[2].trim()}`);
            const status = proc.get_status?.() ?? 1;
            Log.warn(`Renderer exited with status ${status}`);
            if (this._proc === proc) {
                this._proc = null;
                this._waylandClient = null;
                this.windows.setWaylandClient(null);
            }
            if (!this._stopping)
                this._scheduleRestart();
        });
    }

    _scheduleRestart() {
        if (this._stopping || this._restartId)
            return;
        this._crashes += 1;
        if (this._crashes > 3) {
            this.onCrashExhausted?.();
            return;
        }
        const delay = Math.min(8000, 750 * (2 ** (this._crashes - 1)));
        this._restartId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, delay, () => {
            this._restartId = 0;
            this._spawn();
            return GLib.SOURCE_REMOVE;
        });
    }

    noteHealthy() {
        this._crashes = 0;
    }

    stop() {
        this._stopping = true;
        if (this._restartId) {
            GLib.Source.remove(this._restartId);
            this._restartId = 0;
        }
        this._waitCancellable?.cancel();
        this._waitCancellable = null;
        if (this._proc) {
            try {
                this._proc.send_signal(15);
            } catch {
                try {
                    this._proc.force_exit();
                } catch (e) {
                    Log.warn(`force_exit: ${e.message}`);
                }
            }
        }
        this._proc = null;
        this._waylandClient = null;
        this.windows.stop();
    }

    destroy() {
        this.stop();
        this.windows.destroy();
        this.onCrashExhausted = null;
        this.backgroundPatcher = null;
    }
}
