/*
 * Nflix — nflixtv.cc provider for Nuvio (on-device plugin).
 *
 * nflixtv.cc already publishes a Stremio addon at /stremio. Its /stream
 * endpoint returns plain, time-signed HTTPS URLs (MP4 and HLS media
 * playlists) with no headers, no client auth and no DRM. This provider maps
 * those responses into Nuvio stream objects, so no server is needed.
 *
 * The site's own playback flow (/api/play-lease -> /api/mint-direct/... with
 * X-Nflix-Lease headers) is handled by the upstream addon; we only call its
 * public /stremio/stream endpoint.
 *
 * Runtime notes (Nuvio / QuickJS), same as the Streamflix provider:
 *   - Promise chains only. `async`/`await` is unreliable in loaded code.
 *   - `fetch` is the only network primitive; no timers, no Node built-ins.
 *   - AbortSignal.timeout is used when available to bound requests.
 *   - Fail soft: any error returns [] so other providers can still answer.
 */

var PROVIDER_NAME = "Nflix";
var BASE = "https://nflixtv.cc";
var STREMIO_BASE = BASE + "/stremio";
var UA =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

// Used on clients with no per-scraper settings screen (e.g. Android TV).
// Empty lists mean "allow everything".
var DEVICE_DEFAULTS = {
  disabledSources: [],
  disabledResolutions: [],
};

function log(message) {
  try {
    console.log("[Nflix] " + message);
  } catch (e) {}
}

function warn(message) {
  try {
    console.error("[Nflix] " + message);
  } catch (e) {}
}

function request(url, referer) {
  var headers = {
    "User-Agent": UA,
    "Accept": "application/json,application/vnd.apple.mpegurl,*/*",
    "Accept-Language": "en-US,en;q=0.9",
  };
  if (referer) {
    headers["Referer"] = referer;
  }
  var options = { headers: headers };
  if (typeof AbortSignal !== "undefined" &&
      typeof AbortSignal.timeout === "function") {
    try {
      options.signal = AbortSignal.timeout(20000);
    } catch (e) {}
  }
  return fetch(url, options).then(function (response) {
    return response.text().then(function (text) {
      return { status: response.status, ok: response.ok, text: text };
    });
  });
}

function getJson(url, referer) {
  return request(url, referer).then(function (response) {
    if (!response.ok) {
      var error = new Error("HTTP " + response.status + " for " + url);
      error.status = response.status;
      throw error;
    }
    try {
      return JSON.parse(response.text);
    } catch (e) {
      throw new Error("Invalid JSON from " + url);
    }
  });
}

// --- id / type handling ----------------------------------------------------

function normalizeMediaType(mediaType) {
  var kind = String(mediaType == null ? "" : mediaType).toLowerCase();
  if (kind === "movie") return "movie";
  if (kind === "tv" || kind === "series" || kind === "show") return "series";
  return "";
}

// Nuvio may hand us a bare TMDB id or whatever the meta id was ("tt..." or
// "tmdb:..."). Stremio wants the latter, with :season:episode for series.
function buildStremioId(tmdbId, kind, season, episode) {
  var raw = String(tmdbId == null ? "" : tmdbId).trim();
  if (!raw) return "";

  var id = "";
  if (raw.indexOf("tmdb:") === 0 || /^tt\d+$/i.test(raw)) {
    id = raw;
  } else if (/^\d+$/.test(raw)) {
    id = "tmdb:" + raw;
  } else {
    return "";
  }

  if (kind === "series" && id.split(":").length < 4) {
    var s = parseInt(season, 10);
    var e = parseInt(episode, 10);
    if (!s || s < 1) s = 1;
    if (!e || e < 1) e = 1;
    id += ":" + s + ":" + e;
  }
  return id;
}

// --- stream mapping --------------------------------------------------------

function qualityOf(stream) {
  var hints = stream.behaviorHints || {};
  var hay = [stream.name, stream.description, hints.filename].join(" ");
  var match = /(\d{3,4})p\b/i.exec(hay);
  if (match) return match[1] + "p";
  if (/\b4k\b|uhd/i.test(hay)) return "4K";
  return "";
}

function formatOf(url) {
  if (/\.m3u8(\?|$)/i.test(url)) return "HLS";
  if (/\.mp4(\?|$)/i.test(url)) return "MP4";
  return "video";
}

function sourceOf(stream) {
  var text = String(stream.description || "");
  var match = /Source:\s*([^\r\n]+)/i.exec(text);
  if (match) return match[1].trim();
  var parts = String(stream.name || "").split("•");
  return parts.length > 1 ? parts[parts.length - 1].trim() : "";
}

function toList(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value;
  if (typeof value === "string") {
    return value.split(",").map(function (item) {
      return item.trim();
    }).filter(function (item) {
      return item.length > 0;
    });
  }
  return [];
}

function readSettings() {
  var raw = globalThis.SCRAPER_SETTINGS;
  if (typeof raw === "string") {
    try {
      raw = JSON.parse(raw);
    } catch (e) {
      raw = {};
    }
  }
  if (!raw || typeof raw !== "object") raw = DEVICE_DEFAULTS;

  var hasSettings = false;
  for (var key in raw) {
    if (Object.prototype.hasOwnProperty.call(raw, key)) {
      hasSettings = true;
      break;
    }
  }
  if (!hasSettings) raw = DEVICE_DEFAULTS;

  return {
    disabledSources: toList(raw.disabledSources),
    disabledResolutions: toList(raw.disabledResolutions),
  };
}

function containsAny(hay, needles) {
  var lower = String(hay).toLowerCase();
  for (var i = 0; i < needles.length; i++) {
    if (lower.indexOf(String(needles[i]).toLowerCase()) !== -1) return true;
  }
  return false;
}

function allowed(stream, settings) {
  if (settings.disabledSources.length &&
      containsAny(sourceOf(stream), settings.disabledSources)) {
    return false;
  }
  var quality = qualityOf(stream);
  if (quality && settings.disabledResolutions.length &&
      containsAny(quality, settings.disabledResolutions)) {
    return false;
  }
  return true;
}

function toNuvioStream(stream) {
  var quality = qualityOf(stream);
  var source = sourceOf(stream);
  var format = formatOf(String(stream.url || ""));
  var hints = stream.behaviorHints || {};

  var result = {
    name: PROVIDER_NAME +
      (quality ? " | " + quality : "") +
      (source ? " · " + source : ""),
    title: PROVIDER_NAME + "\n" + format +
      (quality ? " • " + quality : "") +
      (source ? " • " + source : ""),
    description: String(stream.description || ""),
    url: String(stream.url),
    behaviorHints: {},
  };
  if (quality) result.quality = quality;
  if (typeof hints.notWebReady === "boolean") {
    result.behaviorHints.notWebReady = hints.notWebReady;
  }
  if (hints.bingeGroup) result.behaviorHints.bingeGroup = hints.bingeGroup;
  if (typeof hints.videoSize === "number") {
    result.behaviorHints.videoSize = hints.videoSize;
  }
  if (hints.filename) result.behaviorHints.filename = hints.filename;
  return result;
}

// --- entry point -----------------------------------------------------------

function getStreams(tmdbId, mediaType, season, episode) {
  var kind = normalizeMediaType(mediaType);
  var id = buildStremioId(tmdbId, kind, season, episode);
  if (!kind || !id) {
    warn("unsupported id/type: " + tmdbId + " / " + mediaType);
    return Promise.resolve([]);
  }

  var url = STREMIO_BASE + "/stream/" + kind + "/" +
    encodeURIComponent(id) + ".json";
  log("resolving " + kind + " " + id);

  return getJson(url, BASE + "/stremio")
    .then(function (data) {
      var raw = data && data.streams;
      if (!raw || !raw.length) {
        log("no streams for " + kind + " " + id);
        return [];
      }
      var settings = readSettings();
      var streams = [];
      for (var i = 0; i < raw.length; i++) {
        var stream = raw[i];
        if (!stream || !stream.url) continue;
        if (!allowed(stream, settings)) continue;
        streams.push(toNuvioStream(stream));
      }
      log("resolved " + streams.length + " stream(s) for " + kind + " " + id);
      return streams;
    })
    .catch(function (error) {
      warn("failed for " + kind + " " + id + ": " +
        (error && error.message ? error.message : String(error)));
      return [];
    });
}

// Match Nuvio's loader: CommonJS in Node, global in the on-device runtime.
if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    getStreams: getStreams,
    // Helpers below are for the Node test harness; Nuvio only reads getStreams.
    normalizeMediaType: normalizeMediaType,
    buildStremioId: buildStremioId,
    qualityOf: qualityOf,
    formatOf: formatOf,
    sourceOf: sourceOf,
    toNuvioStream: toNuvioStream,
  };
} else {
  global["getStreams"] = getStreams;
}
