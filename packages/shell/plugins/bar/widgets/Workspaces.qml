import QtQuick
import Quickshell.Hyprland
import qs.Commons
import qs.Ui

BarWidget {
  id: root
  moduleName: "staka.workspaces"

  function workspaceById(id) {
    var values = Hyprland.workspaces.values
    for (var i = 0; i < values.length; i++) {
      if (values[i].id === id) return values[i]
    }
    return null
  }

  function workspaceIds() {
    var ids = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]
    var values = Hyprland.workspaces.values
    for (var i = 0; i < values.length; i++) {
      var id = values[i].id
      if (id > 0 && id <= 10 && ids.indexOf(id) === -1) ids.push(id)
    }
    ids.sort(function(left, right) { return left - right })
    return ids
  }

  function focusWorkspace(id) {
    if (!root.bar) return
    root.bar.run("hyprctl dispatch workspace " + id)
  }

  readonly property color accent: Color.accent
  readonly property color fg: root.bar ? root.bar.barForeground : Color.foreground
  readonly property int wsSize: Style.space(22)
  readonly property int pillH: Style.space(16)
  readonly property int barH: root.barSize

  implicitWidth: row.implicitWidth
  implicitHeight: barH

  Row {
    id: row
    anchors.centerIn: parent
    spacing: Style.space(2)

    Repeater {
      model: root.workspaceIds()

      Item {
        id: wsItem
        required property int modelData
        readonly property var workspace: root.workspaceById(modelData)
        readonly property bool occupied: workspace !== null && workspace.toplevels.values.length > 0
        readonly property bool focused: Hyprland.focusedWorkspace !== null && Hyprland.focusedWorkspace.id === modelData

        width: root.wsSize
        height: root.barH

        // Pill background - a short rounded pill centred in the bar.
        Rectangle {
          anchors.centerIn: parent
          width: root.wsSize
          height: root.pillH
          radius: height / 2
          color: wsItem.focused ? root.accent
            : wsItem.occupied ? Qt.rgba(1, 1, 1, 0.10)
            : "transparent"

          Behavior on color {
            ColorAnimation { duration: 200 }
          }
        }

        // Workspace number
        Text {
          anchors.centerIn: parent
          text: wsItem.modelData === 10 ? "0" : String(wsItem.modelData)
          color: wsItem.focused ? "#FFFFFF"
            : wsItem.occupied ? root.fg
            : Qt.rgba(1, 1, 1, 0.3)
          font.family: root.bar ? root.bar.fontFamily : Style.font.family
          font.pixelSize: Style.font.bodySmall
          font.bold: wsItem.focused

          Behavior on color {
            ColorAnimation { duration: 200 }
          }
        }

        MouseArea {
          anchors.fill: parent
          hoverEnabled: true
          cursorShape: Qt.PointingHandCursor
          onClicked: root.focusWorkspace(wsItem.modelData)
          onWheel: function(wheel) {
            if (wheel.angleDelta.y > 0) root.focusWorkspace(Math.max(1, wsItem.modelData - 1))
            else root.focusWorkspace(Math.min(10, wsItem.modelData + 1))
          }
        }
      }
    }
  }
}
