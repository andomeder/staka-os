import QtQuick
import Quickshell
import Quickshell.Io
import qs.Commons

// BandCoupler: Connects the QuickShell perimeter band geometry with Hyprland's
// compositor gaps, inner margins, rounding, and gradient active borders.
Item {
  id: coupler
  visible: false

  property var shell: null

  readonly property var bandConfig: shell && shell.shellConfig && Util.isPlainObject(shell.shellConfig.band)
    ? shell.shellConfig.band
    : null

  readonly property bool bandEnabled: bandConfig !== null
  readonly property var edges: bandConfig && Array.isArray(bandConfig.edges) ? bandConfig.edges : ["top"]
  readonly property int thickness: bandConfig && Number(bandConfig.thickness) > 0 ? Number(bandConfig.thickness) : 44
  readonly property int innerMargin: bandConfig && Number(bandConfig.innerMargin) >= 0 ? Number(bandConfig.innerMargin) : 10
  readonly property int rounding: bandConfig && Number(bandConfig.rounding) >= 0 ? Number(bandConfig.rounding) : 10
  readonly property string activeBorder: bandConfig && bandConfig.activeBorder
    ? String(bandConfig.activeBorder)
    : "rgba(1E5EFFee) rgba(3B7BFFee) 45deg"
  readonly property string inactiveBorder: bandConfig && bandConfig.inactiveBorder
    ? String(bandConfig.inactiveBorder)
    : "rgba(1E2A44aa)"

  onBandConfigChanged: {
    if (coupler.bandEnabled) {
      applyTimer.restart()
    }
  }

  Timer {
    id: applyTimer
    interval: 80
    repeat: false
    onTriggered: coupler.applyToHyprland()
  }

  Process {
    id: hyprctlProc
  }

  function applyToHyprland() {
    if (!coupler.bandEnabled) return

    var hasTop = coupler.edges.indexOf("top") !== -1
    var hasRight = coupler.edges.indexOf("right") !== -1
    var hasBottom = coupler.edges.indexOf("bottom") !== -1
    var hasLeft = coupler.edges.indexOf("left") !== -1

    var topGap = hasTop ? (coupler.thickness + coupler.innerMargin) : coupler.innerMargin
    var rightGap = hasRight ? (coupler.thickness + coupler.innerMargin) : coupler.innerMargin
    var bottomGap = hasBottom ? (coupler.thickness + coupler.innerMargin) : coupler.innerMargin
    var leftGap = hasLeft ? (coupler.thickness + coupler.innerMargin) : coupler.innerMargin

    var batchCmd = [
      "keyword general:gaps_out " + topGap + " " + rightGap + " " + bottomGap + " " + leftGap,
      "keyword general:gaps_in 10",
      "keyword decoration:rounding " + coupler.rounding,
      "keyword general:col.active_border " + coupler.activeBorder,
      "keyword general:col.inactive_border " + coupler.inactiveBorder
    ].join("; ")

    hyprctlProc.command = ["hyprctl", "--batch", batchCmd]
    hyprctlProc.running = true
    console.log("BandCoupler: applied band geometry to Hyprland (" + topGap + " " + rightGap + " " + bottomGap + " " + leftGap + ")")
  }

  Component.onCompleted: {
    if (coupler.bandEnabled) {
      applyTimer.restart()
    }
  }
}
