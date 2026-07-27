import QtQuick
import qs.Commons
import qs.Ui
import "../../services/AgentClient.qml"

// Bar entry point for the assistant. Tapping it toggles the AI panel via the
// shell IPC wrapper; the small dot reports agent health (green ok, yellow
// unreachable, red suspended/error). Health comes from a lightweight
// AgentClient polling GET /health every 10s - no credentials, localhost only.
BarWidget {
  id: root
  moduleName: "staka.ai-panel"

  implicitWidth: row.implicitWidth
  implicitHeight: row.implicitHeight

  AgentClient { id: agent }

  readonly property color dotColor: {
    if (agent.healthStatus === "ok") return "#6a9955"
    if (agent.healthStatus === "unreachable" || agent.healthStatus === "unknown") return "#d7ba7d"
    return Color.urgent
  }

  Row {
    id: row
    anchors.centerIn: parent
    spacing: 5

    WidgetButton {
      id: button
      bar: root.bar
      text: "\u2728"
      tooltipText: "Staka AI"
      horizontalMargin: 6
      onPressed: function(mouse) {
        if (!root.bar) return
        root.bar.run("staka-shell shell toggle staka.ai-panel")
      }
    }

    Rectangle {
      width: 7
      height: 7
      radius: 3.5
      anchors.verticalCenter: parent.verticalCenter
      color: root.dotColor
    }
  }
}
