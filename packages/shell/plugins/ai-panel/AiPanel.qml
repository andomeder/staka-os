import QtQuick
import QtQuick.Controls
import QtQuick.Layouts
import Quickshell
import Quickshell.Wayland
import Quickshell.Widgets
import qs.Commons
import qs.Ui
import "../../services"

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
  // Saved conversations: { id, title, turnsJson }. The active transcript is
  // the messages model; switching stores and restores between the two.
  ListModel { id: sessions }

  function ensureSession() {
    if (root.sessionId.length === 0) {
      root.sessionId = "qs-" + Date.now().toString(36)
      sessions.append({ sid: root.sessionId, title: "New chat", turnsJson: "[]" })
    }
  }

  function transcriptTurns() {
    var turns = []
    for (var i = 0; i < messages.count; i++) {
      var m = messages.get(i)
      if ((m.kind === "user" || m.kind === "assistant") && m.content.length > 0)
        turns.push({ role: m.kind, content: m.content })
    }
    return turns
  }

  function saveSession() {
    for (var i = 0; i < sessions.count; i++) {
      if (sessions.get(i).sid === root.sessionId) {
        sessions.setProperty(i, "turnsJson", JSON.stringify(transcriptTurns()))
        return
      }
    }
  }

  function switchSession(index) {
    if (index < 0 || index >= sessions.count) return
    saveSession()
    var s = sessions.get(index)
    root.sessionId = s.sid
    messages.clear()
    var turns = JSON.parse(s.turnsJson)
    for (var i = 0; i < turns.length; i++)
      messages.append({ kind: turns[i].role, content: turns[i].content, toolName: "" })
    scrollToEnd()
  }

  function newSession() {
    saveSession()
    root.sessionId = "qs-" + Date.now().toString(36)
    sessions.append({ sid: root.sessionId, title: "New chat", turnsJson: "[]" })
    messages.clear()
    Qt.callLater(function() { input.forceActiveFocus() })
  }

  function open(payloadJson) {
    ensureSession()
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
    ensureSession()
    input.text = ""
    var history = transcriptTurns()
    appendUser(text)
    // Title a fresh session from its first message.
    if (messages.count === 1) {
      for (var i = 0; i < sessions.count; i++) {
        if (sessions.get(i).sid === root.sessionId) {
          var t = text.length > 38 ? text.slice(0, 38) + "\u2026" : text
          sessions.setProperty(i, "title", t)
          break
        }
      }
    }
    // A leading "/name" is an explicit skill invocation; the agent resolves
    // it. We pass it through verbatim as the message, with the session's
    // prior turns replayed as context.
    agent.chat(text, root.sessionId, function(ev) {
      if (!ev || !ev.type) return
      if (ev.type === "text_delta") appendDelta(ev.content || "")
      else if (ev.type === "tool_call_start") appendToolStart(ev.name || "tool")
      else if (ev.type === "tool_call_end") appendToolEnd(ev.name || "tool", ev.result_summary || "")
      else if (ev.type === "error") appendError(ev.message || "agent error")
      else if (ev.type === "done") saveSession()
    }, history)
  }

  // --- window --------------------------------------------------------------

  PanelWindow {
    id: panel
    visible: root.opened
    // Anchor all four edges like the launcher/menu overlays: a partially
    // anchored PanelWindow sizes its free dimension from the window's
    // implicit size, which this content never provides - the layer surface
    // would be created zero-width (invisible while still grabbing
    // exclusive keyboard focus).
    anchors { top: true; bottom: true; left: true; right: true }
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

        // Header: agent dot + org identity + skills line (slide 9 design).
        RowLayout {
          Layout.fillWidth: true
          spacing: 8

          Rectangle {
            width: 9
            height: 9
            radius: 5
            Layout.alignment: Qt.AlignVCenter
            color: agent.healthy ? "#22c55e" : "#f59e0b"
          }

          Text {
            text: agent.orgName.length > 0 ? agent.orgName : "Staka AI"
            color: root.foreground
            font.family: root.fontFamily
            font.pixelSize: Style.font.heading
            font.bold: true
          }

          Item { Layout.fillWidth: true }

          Text {
            text: agent.skillsCount + " skills - " + (agent.healthy ? "agent active" : "agent offline")
            color: Qt.darker(root.foreground, 1.6)
            font.family: root.fontFamily
            font.pixelSize: Style.font.caption
          }

          WidgetButton {
            text: "+"
            fontFamily: root.fontFamily
            foreground: root.foreground
            horizontalMargin: 4
            tooltipText: "New chat"
            onPressed: function(mouse) { root.newSession() }
          }

          WidgetButton {
            id: sessionsButton
            text: "\u25BE"
            fontFamily: root.fontFamily
            foreground: root.foreground
            horizontalMargin: 4
            tooltipText: "Switch chat"
            onPressed: function(mouse) { sessionsMenu.popup() }
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

        Menu {
          id: sessionsMenu
          width: 280

          Instantiator {
            model: sessions
            delegate: MenuItem {
              required property string sid
              required property string title
              text: title
              highlighted: sid === root.sessionId
              onTriggered: {
                for (var i = 0; i < sessions.count; i++) {
                  if (sessions.get(i).sid === sid) {
                    root.switchSession(i)
                    break
                  }
                }
              }
            }
            onObjectAdded: (index, object) => sessionsMenu.insertItem(index, object)
            onObjectRemoved: (index, object) => sessionsMenu.removeItem(object)
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
              height: contentCol.implicitHeight

              // One metrics helper per delegate instance for bubble sizing.
              TextMetrics {
                id: userMetrics
                font.family: root.fontFamily
                font.pixelSize: Style.font.body
                text: model.content
              }

              Column {
                id: contentCol
                anchors.left: parent.left
                anchors.right: parent.right
                spacing: 0

                // User message: brand-blue bubble, right-aligned (slide 9).
                Rectangle {
                  visible: model.kind === "user"
                  anchors.right: parent.right
                  anchors.rightMargin: 2
                  width: Math.min(parent.width - 16, userMetrics.width + 28)
                  height: userText.implicitHeight + 18
                  radius: 14
                  color: "#1E5EFF"

                  Text {
                    id: userText
                    x: 14
                    y: 9
                    width: parent.width - 28
                    text: model.content
                    color: "#FFFFFF"
                    font.family: root.fontFamily
                    font.pixelSize: Style.font.body
                    wrapMode: Text.Wrap
                    textFormat: Text.PlainText
                  }
                }

                // Assistant reply: plain markdown on the panel surface.
                Text {
                  visible: model.kind === "assistant"
                  width: parent.width
                  text: model.content
                  color: root.foreground
                  font.family: root.fontFamily
                  font.pixelSize: Style.font.body
                  wrapMode: Text.Wrap
                  textFormat: Text.MarkdownText
                }

                // Tool call: monospace chip with the call and its summary.
                Rectangle {
                  visible: model.kind === "tool"
                  anchors.left: parent.left
                  anchors.right: parent.right
                  height: toolText.implicitHeight + 12
                  radius: 8
                  color: Qt.darker(root.background, 1.2)
                  border.color: root.border
                  border.width: 1

                  Text {
                    id: toolText
                    x: 10
                    y: 6
                    width: parent.width - 20
                    text: "\u2699 " + model.toolName + (model.content !== "running\u2026" ? "  \u00b7  " + model.content : "")
                    color: Qt.darker(root.foreground, 1.4)
                    font.family: root.fontFamily
                    font.pixelSize: Style.font.caption
                    elide: Text.ElideRight
                  }
                }

                // Error: urgent chip.
                Rectangle {
                  visible: model.kind === "error"
                  anchors.left: parent.left
                  anchors.right: parent.right
                  height: errorText.implicitHeight + 12
                  radius: 8
                  color: Qt.darker(Color.urgent, 1.5)

                  Text {
                    id: errorText
                    x: 10
                    y: 6
                    width: parent.width - 20
                    text: model.content
                    color: "#FFD9D0"
                    font.family: root.fontFamily
                    font.pixelSize: Style.font.caption
                    wrapMode: Text.Wrap
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
