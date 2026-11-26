'use strict';

/**
 * AirConsoleStorage — localStorage-compatible shim backed by AirConsole
 * persistent data.
 *
 * Only allowlisted keys round-trip. Reads are synchronous from the caller's
 * perspective; hydration fills the cache and notifies onLoad subscribers.
 */
(function (root, factory) {
  var AirConsoleStorage = factory();
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = AirConsoleStorage;
  } else {
    root.AirConsoleStorage = AirConsoleStorage;
  }
})(typeof self !== 'undefined' ? self : this, function () {

  function install(airconsole, opts) {
    var allowlist = {};
    var allowKeys = (opts && opts.allowlist) || [];
    for (var ai = 0; ai < allowKeys.length; ai++) allowlist[allowKeys[ai]] = 1;
    var cache = {};
    var loaded = false;
    var loadCallbacks = [];

    function getUid() {
      try {
        var id = airconsole.getDeviceId();
        return airconsole.getUID(id) || null;
      } catch (e) { return null; }
    }

    var prevOnLoaded = airconsole.onPersistentDataLoaded;
    airconsole.onPersistentDataLoaded = function (data) {
      var uid = getUid();
      var entry = (uid && data && data[uid]) || {};
      var keys = Object.keys(entry);
      for (var i = 0; i < keys.length; i++) {
        var key = keys[i];
        if (allowlist[key] && entry[key] !== null && entry[key] !== undefined && !(key in cache)) {
          cache[key] = String(entry[key]);
        }
      }
      loaded = true;
      var cbs = loadCallbacks.slice();
      loadCallbacks.length = 0;
      for (var ci = 0; ci < cbs.length; ci++) {
        try { cbs[ci](); } catch (e) { console.error('[storage] onLoad', e); }
      }
      if (prevOnLoaded) prevOnLoaded.call(airconsole, data);
    };

    var shim = {
      getItem: function (key) {
        return Object.prototype.hasOwnProperty.call(cache, key) ? cache[key] : null;
      },
      setItem: function (key, value) {
        if (!allowlist[key]) return;
        var v = String(value);
        if (cache[key] === v) return;
        cache[key] = v;
        try { airconsole.storePersistentData(key, v); } catch (e) { /* ignore */ }
      },
      removeItem: function (key) {
        if (!allowlist[key]) return;
        delete cache[key];
        try { airconsole.storePersistentData(key, null); } catch (e) { /* ignore */ }
      },
      clear: function () {
        // Clear means "remove this shim's whole allowlisted namespace", not
        // just keys that were already hydrated into the local cache.
        for (var i = 0; i < allowKeys.length; i++) {
          try { airconsole.storePersistentData(allowKeys[i], null); } catch (e) { /* ignore */ }
        }
        cache = {};
      },
      key: function (i) {
        var keys = Object.keys(cache);
        return i < keys.length ? keys[i] : null;
      },
      get length() { return Object.keys(cache).length; },
      onLoad: function (cb) {
        if (typeof cb !== 'function') return;
        if (loaded) { cb(); return; }
        loadCallbacks.push(cb);
      },
      requestLoad: function () {
        var uid = getUid();
        if (!uid) return;
        try { airconsole.requestPersistentData([uid]); } catch (e) { /* ignore */ }
      }
    };

    try {
      Object.defineProperty(window, 'localStorage', { value: shim, configurable: true });
    } catch (e) { /* read-only */ }
    return shim;
  }

  return { install: install };
});
