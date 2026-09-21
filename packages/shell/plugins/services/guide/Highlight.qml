import QtQuick
import qs.Commons

// Highlight box drawn around the agent's current target, in global
// coordinates translated by the hosting output's origin. Animates between
// sequence steps so guided walks read as one continuous pointer path.
Rectangle {
  id: box

  property var step: null
  property int screenX: 0
  property int screenY: 0

  x: step ? (step.x - screenX) : 0
  y: step ? (step.y - screenY) : 0
  width: step ? step.w : 0
  height: step ? step.h : 0
  radius: 12
  color: Qt.alpha(Color.accent, 0.10)
  border.color: Color.accent
  border.width: 3

  Behavior on x { NumberAnimation { duration: 180; easing.type: Easing.OutCubic } }
  Behavior on y { NumberAnimation { duration: 180; easing.type: Easing.OutCubic } }
  Behavior on width { NumberAnimation { duration: 180; easing.type: Easing.OutCubic } }
  Behavior on height { NumberAnimation { duration: 180; easing.type: Easing.OutCubic } }

  // Label chip under the box ("Staka: File > Export"). Flips above the box
  // when there is no room below on this output.
  Rectangle {
    visible: box.step && box.step.label.length > 0
    anchors.top: box.bottom
    anchors.topMargin: {
      if (!box.step) return 8
      var below = box.y + box.height + 8 + implicitHeight
      return below > box.parent.height ? -implicitHeight - 8 - 6 : 8
    }
    anchors.horizontalCenter: box.horizontalCenter

    implicitWidth: label.implicitWidth + 20
    implicitHeight: label.implicitHeight + 10
    radius: 8
    color: Color.background
    border.color: Color.accent
    border.width: 1
    opacity: 0.95

    Text {
      id: label
      anchors.centerIn: parent
      text: box.step ? "Staka: " + box.step.label : ""
      color: Color.foreground
      font.family: Style.fontFamily
      font.pixelSize: Style.font.caption
      font.bold: true
    }
  }

  FakeCursor {
    anchors.centerIn: parent
    label: box.step ? box.step.label : ""
  }
}
