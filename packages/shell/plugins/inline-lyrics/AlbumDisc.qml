import QtQuick
import QtQuick.Effects
import qs.Commons

Item {
  id: root
  property string source: ""
  property bool playing: false

  Rectangle {
    anchors.fill: parent
    radius: width / 2
    color: Color.background
    border.color: Color.accent
    border.width: Style.space(1)
  }

  Image {
    id: cover
    anchors.fill: parent
    anchors.margins: Style.space(1)
    source: /^(https:|file:)/i.test(root.source) ? root.source : ""
    sourceSize: Qt.size(256, 256)
    asynchronous: true
    fillMode: Image.PreserveAspectCrop
    visible: status === Image.Ready
    layer.enabled: true
    layer.effect: MultiEffect {
      maskEnabled: true
      maskSource: discMask
    }
  }

  Rectangle {
    id: discMask
    width: cover.width
    height: cover.height
    radius: width / 2
    layer.enabled: true
    visible: false
    color: "white"
  }

  Rectangle {
    anchors.centerIn: parent
    width: Math.max(Style.space(4), root.width * 0.12)
    height: width
    radius: width / 2
    color: Color.background
    border.color: Color.accent
    border.width: Style.space(1)
  }

  NumberAnimation on rotation {
    from: 0
    to: 360
    duration: 12000
    loops: Animation.Infinite
    running: root.visible && cover.status === Image.Ready
    paused: running && !root.playing
  }
}
