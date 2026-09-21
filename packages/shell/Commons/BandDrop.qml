import QtQuick
import qs.Commons

// BandDrop: Fluid liquid-drop animation controller for shell popups and widgets.
// Drops out smoothly from the nearest perimeter rail edge with a spring overshoot.
Item {
  id: drop

  // Target item to animate (defaults to parent)
  property Item target: parent

  // Edge from which the popup drops: "top" | "bottom" | "left" | "right"
  property string edge: "top"

  // Active / Open state
  property bool active: false

  // Spring & timing configuration
  property int enterDuration: 280
  property int exitDuration: 180
  property real translateDistance: Style.space(12)
  property real scaleFrom: 0.68
  property real overshoot: 1.25

  // Accessibility / Reduced motion
  readonly property bool motionEnabled: true

  // Internal spring animation driver
  readonly property real progress: springProp.value

  QtObject {
    id: springProp
    property real value: drop.active ? 1.0 : 0.0

    Behavior on value {
      enabled: drop.motionEnabled
      NumberAnimation {
        duration: drop.active ? drop.enterDuration : drop.exitDuration
        easing.type: drop.active ? Easing.OutBack : Easing.OutCubic
        easing.overshoot: drop.active ? drop.overshoot : 0.0
      }
    }
  }

  // Bind animated properties to target item
  Binding {
    target: drop.target
    property: "opacity"
    value: drop.motionEnabled ? Math.min(1.0, springProp.value * 1.6) : (drop.active ? 1.0 : 0.0)
  }

  Binding {
    target: drop.target
    property: "scale"
    value: drop.motionEnabled ? (drop.scaleFrom + (1.0 - drop.scaleFrom) * springProp.value) : 1.0
  }

  Binding {
    target: drop.target
    property: "y"
    when: drop.edge === "top"
    value: drop.motionEnabled ? ((1.0 - springProp.value) * -drop.translateDistance) : 0
  }

  Binding {
    target: drop.target
    property: "y"
    when: drop.edge === "bottom"
    value: drop.motionEnabled ? ((1.0 - springProp.value) * drop.translateDistance) : 0
  }

  Binding {
    target: drop.target
    property: "x"
    when: drop.edge === "left"
    value: drop.motionEnabled ? ((1.0 - springProp.value) * -drop.translateDistance) : 0
  }

  Binding {
    target: drop.target
    property: "x"
    when: drop.edge === "right"
    value: drop.motionEnabled ? ((1.0 - springProp.value) * drop.translateDistance) : 0
  }

  Component.onCompleted: {
    if (!drop.target) return
    if (drop.edge === "top") drop.target.transformOrigin = Item.Top
    else if (drop.edge === "bottom") drop.target.transformOrigin = Item.Bottom
    else if (drop.edge === "left") drop.target.transformOrigin = Item.Left
    else if (drop.edge === "right") drop.target.transformOrigin = Item.Right
    else drop.target.transformOrigin = Item.Center
  }
}
