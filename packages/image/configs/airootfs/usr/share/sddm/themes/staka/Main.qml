import QtQuick 2.0
import SddmComponents 2.0

// Staka login screen. Same greeter contract as the Omarchy theme it replaces:
// last-user login, uwsm session preference, password entry on Enter.
// Visuals follow the Staka lock screen: ink gradient background, centered
// brand lockup, and a single password field with a brand-blue focus ring.

Rectangle {
  id: root

  width: 640
  height: 480
  color: "#050811"

  // Staka palette (matches packages/image/branding and the desktop shell)
  readonly property color inkDeep: "#03050A"
  readonly property color ink: "#0B1220"
  readonly property color brandBlue: "#1E5EFF"
  readonly property color brandBlueMid: "#3B7BFF"
  readonly property color brandGlow: "#609AFF"
  readonly property color textPrimary: "#E8EEF9"
  readonly property color textDim: "#8A96AD"

  property string currentUser: userModel.lastUser
  property bool loginFailed: false
  property bool loggingIn: false
  property int sessionIndex: {
    for (var i = 0; i < sessionModel.rowCount(); i++) {
      var name = (sessionModel.data(sessionModel.index(i, 0), Qt.DisplayRole) || "").toString()
      if (name.indexOf("uwsm") !== -1)
        return i
    }
    return sessionModel.lastIndex
  }

  TextConstants { id: textConstants }

  Connections {
    target: sddm
    function onLoginFailed() {
      root.loggingIn = false
      root.loginFailed = true
      password.text = ""
      password.focus = true
    }
    function onLoginSucceeded() {
      root.loggingIn = false
      root.loginFailed = false
    }
  }

  Image {
    id: background
    anchors.fill: parent
    source: "background.png"
    fillMode: Image.PreserveAspectCrop
    smooth: true
  }

  // Dark scrim keeps the field and wordmark legible over the radial glow
  Rectangle {
    anchors.fill: parent
    color: root.inkDeep
    opacity: 0.45
  }

  // Brand lockup: mark + wordmark
  Image {
    id: logo
    source: "logo.png"
    anchors.horizontalCenter: parent.horizontalCenter
    anchors.bottom: loginColumn.top
    anchors.bottomMargin: 56
    width: Math.min(340, root.width * 0.5)
    height: Math.round(width * 188 / 800)
    fillMode: Image.PreserveAspectFit
    smooth: true
  }

  Column {
    id: loginColumn
    anchors.centerIn: parent
    spacing: 22

    // Demo user chip: circle avatar with initial + username
    Row {
      spacing: 12
      anchors.horizontalCenter: parent.horizontalCenter

      Rectangle {
        id: avatar
        width: 56
        height: 56
        radius: width / 2
        color: Qt.rgba(root.brandBlue.r, root.brandBlue.g, root.brandBlue.b, 0.16)
        border.color: root.loginFailed ? "#F7768E" : root.brandBlueMid
        border.width: 1

        Text {
          anchors.centerIn: parent
          text: root.currentUser.length > 0 ? root.currentUser.charAt(0).toUpperCase() : "S"
          font.family: "JetBrainsMono Nerd Font"
          font.pixelSize: 22
          font.bold: true
          color: root.textPrimary
        }
      }

      Column {
        anchors.verticalCenter: avatar.verticalCenter
        spacing: 4

        Text {
          text: root.currentUser
          font.family: "JetBrainsMono Nerd Font"
          font.pixelSize: 17
          font.bold: true
          color: root.textPrimary
        }

        Text {
          text: root.loginFailed ? textConstants.loginFailed
               : root.loggingIn ? textConstants.loginSucceeded
               : sddm.hostName
          font.family: "JetBrainsMono Nerd Font"
          font.pixelSize: 12
          color: root.loginFailed ? "#F7768E" : root.textDim
        }
      }
    }

    // Password field with brand-blue focus ring
    Rectangle {
      id: field
      width: 320
      height: 48
      radius: 10
      anchors.horizontalCenter: parent.horizontalCenter
      color: Qt.rgba(root.ink.r, root.ink.g, root.ink.b, 0.55)
      border.color: password.activeFocus ? root.brandBlue
                    : root.loginFailed ? "#F7768E" : "#22314F"
      border.width: password.activeFocus ? 2 : 1

      // Focus glow
      Rectangle {
        anchors.fill: parent
        radius: parent.radius
        color: "transparent"
        border.color: root.brandBlueMid
        border.width: password.activeFocus ? 6 : 0
        opacity: password.activeFocus ? 0.18 : 0
        Behavior on border.width { NumberAnimation { duration: 120 } }
        Behavior on opacity { NumberAnimation { duration: 120 } }
      }

      Row {
        anchors.fill: parent
        anchors.leftMargin: 18
        anchors.rightMargin: 18
        spacing: 10

        TextInput {
          id: password
          width: field.width - 36
          height: field.height
          verticalAlignment: TextInput.AlignVCenter
          echoMode: TextInput.Password
          font.family: "JetBrainsMono Nerd Font"
          font.pixelSize: 16
          font.letterSpacing: 3
          passwordCharacter: "\u2022"
          color: root.textPrimary
          selectionColor: root.brandBlue
          selectedTextColor: root.textPrimary
          clip: true
          focus: true

          Text {
            anchors.left: parent.left
            anchors.verticalCenter: parent.verticalCenter
            text: textConstants.password
            font.family: "JetBrainsMono Nerd Font"
            font.pixelSize: 14
            color: root.textDim
            visible: password.text.length === 0
          }

          onTextChanged: root.loginFailed = false

          Keys.onPressed: {
            if (event.key === Qt.Key_Return || event.key === Qt.Key_Enter) {
              root.tryLogin()
              event.accepted = true
            }
          }
        }
      }
    }

    // Caps lock hint
    Text {
      anchors.horizontalCenter: parent.horizontalCenter
      text: textConstants.capslockWarning
      font.family: "JetBrainsMono Nerd Font"
      font.pixelSize: 11
      color: root.textDim
      visible: keyboard.capsLock
    }
  }

  // Session picker, bottom-left. The default session (uwsm Hyprland) is
  // preselected; click to cycle in the rare case another session is needed.
  Row {
    anchors.left: parent.left
    anchors.bottom: parent.bottom
    anchors.margins: 18
    spacing: 8

    Text {
      text: "\uF2D0"
      font.family: "JetBrainsMono Nerd Font"
      font.pixelSize: 12
      color: root.textDim
      anchors.verticalCenter: parent.verticalCenter
      visible: sessionSelector.count > 1
    }

    Text {
      id: sessionSelector
      property int index: sessionIndex
      property int count: sessionModel.rowCount()
      text: {
        var i = sessionModel.data(sessionModel.index(index, 0), Qt.DisplayRole)
        return (i || "").toString() || textConstants.session
      }
      font.family: "JetBrainsMono Nerd Font"
      font.pixelSize: 12
      color: root.textDim
      anchors.verticalCenter: parent.verticalCenter
      visible: count > 1

      MouseArea {
        anchors.fill: parent
        cursorShape: Qt.PointingHandCursor
        onClicked: {
          var next = (sessionSelector.index + 1) % sessionModel.rowCount()
          sessionSelector.index = next
          root.sessionIndex = next
        }
      }
    }
  }

  // Power controls, bottom-right, drawn as text buttons to stay on-palette
  Row {
    anchors.right: parent.right
    anchors.bottom: parent.bottom
    anchors.margins: 18
    spacing: 18

    Text {
      text: "\uF2F9 Reboot"
      font.family: "JetBrainsMono Nerd Font"
      font.pixelSize: 12
      color: rebootArea.containsMouse ? root.textPrimary : root.textDim

      MouseArea {
        id: rebootArea
        anchors.fill: parent
        cursorShape: Qt.PointingHandCursor
        hoverEnabled: true
        onClicked: sddm.reboot()
      }
    }

    Text {
      text: "\uF011 Shutdown"
      font.family: "JetBrainsMono Nerd Font"
      font.pixelSize: 12
      color: shutdownArea.containsMouse ? root.textPrimary : root.textDim

      MouseArea {
        id: shutdownArea
        anchors.fill: parent
        cursorShape: Qt.PointingHandCursor
        hoverEnabled: true
        onClicked: sddm.powerOff()
      }
    }
  }

  function tryLogin() {
    root.loggingIn = true
    sddm.login(root.currentUser, password.text, root.sessionIndex)
  }

  Component.onCompleted: password.forceActiveFocus()
}
