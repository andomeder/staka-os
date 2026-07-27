import QtQuick
import QtQuick.Controls
import QtQuick.Layouts
import Quickshell
import Quickshell.Wayland
import Quickshell.Widgets
import qs.Commons
import qs.Ui
import "../../services/AgentClient.qml"

// System-wide assistant panel. Opens as a right-docked layer-shell overlay,
// streams chat from the local agent daemon over SSE, and renders tool calls
// as inline chips. All transport is localhost HTTP via AgentClient; this file
// holds no credentials and never sees the machine token.
Item {
  id: root

  property string stakaPath: ""
  property var shell: null
  property var manifest: null

  property bool opened: false
  property string sessionId: ""

  property int cardWidth: 420
  property int contentMargin: 14
  property int contentSpacing: 10

  property color background: Color.popups.background
  property color foreground: Color.popups.text
  property color border: Color.popups.border
  property var borderSpec: Border.surfaceSpec("ai-panel", "border", border, 2)
  property color scrim: Color.launcher.scrim
  property string fontFamily: Style.font.family

  AgentClient { id: agent }

  ListModel { id: messages }

  function open(payloadJson) {
    if (root.sessionId.length === 0)
      root.sessionId = "qs-" + Date.now().toString(36)
    root.opened = true
    Qt.callLater(function() { input.forceActiveFocus() })
  }

  function close() {
    root.opened = false
  }

  function dismiss() {
    root.opened = false
    if (root.shell && typeof root.shell.hide === "function")
      root.shell.hide((root.manifest && root.manifest.id) || "staka.ai-panel")
  }

  function healthGlyph() {
    if (agent.healthStatus === "ok") return "\u25cf"
    if (agent.healthStatus === "unreachable" || agent.healthStatus === "unknown") return "\u25d0"
    return "\u25cf"
  }

  function healthColor() {
    if (agent.healthStatus === "ok") return "#6a9955"
    if (agent.healthStatus === "unreachable" || agent.healthStatus === "unknown") return "#d7ba7d"
    return Color.urgent
  }

  // --- transcript assembly from the SSE event stream -----------------------

  function appendUser(text) {
    messages.append({ kind: "user", content: text, toolName: "" })
    scrollToEnd()
  }

  function appendDelta(text) {
    var last = messages.count - 1
    if (last >= 0 && messages.get(last).kind === "assistant") {
      messages.get(last).content += text
    } else {
      messages.append({ kind: "assistant", content: text, toolName: "" })
    }
    scrollToEnd()
  }

  function appendToolStart(name) {
    messages.append({ kind: "tool", content: "running\u2026", toolName: name })
    scrollToEnd()
  }

  function appendToolEnd(name, summary) {
    for (var i = messages.count - 1; i >= 0; i--) {
      var m = messages.get(i)
      if (m.kind === "tool" && m.toolName === name && m.content === "running\u2026") {
        m.content = summary || "done"
        break
      }
    }
    scrollToEnd()
  }

  function appendError(message) {
    messages.append({ kind: "error", content: message, toolName: "" })
    scrollToEnd()
  }

  function scrollToEnd() {
    Qt.callLater(function() {
      if (messages.count > 0) transcript.positionViewAtIndex(messages.count - 1, ListView.End)
    })
  }

  function sendCurrent() {
    var text = input.text.trim()
    if (text.length === 0) return
    input.text = ""
    appendUser(text)
    // A leading "/name" is an explicit skill invocation; the agent resolves
    // it. We pass it through verbatim as the message.
    agent.chat(text, root.sessionId, function(ev) {
      if (!ev || !ev.type) return
      if (ev.type === "text_delta") appendDelta(ev.content || "")
      else if (ev.type === "tool_call_start") appendToolStart(ev.name || "tool")
      else if (ev.type === "tool_call_end") appendToolEnd(ev.name || "tool", ev.result_summary || "")
      else if (ev.type === "error") appendError(ev.message || "agent error")
      // "done" carries usage stats; nothing to render in the MVP.
    })
  }

  // --- window --------------------------------------------------------------

  PanelWindow {
    id: panel
    visible: root.opened
    anchors { top: true; bottom: true; right: true }
    color: "transparent"
    WlrLayershell.namespace: "staka-ai-panel"
    WlrLayershell.layer: WlrLayer.Overlay
    WlrLayershell.keyboardFocus: WlrKeyboardFocus.Exclusive
    exclusionMode: ExclusionMode.Ignore

    Rectangle {
      anchors.fill: parent
      color: root.scrim
    }

    MouseArea {
      anchors.fill: parent
      onClicked: root.dismiss()
    }

    BorderSurface {
      id: card
      width: Math.min(root.cardWidth, panel.width - Style.gapsOut * 2)
      height: panel.height - Style.gapsOut * 2
      anchors.right: parent.right
      anchors.verticalCenter: parent.verticalCenter
      anchors.rightMargin: Style.gapsOut
      radius: Style.cornerRadius
      color: root.background
      borderSpec: root.borderSpec
      padding: root.contentMargin
      clip: true

      MouseArea { anchors.fill: parent; onClicked: {} }

      ColumnLayout {
        anchors.fill: parent
        anchors.topMargin: card.contentTopInset
        anchors.rightMargin: card.contentRightInset
        anchors.bottomMargin: card.contentBottomInset
        anchors.leftMargin: card.contentLeftInset
        spacing: root.contentSpacing

        // Header
        RowLayout {
          Layout.fillWidth: true
          spacing: 8

          Text {
            text: "Staka AI"
            color: root.foreground
            font.family: root.fontFamily
            font.pixelSize: Style.font.heading
            font.bold: true
          }

          Item { Layout.fillWidth: true }

          Text {
            text: agent.orgName.length > 0 ? agent.orgName : "no org"
            color: Qt.darker(root.foreground, 1.6)
            font.family: root.fontFamily
            font.pixelSize: Style.font.caption
          }

          WidgetButton {
            text: "\u2715"
            fontFamily: root.fontFamily
            foreground: root.foreground
            horizontalMargin: 4
            tooltipText: "Close"
            onPressed: function(mouse) { root.dismiss() }
          }
        }

        // Transcript
        Rectangle {
          Layout.fillWidth: true
          Layout.fillHeight: true
          color: "transparent"

          Text {
            anchors.centerIn: parent
            visible: messages.count === 0
            text: "Ask anything. Skills: " + agent.skillsCount + " loaded."
            color: Qt.darker(root.foreground, 1.8)
            font.family: root.fontFamily
            font.pixelSize: Style.font.bodySmall
          }

          ListView {
            id: transcript
            anchors.fill: parent
            model: messages
            clip: true
            spacing: 8
            boundsBehavior: Flickable.StopAtBounds

            delegate: Item {
              width: ListView.view.width
              height: bubble.implicitHeight

              BorderSurface {
                id: bubble
                width: parent.width
                radius: Style.cornerRadius
                color: {
                  if (model.kind === "user") return Color.launcher.selectedBackground
                  if (model.kind === "tool") return Qt.darker(root.background, 1.15)
                  if (model.kind === "error") return Qt.darker(Color.urgent, 1.4)
                  return root.background
                }
                borderSpec: Border.surfaceSpec("ai-bubble", "border", Qt.darker(root.border, 1.2), 1)
                padding: 8

                Column {
                  anchors.fill: parent
                  anchors.topMargin: bubble.contentTopInset
                  anchors.rightMargin: bubble.contentRightInset
                  anchors.bottomMargin: bubble.contentBottomInset
                  anchors.leftMargin: bubble.contentLeftInset
                  spacing: 2

                  Text {
                    visible: model.kind === "tool"
                    text: "\u2699 " + model.toolName
                    color: Qt.darker(root.foreground, 1.5)
                    font.family: root.fontFamily
                    font.pixelSize: Style.font.caption
                  }

                  Text {
                    width: parent.width
                    text: model.content
                    color: model.kind === "error" ? Color.urgent : root.foreground
                    font.family: root.fontFamily
                    font.pixelSize: Style.font.body
                    wrapMode: Text.Wrap
                    textFormat: Text.PlainText
                  }
                }
              }
            }
          }
        }

        // Input
        TextArea {
          id: input
          Layout.fillWidth: true
          placeholderText: "Message\u2026  (Enter to send, Shift+Enter for newline)"
          color: root.foreground
          selectionColor: Style.selectionFillFor(root.foreground, Color.accent)
          selectedTextColor: root.foreground
          placeholderTextColor: Qt.darker(root.foreground, 1.8)
          font.family: root.fontFamily
          font.pixelSize: Style.font.body
          wrapMode: TextEdit.Wrap
          selectByMouse: true
          padding: 8
          background: BorderSurface {
            color: Qt.darker(root.background, 1.1)
            radius: Style.cornerRadius
            borderSpec: Border.controlSpec(input.activeFocus ? "focus" : "normal", root.foreground, Color.accent)
          }
          Keys.onPressed: function(event) {
            if ((event.key === Qt.Key_Return || event.key === Qt.Key_Enter) && !(event.modifiers & Qt.ShiftModifier)) {
              root.sendCurrent()
              event.accepted = true
            } else if (event.key === Qt.Key_Escape) {
              root.dismiss()
              event.accepted = true
            }
          }
        }

        // Status bar
        RowLayout {
          Layout.fillWidth: true
          spacing: 6

          Text {
            text: root.healthGlyph()
            color: root.healthColor()
            font.pixelSize: Style.font.bodySmall
          }
          Text {
            text: agent.healthStatus
            color: Qt.darker(root.foreground, 1.6)
            font.family: root.fontFamily
            font.pixelSize: Style.font.caption
          }
          Item { Layout.fillWidth: true }
          Text {
            text: agent.model.length > 0 ? agent.model : "no model"
            color: Qt.darker(root.foreground, 1.6)
            font.family: root.fontFamily
            font.pixelSize: Style.font.caption
            elide: Text.ElideRight
            Layout.maximumWidth: 180
          }
        }
      }
    }
  }
}
