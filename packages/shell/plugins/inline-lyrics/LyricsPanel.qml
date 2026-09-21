import QtQuick
import QtQuick.Controls
import qs.Commons
import qs.Ui as Ui

Item {
  id: root
  required property var service
  property bool active: false
  property int barWidth: 380
  signal barWidthStep(int delta)
  property bool following: true
  property int textSize: Math.round(Style.font.body * 1.25)
  readonly property var lines: service ? service.lines : []
  readonly property int activeIndex: service ? service.activeIndex : -1
  readonly property color foreground: Color.popups.text
  readonly property color subtle: Qt.rgba(foreground.r, foreground.g, foreground.b, 0.55)
  readonly property var player: service ? service.controlPlayer : null
  implicitWidth: Style.space(360)
  implicitHeight: Style.space(460)

  function follow() {
    following = true
    followCurrent()
  }

  function followCurrent() {
    if (!active || !following || !lines.length) return
    if (activeIndex < 0) list.positionViewAtBeginning()
    else list.positionViewAtIndex(activeIndex, ListView.Center)
  }

  onActiveIndexChanged: followCurrent()
  onActiveChanged: if (active) Qt.callLater(follow)
  onLinesChanged: Qt.callLater(follow)
  onTextSizeChanged: Qt.callLater(followCurrent)
  onHeightChanged: Qt.callLater(followCurrent)

  Column {
    id: header
    width: parent.width
    spacing: Style.space(10)

    Row {
      width: parent.width
      spacing: Style.space(12)

      AlbumDisc {
        id: art
        width: Style.space(88)
        height: width
        source: root.service ? root.service.trackArtUrl : ""
        playing: root.active && !!(root.service && root.service.isPlaying)
      }

      Column {
        width: parent.width - art.width - Style.space(12)
        anchors.verticalCenter: parent.verticalCenter
        spacing: Style.space(3)

        Text {
          width: parent.width
          text: root.service && root.service.title ? root.service.title : "Nothing playing"
          textFormat: Text.PlainText
          color: root.foreground
          font.family: Style.font.family
          font.pixelSize: Style.font.body
          font.bold: true
          elide: Text.ElideRight
        }

        Text {
          width: parent.width
          text: root.service ? root.service.artist : ""
          textFormat: Text.PlainText
          color: root.subtle
          font.family: Style.font.family
          font.pixelSize: Style.font.caption
          elide: Text.ElideRight
        }

        Row {
          spacing: Style.space(8)

          Ui.PanelActionButton {
            iconText: "\u{F04AE}"
            tooltipText: "Previous track"
            foreground: root.subtle
            focusable: true
            enabled: !!(root.player && root.player.canGoPrevious)
            onClicked: root.player.previous()
          }

          Ui.PanelActionButton {
            iconText: root.service && root.service.isPlaying ? "\u{F03E4}" : "\u{F040A}"
            tooltipText: "Play / pause"
            foreground: Color.accent
            focusable: true
            enabled: !!(root.player && root.player.canTogglePlaying)
            onClicked: root.service.togglePlayback()
          }

          Ui.PanelActionButton {
            iconText: "\u{F04AD}"
            tooltipText: "Next track"
            foreground: root.subtle
            focusable: true
            enabled: !!(root.player && root.player.canGoNext)
            onClicked: root.player.next()
          }
        }
      }
    }

    Row {
      anchors.horizontalCenter: parent.horizontalCenter
      spacing: Style.space(6)

      Ui.PanelActionButton {
        objectName: "followButton"
        iconText: "\u{F04FE}"
        tooltipText: "Resume following"
        foreground: root.following ? Color.accent : root.subtle
        focusable: true
        onClicked: root.follow()
      }

      Ui.PanelActionButton {
        iconText: "\u{F0374}"
        tooltipText: "Advance lyrics by half a second"
        foreground: root.subtle
        focusable: true
        onClicked: root.service.offset -= 0.5
      }

      Text {
        anchors.verticalCenter: parent.verticalCenter
        width: Style.space(52)
        text: root.service && root.service.offset ? root.service.offset.toFixed(1) + "s" : "in time"
        textFormat: Text.PlainText
        color: root.service && root.service.offset ? Color.accent : root.subtle
        font.family: Style.font.family
        font.pixelSize: Style.font.caption
        horizontalAlignment: Text.AlignHCenter
      }

      Ui.PanelActionButton {
        iconText: "\u{F0415}"
        tooltipText: "Delay lyrics by half a second"
        foreground: root.subtle
        focusable: true
        onClicked: root.service.offset += 0.5
      }

      Ui.PanelActionButton {
        iconText: "\u{F09F3}"
        tooltipText: "Smaller lyrics"
        foreground: root.subtle
        focusable: true
        enabled: root.textSize > 11
        onClicked: root.textSize--
      }

      Ui.PanelActionButton {
        iconText: "\u{F09F4}"
        tooltipText: "Larger lyrics"
        foreground: root.subtle
        focusable: true
        enabled: root.textSize < 30
        onClicked: root.textSize++
      }

      Ui.PanelActionButton {
        objectName: "widthDecreaseButton"
        iconText: "\u{F0374}"
        tooltipText: "Narrower bar lyric"
        foreground: root.subtle
        enabled: root.barWidth > 100
        onClicked: root.barWidthStep(-20)
      }

      Text {
        width: Style.space(78)
        anchors.verticalCenter: parent.verticalCenter
        text: "Bar  " + root.barWidth + "px"
        textFormat: Text.PlainText
        color: root.subtle
        font.family: Style.font.family
        font.pixelSize: Style.font.caption
        horizontalAlignment: Text.AlignHCenter
      }

      Ui.PanelActionButton {
        objectName: "widthIncreaseButton"
        iconText: "\u{F0415}"
        tooltipText: "Wider bar lyric"
        foreground: root.subtle
        enabled: root.barWidth < 800
        onClicked: root.barWidthStep(20)
      }
    }

    Ui.PanelSeparator {
      width: parent.width
      foreground: root.foreground
    }
  }

  ListView {
    id: list
    objectName: "lyricsList"
    anchors.top: header.bottom
    anchors.topMargin: Style.space(8)
    anchors.bottom: footer.top
    anchors.bottomMargin: Style.space(8)
    width: parent.width
    clip: true
    model: root.lines
    boundsBehavior: Flickable.StopAtBounds
    onDragStarted: root.following = false
    WheelHandler {
      onWheel: event => { root.following = false; event.accepted = false }
    }
    ScrollBar.vertical: ScrollBar {
      onPressedChanged: if (pressed) root.following = false
    }
    delegate: Item {
      id: line
      required property var modelData
      required property int index
      width: ListView.view.width
      height: words.implicitHeight + Style.space(10)
      Text {
        id: words
        width: parent.width
        anchors.verticalCenter: parent.verticalCenter
        text: line.modelData.text || "\u266a"
        textFormat: Text.PlainText
        color: line.index === root.activeIndex ? Color.accent : root.subtle
        font.family: Style.font.family
        font.pixelSize: root.textSize
        font.bold: line.index === root.activeIndex
        horizontalAlignment: Text.AlignHCenter
        wrapMode: Text.Wrap
      }
      MouseArea {
        anchors.fill: parent
        enabled: line.modelData.time >= 0 && !!(root.player && root.player.canSeek)
        cursorShape: enabled ? Qt.PointingHandCursor : Qt.ArrowCursor
        onClicked: root.service.seekTo(line.modelData.time + root.service.offset)
      }
    }
  }

  Text {
    anchors.centerIn: list
    width: list.width
    visible: !root.lines.length
    text: root.service ? root.service.lyricsStatus : "Nothing playing"
    textFormat: Text.PlainText
    color: root.subtle
    font.family: Style.font.family
    font.pixelSize: Style.font.body
    horizontalAlignment: Text.AlignHCenter
    wrapMode: Text.Wrap
  }

  Text {
    id: footer
    anchors.horizontalCenter: parent.horizontalCenter
    anchors.bottom: parent.bottom
    text: "LRCLIB  \u00b7  " + (root.following ? "Following playback" : "Manual scroll")
    textFormat: Text.PlainText
    color: root.subtle
    font.family: Style.font.family
    font.pixelSize: Style.font.caption
  }
}
