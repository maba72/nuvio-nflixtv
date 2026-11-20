/*
 * Node test harness for the Nflix Nuvio provider.
 *
 *   node test/run.js              # fixture tests + live smoke tests
 *   node test/run.js --offline    # fixture tests only
 *
 * Fixtures are recorded responses from nflixtv.cc's /stremio/stream endpoint.
 * The offline tests evaluate the provider exactly like Nuvio does: as a script
 * with a global getStreams(), a mocked fetch and no CommonJS module object.
 */

var fs = require("fs");
var path = require("path");
var assert = require("assert");
var vm = require("vm");

var provider = require("../providers/nflixtv.js");

var fixtures = path.join(__dirname, "fixtures");
var failures = 0;
var offline = process.argv.indexOf("--offline") !== -1;

function check(name, fn) {
  try {
    var result = fn();
    if (result && typeof result.then === "function") {
      return result.then(
        function () {
          console.log("ok   " + name);
        },
        function (error) {
          failures++;
          console.error("FAIL " + name);
          console.error("     " + (error && error.message ? error.message : error));
        }
      );
    }
    console.log("ok   " + name);
  } catch (error) {
    failures++;
    console.error("FAIL " + name);
    console.error("     " + (error && error.message ? error.message : error));
  }
}

function fixture(name) {
  return JSON.parse(fs.readFileSync(path.join(fixtures, name), "utf8"));
}

function respond(text, status) {
  var code = status || 200;
  return Promise.resolve({
    ok: code < 400,
    status: code,
    text: function () {
      return Promise.resolve(text);
    },
  });
}

function fixtureFetch(url) {
  if (url.indexOf("/stream/movie/") !== -1) {
    return respond(JSON.stringify(fixture("streams-movie.json")));
  }
  if (url.indexOf("/stream/series/") !== -1) {
    return respond(JSON.stringify(fixture("streams-series.json")));
  }
  return respond("not found", 404);
}

function notFoundFetch() {
  return respond("not found", 404);
}

function loadRuntimeProvider(fetchImpl, settings) {
  var source = fs.readFileSync(
    path.join(__dirname, "..", "providers", "nflixtv.js"),
    "utf8"
  );
  var sandbox = {
    console: console,
    fetch: fetchImpl,
    AbortSignal: typeof AbortSignal === "undefined" ? undefined : AbortSignal,
    Promise: Promise,
    JSON: JSON,
    String: String,
    Object: Object,
    Array: Array,
    Error: Error,
    RegExp: RegExp,
    parseInt: parseInt,
    encodeURIComponent: encodeURIComponent,
  };
  sandbox.global = sandbox;
  if (settings) sandbox.SCRAPER_SETTINGS = JSON.stringify(settings);
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox, { filename: "nflixtv.js" });
  return sandbox;
}

var tests = [
  check("normalizeMediaType() accepts movie/tv/series", function () {
    assert.strictEqual(provider.normalizeMediaType("movie"), "movie");
    assert.strictEqual(provider.normalizeMediaType("tv"), "series");
    assert.strictEqual(provider.normalizeMediaType("series"), "series");
    assert.strictEqual(provider.normalizeMediaType("book"), "");
  }),

  check("buildStremioId() handles bare, tmdb: and tt ids", function () {
    assert.strictEqual(provider.buildStremioId("550", "movie"), "tmdb:550");
    assert.strictEqual(provider.buildStremioId("tmdb:1368337", "movie"), "tmdb:1368337");
    assert.strictEqual(provider.buildStremioId("tt0111161", "movie"), "tt0111161");
    assert.strictEqual(provider.buildStremioId("1399", "series", 1, 1), "tmdb:1399:1:1");
    assert.strictEqual(provider.buildStremioId("tt0944947", "series", 2, 5), "tt0944947:2:5");
    assert.strictEqual(provider.buildStremioId("tmdb:1399:3:2", "series", 1, 1), "tmdb:1399:3:2");
    assert.strictEqual(provider.buildStremioId("nonsense", "movie"), "");
  }),

  check("parsers work on recorded stream responses", function () {
    var movie = fixture("streams-movie.json").streams[0];
    assert.strictEqual(provider.qualityOf(movie), "1080p");
    assert.strictEqual(provider.formatOf(movie.url), "MP4");
    assert.ok(provider.sourceOf(movie).indexOf("Nova 2") !== -1);

    var series = fixture("streams-series.json").streams[0];
    assert.ok(provider.qualityOf(series));
    assert.ok(provider.formatOf(series.url) === "MP4" ||
      provider.formatOf(series.url) === "HLS");
  }),

  check("toNuvioStream() keeps upstream hints and drops no-url entries", function () {
    var upstream = fixture("streams-movie.json").streams[0];
    var stream = provider.toNuvioStream(upstream);
    assert.strictEqual(stream.url, upstream.url);
    assert.strictEqual(stream.quality, "1080p");
    assert.strictEqual(
      stream.behaviorHints.bingeGroup,
      upstream.behaviorHints.bingeGroup
    );
    assert.strictEqual(
      stream.behaviorHints.videoSize,
      upstream.behaviorHints.videoSize
    );
    assert.ok(stream.name.indexOf("Nflix") === 0);
    assert.strictEqual(stream.behaviorHints.notWebReady, false);
  }),

  check("loads without CommonJS and exports a global getStreams()", function () {
    var sandbox = loadRuntimeProvider(notFoundFetch);
    assert.strictEqual(typeof sandbox.getStreams, "function");
    assert.strictEqual(typeof sandbox.module, "undefined");
  }),

  check("getStreams() resolves a movie through the on-device fetch contract", function () {
    var sandbox = loadRuntimeProvider(fixtureFetch);
    return sandbox.getStreams("tt0111161", "movie").then(function (streams) {
      assert.strictEqual(streams.length, 2);
      assert.ok(streams[0].url.indexOf("https://") === 0);
      assert.strictEqual(streams[0].quality, "1080p");
      assert.strictEqual(streams[0].formatOf, undefined);
    });
  }),

  check("getStreams() resolves a series with season/episode", function () {
    var sandbox = loadRuntimeProvider(fixtureFetch);
    return sandbox.getStreams("1399", "tv", 1, 1).then(function (streams) {
      assert.ok(streams.length > 1);
      streams.forEach(function (stream) {
        assert.ok(stream.url.indexOf("https://") === 0);
        assert.ok(stream.name.indexOf("Nflix") === 0);
      });
    });
  }),

  check("settings can disable a source", function () {
    var sandbox = loadRuntimeProvider(fixtureFetch, {
      disabledSources: ["Nflx 1"],
    });
    return sandbox.getStreams("tt0111161", "movie").then(function (streams) {
      assert.strictEqual(streams.length, 1);
      assert.ok(streams[0].name.indexOf("Nova 2") !== -1);
    });
  }),

  check("settings can disable a resolution", function () {
    var sandbox = loadRuntimeProvider(fixtureFetch, {
      disabledResolutions: ["1080p"],
    });
    return sandbox.getStreams("tt0111161", "movie").then(function (streams) {
      assert.strictEqual(streams.length, 0);
    });
  }),
];

if (!offline) {
  tests.push(
    check("live: getStreams() for movie tt0111161", function () {
      return provider.getStreams("tt0111161", "movie").then(function (streams) {
        assert.ok(streams.length > 0, "no streams returned");
        assert.ok(streams[0].url.indexOf("https://") === 0, streams[0].url);
        assert.ok(streams[0].quality, "no quality detected");
        console.log("     " + streams[0].name);
      });
    }),
    check("live: getStreams() for series 1399 S1E1", function () {
      return provider.getStreams("1399", "tv", 1, 1).then(function (streams) {
        assert.ok(streams.length > 0, "no streams returned");
        assert.ok(streams[0].url.indexOf("https://") === 0);
      });
    }),
    check("live: fails soft on an unknown title", function () {
      return provider.getStreams("tt0000000", "movie").then(function (streams) {
        assert.deepStrictEqual(streams, []);
      });
    })
  );
}

Promise.all(tests).then(function () {
  if (failures) {
    console.error("\n" + failures + " test(s) failed");
    process.exitCode = 1;
  } else {
    console.log("\nall tests passed" + (offline ? " (offline)" : ""));
  }
});
