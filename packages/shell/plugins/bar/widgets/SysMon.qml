import QtQuick
import Quickshell
import Quickshell.Io
import qs.Commons
import qs.Ui

// CPU and memory chip for the band bar's right side (rd-m0 mock).
BarWidget {
  id: root
  moduleName: "staka.sysmon"

  property real cpuPercent: 0
  property real memUsedGb: 0
  property real memTotalGb: 0
  property real lastTotal: 0
  property real lastIdle: 0

  implicitWidth: chip.implicitWidth
  implicitHeight: barSize

  function parseCpu(text) {
    var line = String(text || "").split("\n")[0] || ""
    if (line.indexOf("cpu ") !== 0) return
    var f = line.slice(4).trim().split(/\s+/).map(Number)
    if (f.length < 4) return
    var idle = f[3] + (f.length > 4 ? f[4] : 0)
    var total = 0
    for (var i = 0; i < f.length; i++) total += f[i]
    if (root.lastTotal > 0) {
      var dTotal = total - root.lastTotal
      var dIdle = idle - root.lastIdle
      root.cpuPercent = dTotal > 0 ? Math.round((1 - dIdle / dTotal) * 100) : 0
    }
    root.lastTotal = total
    root.lastIdle = idle
  }

  function parseMem(text) {
    var lines = String(text || "").split("\n")
    var total = 0
    var available = 0
    for (var i = 0; i < lines.length; i++) {
      if (lines[i].indexOf("MemTotal:") === 0)
        total = parseInt(lines[i].replace(/[^0-9]/g, ""), 10)
      else if (lines[i].indexOf("MemAvailable:") === 0)
        available = parseInt(lines[i].replace(/[^0-9]/g, ""), 10)
      if (total > 0 && available > 0) break
    }
    if (total > 0) {
      root.memTotalGb = total / 1048576
      root.memUsedGb = (total - available) / 1048576
    }
  }

  Process {
    id: statProc
    command: ["bash", "-c", "head -1 /proc/stat; grep -E 'MemTotal|MemAvailable' /proc/meminfo"]
    stdout: StdioCollector {
      onStreamFinished: {
        var text = String(this.text || "")
        var lines = text.split("\n")
        root.parseCpu(lines[0] || "")
        root.parseMem(lines.slice(1).join("\n"))
      }
    }
  }

  Timer {
    interval: 2000
    running: root.visible
    repeat: true
    triggeredOnStart: true
    onTriggered: statProc.running = true
  }

  Item {
    id: chip
    anchors.centerIn: parent
    implicitWidth: row.implicitWidth + Style.space(12)
    implicitHeight: Math.min(root.barSize - Style.space(6), Style.space(22))

    Rectangle {
      anchors.fill: parent
      radius: height / 2
      color: Qt.rgba(1, 1, 1, 0.06)
      border.color: Qt.rgba(0.12, 0.37, 1.0, 0.35)
      border.width: 1
    }

    Row {
      id: row
      anchors.centerIn: parent
      spacing: Style.space(6)

      Text {
        anchors.verticalCenter: parent.verticalCenter
        text: "CPU " + root.cpuPercent + "%  RAM " + root.memUsedGb.toFixed(1) + "G"
        color: root.bar ? root.bar.barForeground : Color.foreground
        font.family: root.bar ? root.bar.fontFamily : Style.font.family
        font.pixelSize: Style.font.caption
        renderType: Text.NativeRendering
      }
    }
  }
}
