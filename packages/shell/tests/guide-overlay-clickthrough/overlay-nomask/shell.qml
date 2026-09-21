import QtQuick
import Quickshell
import Quickshell.Wayland

ShellRoot {
  id: gate
  property int hlX: parseInt(Quickshell.env("GATE_HL_X") || "700")
  property int hlY: parseInt(Quickshell.env("GATE_HL_Y") || "650")
  property int hlW: parseInt(Quickshell.env("GATE_HL_W") || "420")
  property int hlH: parseInt(Quickshell.env("GATE_HL_H") || "300")

  PanelWindow {
    anchors { top: true; bottom: true; left: true; right: true }
    color: "transparent"
    exclusionMode: ExclusionMode.Ignore
    WlrLayershell.namespace: "staka-gate-overlay"
    WlrLayershell.layer: WlrLayer.Overlay
    WlrLayershell.keyboardFocus: WlrKeyboardFocus.None

    Rectangle {
      x: gate.hlX; y: gate.hlY; width: gate.hlW; height: gate.hlH
      color: "transparent"; radius: 14
      border.color: "#ff3b6b"; border.width: 4
    }
  }
}
