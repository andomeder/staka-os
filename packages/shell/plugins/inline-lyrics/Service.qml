import QtQuick
import Quickshell
import Quickshell.Io
import Quickshell.Services.Mpris
import "Model.js" as Model

Item {
  id: root
  property string currentLine: ""
  property string errorText: ""
  property var allowed: ["spotify"]
  property var ignored: ["mpv", "mpvpaper", "chromium", "firefox", "brave", "zen"]
  property string configuration: ""
  property bool configured: false
  property bool changing: false
  property var lines: []
  property int activeIndex: -1
  property real offset: 0
  property string lyricsStatus: "Play something to see its lyrics here"
  readonly property string directory: decodeURIComponent(String(Qt.resolvedUrl(".")).replace(/^file:\/\//, ""))
  readonly property var candidates: Mpris.players.values.filter(function (player) {
    return Model.accepts(String(player.dbusName).replace(/^org\.mpris\.MediaPlayer2\./, ""), root.allowed, root.ignored)
  })
  readonly property var controlPlayer: candidates.length === 1 ? candidates[0] : null
  readonly property string title: controlPlayer ? controlPlayer.trackTitle : ""
  readonly property string artist: controlPlayer ? controlPlayer.trackArtist : ""
  readonly property string trackArtUrl: controlPlayer ? controlPlayer.trackArtUrl : ""
  readonly property bool isPlaying: !!(controlPlayer && controlPlayer.isPlaying)
  readonly property bool hasMedia: candidates.some(function (player) { return !!player.trackTitle && player.playbackState !== MprisPlaybackState.Stopped })
  readonly property real position: controlPlayer ? Number(controlPlayer.position || 0) : 0
  readonly property string trackKey: {
    if (!controlPlayer || !hasMedia) return ""
    return controlPlayer.trackTitle + "\u001f" + controlPlayer.trackArtist + "\u001f"
      + controlPlayer.trackAlbum + "\u001f"
      + (controlPlayer.lengthSupported ? Math.round(Number(controlPlayer.length)) : -1)
  }

  function configure(players, ignoredPlayers) {
    var nextAllowed = Model.playerNames(players)
    var nextIgnored = Model.playerNames(ignoredPlayers)
    var next = Model.config(nextAllowed, nextIgnored)
    if (configured && configuration === next) return
    allowed = nextAllowed
    ignored = nextIgnored
    configuration = next
    configured = true
    changing = true
    currentLine = ""
    retry.stop()
    apply.restart()
  }

  function togglePlayback() {
    if (controlPlayer && controlPlayer.canTogglePlaying) controlPlayer.togglePlaying()
  }

  function seekTo(seconds) {
    if (!controlPlayer || !controlPlayer.canSeek) return false
    controlPlayer.position = Math.max(0, seconds)
    return true
  }

  function fetchLyrics() {
    if (!trackKey) {
      lines = []
      lyricsStatus = "Play something to see its lyrics here"
      return
    }
    if (cacheProc.running) return
    var track = {
      title: String(controlPlayer.trackTitle || ""),
      artist: String(controlPlayer.trackArtist || ""),
      album: String(controlPlayer.trackAlbum || ""),
      duration: controlPlayer.lengthSupported ? Number(controlPlayer.length) : -1
    }
    cacheProc.requestKey = trackKey
    cacheProc.command = ["sqlite3", "-readonly", "-json", Quickshell.env("HOME") + "/.cache/lrcsnc-inline/lrcsnc.db", Model.cacheQuery(track)]
    cacheProc.running = true
  }

  onTrackKeyChanged: {
    currentLine = ""
    lines = []
    offset = 0
    cacheRetry.attempts = 0
    lyricsStatus = trackKey ? "Loading lyrics…" : "Play something to see its lyrics here"
    Qt.callLater(fetchLyrics)
  }
  onPositionChanged: recalculateIndex()
  onOffsetChanged: recalculateIndex()
  onLinesChanged: recalculateIndex()

  function recalculateIndex() {
    activeIndex = Model.activeLine(lines, position - offset)
  }

  onHasMediaChanged: {
    if (!hasMedia) {
      currentLine = ""
      lines = []
      activeIndex = -1
      lyricsStatus = "Play something to see its lyrics here"
    }
  }

  Process {
    id: cacheProc
    property string requestKey: ""
    stdout: StdioCollector { id: cachedOutput }
    stderr: StdioCollector { id: cachedError }
    onExited: (code, status) => {
      if (requestKey !== root.trackKey) {
        Qt.callLater(root.fetchLyrics)
        return
      }
      root.lines = code === 0 ? Model.cacheLines(cachedOutput.text) : []
      root.lyricsStatus = root.lines.length ? "" : "No synced lyrics in cache for this track"
      if (code !== 0) root.errorText = Model.cleanLine(cachedError.text)
    }
  }

  Timer {
    id: cacheRetry
    property int attempts: 0
    interval: 1000
    repeat: true
    running: !!root.trackKey && root.lines.length === 0 && attempts < 15
    onTriggered: {
      attempts++
      root.fetchLyrics()
    }
  }

  Timer {
    id: positionTimer
    interval: 500
    repeat: true
    running: isPlaying && lines.length > 0
    onTriggered: if (controlPlayer) controlPlayer.positionChanged()
  }

  Timer {
    id: apply
    interval: 150
    onTriggered: {
      if (backend.running) backend.running = false
      else runtimeConfig.setText(root.configuration)
    }
  }

  FileView {
    id: runtimeConfig
    path: Quickshell.env("XDG_RUNTIME_DIR") + "/cloudsurfer-inline-lyrics.toml"
    preload: false
    onSaved: {
      root.changing = false
      root.errorText = ""
      backend.running = true
    }
    onSaveFailed: root.errorText = "Could not write lyrics configuration"
  }

  Process {
    id: backend
    command: [root.directory + "bin/lrcsnc", "--no-log", "--config", runtimeConfig.path]
    stdout: SplitParser {
      onRead: data => {
        if (!root.changing && root.hasMedia) root.currentLine = Model.cleanLine(data)
      }
    }
    stderr: SplitParser {
      onRead: data => root.errorText = Model.cleanLine(data)
    }
    onExited: (exitCode, exitStatus) => {
      root.currentLine = ""
      if (root.changing) runtimeConfig.setText(root.configuration)
      else {
        root.errorText = "Lyrics backend stopped (" + exitCode + ")"
        retry.restart()
      }
    }
  }

  Timer {
    id: retry
    interval: 15000
    onTriggered: if (root.configured && !root.changing) backend.running = true
  }
}
