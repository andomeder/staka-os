import QtQuick
import qs.Commons
import qs.Ui
import "../../services/AgentClient.qml"

// Bar entry point for the assistant.
// Tapping it toggles the AI panel via shell IPC (bound to Super+A);
// the indicator reports agent health (green ok, yellow unreachable, red suspended/error).
BarWidget {
  id: root
  moduleName: "staka.ai-panel"

  readonly property bool isPanelOpen: bar && bar.shell && typeof bar.shell.isPluginOpen === "function"
    ? bar.shell.isPluginOpen("staka.ai-panel")
    : false

  implicitWidth: pill.implicitWidth + Style.space(4)
  implicitHeight: barSize

  AgentClient { id: agent }

  readonly property color dotColor: {
    if (root.isPanelOpen) return "#3B7BFF"
    if (agent.healthStatus === "ok") return "#22c55e"
    if (agent.healthStatus === "unreachable" || agent.healthStatus === "unknown") return "#f59e0b"
    return Color.urgent
  }

  function toggleAgent() {
    if (!root.bar) return
    if (root.bar.shell && typeof root.bar.shell.toggle === "function") {
      root.bar.shell.toggle("staka.ai-panel")
    } else if (typeof root.bar.run === "function") {
      root.bar.run("staka-shell shell toggle staka.ai-panel")
    }
  }

  Item {
    id: pill
    anchors.centerIn: parent
    implicitWidth: row.implicitWidth + Style.space(10)
    implicitHeight: Math.min(root.barSize - Style.space(6), Style.space(22))

    Rectangle {
      anchors.fill: parent
      radius: Style.cornerRadius > 0 ? Math.min(Style.cornerRadius, height / 2) : height / 2
      color: root.isPanelOpen ? Qt.rgba(0.12, 0.37, 1.0, 0.25) : (mouseArea.containsMouse ? Qt.rgba(1, 1, 1, 0.08) : "transparent")
      border.color: root.isPanelOpen ? "#1E5EFF" : (mouseArea.containsMouse ? Qt.rgba(0.12, 0.37, 1.0, 0.4) : "transparent")
      border.width: 1

      Behavior on color { ColorAnimation { duration: 150 } }
      Behavior on border.color { ColorAnimation { duration: 150 } }
    }

    Row {
      id: row
      anchors.centerIn: parent
      spacing: Style.space(5)

      Text {
        anchors.verticalCenter: parent.verticalCenter
        text: "\u2728"
        color: root.isPanelOpen ? "#3B7BFF" : (root.bar ? root.bar.barForeground : Color.foreground)
        font.family: root.bar ? root.bar.fontFamily : Style.font.family
        font.pixelSize: Style.font.bodySmall
        renderType: Text.NativeRendering
      }

      Text {
        anchors.verticalCenter: parent.verticalCenter
        text: "AI"
        font.bold: true
        font.family: root.bar ? root.bar.fontFamily : Style.font.family
        font.pixelSize: Style.font.caption
        color: root.isPanelOpen ? "#3B7BFF" : (root.bar ? root.bar.barForeground : Color.foreground)
        visible: !root.bar || !root.bar.vertical
      }

      Rectangle {
        width: Style.space(6)
        height: Style.space(6)
        radius: width / 2
        anchors.verticalCenter: parent.verticalCenter
        color: root.dotColor

        Behavior on color { ColorAnimation { duration: 200 } }
      }
    }

    MouseArea {
      id: mouseArea
      anchors.fill: parent
      hoverEnabled: true
      cursorShape: Qt.PointingHandCursor
      onEntered: if (root.bar) root.bar.showTooltip(root, "Staka AI (Super+A)")
      onExited: if (root.bar) root.bar.hideTooltip(root)
      onClicked: root.toggleAgent()
    }
  }
}
