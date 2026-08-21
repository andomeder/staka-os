import QtQuick
import qs.Commons
import qs.Ui

BarWidget {
  id: root
  moduleName: "staka.menu"

  implicitWidth: button.implicitWidth
  implicitHeight: button.implicitHeight

  WidgetButton {
    id: button
    anchors.fill: parent
    bar: root.bar
    text: "\u2630"
    fontFamily: Style.font.family
    horizontalMargin: 7.5
    onPressed: function(button) {
      if (!root.bar) return
      if (button === Qt.RightButton) root.bar.run("xdg-terminal-exec")
      else root.bar.run("staka-shell shell toggle staka.menu '{\"menu\":\"root\"}'")
    }
  }
}
