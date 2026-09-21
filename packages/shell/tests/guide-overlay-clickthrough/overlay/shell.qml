import QtQuick
import Quickshell
import Quickshell.Wayland

// Gate test overlay: layer-shell overlay layer, transparent, EMPTY input
// mask. The empty mask is the click-through candidate under test: if the
// compositor gives this surface an empty input region, every pointer event
// over it must reach the windows beneath.
ShellRoot {
  id: gate

  // Coordinates are passed via env for one run at a time.
  property int hlX: parseInt(Quickshell.env("GATE_HL_X") || "200")
  property int hlY: parseInt(Quickshell.env("GATE_HL_Y") || "200")
  property int hlW: parseInt(Quickshell.env("GATE_HL_W") || "420")
  property int hlH: parseInt(Quickshell.env("GATE_HL_H") || "300")

  PanelWindow {
    anchors { top: true; bottom: true; left: true; right: true }
    color: "transparent"
    exclusionMode: ExclusionMode.Ignore
    WlrLayershell.namespace: "staka-gate-overlay"
    WlrLayershell.layer: WlrLayer.Overlay
    WlrLayershell.keyboardFocus: WlrKeyboardFocus.None

    // The candidate: an empty region. Nothing accepts input.
    mask: Region {}

    Rectangle {
      x: gate.hlX
      y: gate.hlY
      width: gate.hlW
      height: gate.hlH
      color: "transparent"
      radius: 14
      border.color: "#ff3b6b"
      border.width: 4

      Text {
        anchors.horizontalCenter: parent.horizontalCenter
        y: parent.height + 8
        text: "staka agent"
        color: "#ff3b6b"
        font.pixelSize: 18
        font.bold: true
      }
    }
  }
}
