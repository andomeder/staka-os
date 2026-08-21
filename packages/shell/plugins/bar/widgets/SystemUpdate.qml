import QtQuick
import Quickshell
import Quickshell.Io
import qs.Commons
import qs.Ui

BarWidget {
  id: root
  moduleName: "staka.system-update"

  property bool updateAvailable: false

  function refresh() {
    if (!updateProc.running) updateProc.running = true
  }

  function clear() { updateAvailable = false }

  function runUpdate() {
    if (root.bar) root.bar.run("staka-launch-floating-terminal-with-presentation staka-update")
  }

  visible: updateAvailable
  implicitWidth: button.implicitWidth
  implicitHeight: button.implicitHeight

  IpcHandler {
    target: "staka.system-update"

    function refresh(): void {
      root.refresh()
    }

    function clear(): void {
      root.clear()
    }
  }

  Process {
    id: updateProc
    command: ["staka-update-available"]
    onExited: function(exitCode) {
      root.updateAvailable = exitCode === 0
    }
  }

  Timer {
    interval: 21600000
    running: true
    repeat: true
    triggeredOnStart: true
    onTriggered: root.refresh()
  }

  BarIconButton {
    id: button
    anchors.fill: parent
    bar: root.bar
    text: "\uf021"
    slotSize: Style.bar.statusSlot
    fontSize: Style.font.caption
    tooltipText: ""
    onPressed: root.runUpdate()
  }
}
