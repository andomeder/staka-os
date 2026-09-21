import Quickshell
import Quickshell.Wayland
import QtQuick
import QtQuick.Shapes
import qs.Commons

// CornerOverlay: Renders a smooth continuous fillet corner between perpendicular
// band rails (e.g. top + left rails) for an organic unibody frame feel.
Variants {
  id: root
  model: Quickshell.screens

  property var shell: null
  property string corner: "top-left" // "top-left", "top-right", "bottom-left", "bottom-right"
  property int thickness: 44
  property int radius: 12
  property color fillColor: Color.bar.background
  property bool active: true

  delegate: Component {
    PanelWindow {
      id: cornerWin
      required property var modelData

      screen: modelData
      visible: root.active
      color: "transparent"
      surfaceFormat.opaque: false
      WlrLayershell.namespace: "staka-band-corner"
      WlrLayershell.layer: WlrLayer.Top
      exclusionMode: ExclusionMode.Ignore

      anchors {
        top: root.corner.indexOf("top") !== -1
        bottom: root.corner.indexOf("bottom") !== -1
        left: root.corner.indexOf("left") !== -1
        right: root.corner.indexOf("right") !== -1
      }

      implicitWidth: root.thickness + root.radius
      implicitHeight: root.thickness + root.radius

      Shape {
        anchors.fill: parent
        preferredRendererType: Shape.CurveRenderer

        ShapePath {
          fillColor: root.fillColor
          strokeColor: "transparent"
          strokeWidth: 0

          // Top-Left inner fillet:
          // Rail overlap covers [0..thickness, 0..thickness].
          // The inner corner is at (thickness, thickness).
          // Fillet curves from (thickness, thickness + radius) to (thickness + radius, thickness).
          startX: root.corner === "top-left" ? root.thickness : 0
          startY: root.corner === "top-left" ? root.thickness : 0

          PathLine {
            x: root.corner === "top-left" ? root.thickness : parent.width
            y: root.corner === "top-left" ? root.thickness + root.radius : 0
          }
          PathArc {
            x: root.corner === "top-left" ? root.thickness + root.radius : 0
            y: root.corner === "top-left" ? root.thickness : parent.height
            radiusX: root.radius
            radiusY: root.radius
            direction: PathArc.Clockwise
          }
          PathLine {
            x: root.corner === "top-left" ? root.thickness : 0
            y: root.corner === "top-left" ? root.thickness : 0
          }
        }
      }
    }
  }
}
