function playerNames(value) {
  return String(value).split(",").map(function (name) { return name.trim() }).filter(function (name) { return name.length > 0 })
}

function accepts(name, allowed, ignored) {
  if (ignored.some(function (part) { return name.indexOf(part) !== -1 })) return false
  return allowed.length === 0 || allowed.some(function (part) { return name.indexOf(part) !== -1 })
}

function cleanLine(value) {
  return String(value).replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, 1000)
}

function config(allowed, ignored) {
  return '[player]\nincluded-players = ' + JSON.stringify(allowed)
    + '\nexcluded-players = ' + JSON.stringify(ignored)
    + '\n[net]\nis-server = false\nprotocol = ""\nlisten-at = ""'
    + '\n[lyrics]\nprovider = "lrclib"\ntiming-offset = 0.0'
    + '\n[cache]\nenabled = true\ndir = "$HOME/.cache/lrcsnc-inline"\nlife-span = 720'
    + '\n[cache.store-condition]\nif-synced = true\nif-plain = false\nif-instrumental = true'
    + '\n[client]\ndestination = "stdout"\ntemplate = "%text%"\ninsert-newline = true'
    + '\n[client.format]\nlyric = "%lyric%"\nmultiplier = ""\nnot-playing = ""\nno-lyrics = ""\nno-synced-lyrics = ""\nloading-lyrics = ""\nerror-message = ""'
    + '\n[client.format.instrumental]\ninterval = 2.0\nsymbol = ""\nmax-symbols = 1\n'
}

function cacheQuery(track) {
  var values = [track.title, track.artist, track.album].map(function (value) { return "'" + String(value).replace(/'/g, "''") + "'" })
  var duration = Number(track.duration)
  if (!isFinite(duration) || duration < 0) return "SELECT lyrics, state FROM lrcsnc_cache WHERE 0"
  return "SELECT lyrics, state FROM lrcsnc_cache WHERE title = " + values[0]
    + " AND artists = " + values[1] + " AND album = " + values[2]
    + " AND abs(duration - " + duration + ") < 0.1 ORDER BY updated_at DESC LIMIT 1"
}

function cacheLines(raw) {
  try {
    var rows = JSON.parse(raw || "[]")
    if (!Array.isArray(rows) || !rows.length) return []
    var entries = JSON.parse(rows[0].lyrics || "[]")
    if (!Array.isArray(entries) || entries.length > 10000) return []
    return entries.filter(function (entry) {
      return entry && typeof entry.Timing === "number" && isFinite(entry.Timing) && entry.Timing >= 0 && typeof entry.Text === "string"
    }).map(function (entry) { return { time: entry.Timing, text: cleanLine(entry.Text) } })
      .sort(function (a, b) { return a.time - b.time })
  } catch (error) { return [] }
}

function activeLine(lines, position) {
  var result = -1
  for (var i = 0; i < lines.length && lines[i].time <= position; i++) result = i
  return result
}

function withMaxWidth(layout, id, value) {
  if (!layout || typeof layout !== "object") return false
  var width = Math.round(Math.max(100, Math.min(800, Number(value) || 380)))
  var regions = ["left", "center", "right"]
  for (var r = 0; r < regions.length; r++) {
    var entries = layout[regions[r]]
    if (!Array.isArray(entries)) continue
    for (var i = 0; i < entries.length; i++) {
      var entry = entries[i]
      if (!entry || typeof entry !== "object" || entry.id !== id) continue
      entry.maxWidth = width
      return true
    }
  }
  return false
}
