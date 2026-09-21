import QtQuick
import qs.Ui as Ui
import qs.Commons
import "Model.js" as Model

Ui.BarWidget {
  id: root
  moduleName: "staka.inline-lyrics"
  readonly property var service: bar && bar.shell ? bar.shell.firstPartyServiceFor(moduleName) : null
  readonly property string players: String(setting("players", "spotify"))
  readonly property string ignoredPlayers: String(setting("ignoredPlayers", "mpv,mpvpaper,chromium,firefox,brave,zen"))
  readonly property int barWidthOption: Math.round(Math.max(100, Math.min(800, Number(setting("maxWidth", 380)) || 380)))
  readonly property real maximumWidth: Style.space(barWidthOption)
  readonly property real lyricWidth: Math.ceil(measure.advanceWidth) + Style.space(2)
  readonly property string lyric: service ? service.currentLine : ""
  readonly property real discSize: Math.max(0, Math.min(Style.space(20), barSize - Style.space(4)))
  readonly property string artUrl: service ? service.trackArtUrl : ""
  readonly property bool playing: !!(service && service.isPlaying)
  property bool popupOpen: false
  function close() { popupOpen = false }

  function configure() {
    if (service) service.configure(players, ignoredPlayers)
  }

  function adjustBarWidth(delta) {
    var next = Math.max(100, Math.min(800, barWidthOption + delta))
    if (next === barWidthOption) return
    if (!bar || !bar.shell || typeof bar.shell.mutateShellConfig !== "function") return
    bar.shell.mutateShellConfig(function(config) {
      if (config && config.bar) Model.withMaxWidth(config.bar.layout, root.moduleName, next)
    })
  }

  onServiceChanged: configure()
  onPlayersChanged: configure()
  onIgnoredPlayersChanged: configure()
  Component.onCompleted: configure()

  visible: !!(service && service.hasMedia) && !vertical
  implicitWidth: visible ? Math.min(maximumWidth, lyricWidth + discSize + Style.space(24)) : 0
  implicitHeight: barSize

  Ui.WidgetButton {
    anchors.fill: parent
    bar: root.bar
    labelVisible: false
    hasVisualContent: root.visible
    useActiveColor: false
    pressable: true
    onPressed: button => {
      if (button === Qt.LeftButton && root.service) root.service.togglePlayback()
      else if (button === Qt.RightButton) root.popupOpen = !root.popupOpen
    }
  }

  AlbumDisc {
    id: disc
    anchors.left: parent.left
    anchors.leftMargin: Style.space(8)
    anchors.verticalCenter: parent.verticalCenter
    width: root.discSize
    height: width
    source: root.artUrl
    playing: root.playing
  }

  TextMetrics {
    id: measure
    font: label.font
    text: label.text
  }

  Text {
    id: label
    anchors.left: disc.right
    anchors.right: parent.right
    anchors.top: parent.top
    anchors.bottom: parent.bottom
    anchors.leftMargin: Style.space(8)
    anchors.rightMargin: Style.space(8)
    text: root.lyric || (root.service ? root.service.title : "")
    textFormat: Text.PlainText
    color: Color.accent
    font.family: root.bar ? root.bar.fontFamily : Style.font.family
    font.pixelSize: Style.font.body
    verticalAlignment: Text.AlignVCenter
    elide: Text.ElideRight
    maximumLineCount: 1
    wrapMode: Text.NoWrap
    renderType: Text.NativeRendering
    Accessible.role: Accessible.StaticText
    Accessible.name: root.lyric
  }
  Ui.PopupCard {
    anchorItem: root
    bar: root.bar
    owner: root
    open: root.popupOpen
    contentWidth: fittedContentWidth(reader.implicitWidth + padding * 2)
    contentHeight: cappedContentHeight(reader.implicitHeight + padding * 2 + Style.space(12))
    LyricsPanel {
      id: reader
      anchors.fill: parent
      service: root.service
      active: root.popupOpen
      barWidth: root.barWidthOption
      onBarWidthStep: delta => root.adjustBarWidth(delta)
    }
  }
}
