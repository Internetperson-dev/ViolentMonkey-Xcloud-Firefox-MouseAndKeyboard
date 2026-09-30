// ==UserScript==
// @name         Xcloud Firefox MKB Enable
// @namespace    http://tampermonkey.net/
// @version      5.0
// @description  Keep xcloud MKB pointer lock alive: block app-initiated fullscreen exit + polyfill navigator.keyboard
// @match        *://*.play.xbox.com/*
// @match        *://*.xbox.com/en-GB/play*
// @match        *://assets.play.xbox.com/*
// @run-at       document-start
// @grant        none
// ==/UserScript==

/*
  VERIFIED from game-stream.28a1d620.chunk.js:

    onClick()            -> requestPointerLock()  ONLY IF gameStream.isFullscreen
    requestPointerLock() -> ALSO requires isFullscreen, and renderer.isMounted
    onFullscreenChange() -> if(!isFullscreen){ hideClientRenderedCursor();
                                                requestExitPointerLock() }   // app drops it
    saveStateAndPause()  -> retainPointerLockAfterPause = true  // alt-TAB path, resumes fine

  Pointer Lock 2.0 explicitly states pointer lock "must not be exited when
  fullscreen is entered or exited". So the lock loss on fullscreen-exit is
  caused ONLY by this app calling requestExitPointerLock() itself - which is
  patchable, and is what this script blocks.

  Remaining unavoidable exits (UA-level, cannot be blocked from a page):
    - ESC (the default unlock gesture)
    - window/tab losing focus (alt-tabbing to another app)
*/

(function () {
    'use strict';

    const define = (obj, prop, val) => {
        try {
            Object.defineProperty(obj, prop, {
                get: typeof val === 'function' ? val : () => val,
                configurable: true
            });
            return true;
        } catch (e) { return false; }
    };

    // ---- 1. navigator.keyboard (Web Keyboard API) -------------------------
    if (!('keyboard' in navigator)) {
        // KeyboardLayoutMap extends Map and .get() returns a STRING synchronously.
        // Module 636980 calls map.get(x).toUpperCase(); returning a Promise crashes it.
        const layoutMap = new Map();
        layoutMap.get = (k) => (typeof k === 'string' ? k : 'us');
        layoutMap.has = () => true;

        try {
            Object.defineProperty(Navigator.prototype, 'keyboard', {
                get: () => ({
                    getLayoutMap: () => Promise.resolve(layoutMap),
                    lock: () => Promise.resolve(true),
                    unlock: () => Promise.resolve(true)
                }),
                configurable: true
            });
        } catch (e) {
            define(navigator, 'keyboard', {
                getLayoutMap: () => Promise.resolve(layoutMap),
                lock: () => Promise.resolve(true),
                unlock: () => Promise.resolve(true)
            });
        }
    }

    // ---- 2. Keep pointer lock alive ---------------------------------------
    // Block the app's own exit calls while a lock is held. onFullscreenChange()
    // calls requestExitPointerLock() whenever isFullscreen goes false, which is
    // what kills mouse capture. ESC / focus-loss are handled by the UA and
    // cannot be intercepted here - so the user is never trapped.
    const locked = () => !!document.pointerLockElement;

    const blockWhileLocked = (proto, name, label) => {
        if (!proto || typeof proto[name] !== 'function') return;
        const real = proto[name];
        proto[name] = function (...args) {
            if (locked()) {
                console.warn('[Xcloud MKB] blocked ' + label + ' - keeping pointer lock');
                return Promise.resolve();
            }
            return real.apply(this, args);
        };
    };

    blockWhileLocked(Document.prototype, 'exitPointerLock', 'exitPointerLock()');
    blockWhileLocked(Document.prototype, 'webkitExitPointerLock', 'webkitExitPointerLock()');
    blockWhileLocked(Element.prototype, 'releasePointerLock', 'releasePointerLock()');

    // ---- 3. Diagnostics ---------------------------------------------------
    window.__xcloudMKB = () => ({
        keyboardSupported: !!navigator.keyboard,
        mouseSupported: !!document.exitPointerLock,
        fullscreenSupported: document.fullscreenEnabled || !!document.webkitFullscreenEnabled,
        pointerFine: matchMedia('(pointer: fine)').matches,
        isFullscreen: !!document.fullscreenElement,
        pointerLock: document.pointerLockElement?.tagName ?? null
    });

    const report = () => console.info('%c[Xcloud MKB v5]%c ' + JSON.stringify(window.__xcloudMKB()),
        'background:#107c10;color:#fff;padding:2px 6px;border-radius:3px;font-weight:bold', 'color:#888');

    addEventListener('pointerlockchange', report);
    addEventListener('fullscreenchange', report);
    setTimeout(report, 1500);
})();
