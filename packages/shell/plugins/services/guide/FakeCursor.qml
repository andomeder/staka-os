import QtQuick
import qs.Commons

// Fake agent cursor: an accent-colored arrow sprite that is visually
// distinct from the user's real cursor by design - it lives on a
// click-through layer surface and never moves the actual pointer.
Item {
  id: cursor

  property string label: ""
  readonly property int arrowScale: 2

  width: 13 * arrowScale
  height: 20 * arrowScale

  Canvas {
    anchors.fill: parent
    antialiasing: true
    onPaint: {
      var ctx = getContext("2d")
      var s = cursor.arrowScale
      ctx.reset()
      ctx.beginPath()
      ctx.moveTo(0, 0)
      ctx.lineTo(0, 16 * s)
      ctx.lineTo(4.5 * s, 12.5 * s)
      ctx.lineTo(7.5 * s, 19 * s)
      ctx.lineTo(10 * s, 17.5 * s)
      ctx.lineTo(7 * s, 11 * s)
      ctx.lineTo(12 * s, 11 * s)
      ctx.closePath()
      ctx.fillStyle = Color.accent
      ctx.fill()
      ctx.lineWidth = 1
      ctx.strokeStyle = Color.background
      ctx.stroke()
    }
  }

  // Optional floating tag so the pointing intent is readable even without
  // the highlight label chip.
  Text {
    visible: cursor.label.length > 0
    text: "Staka"
    color: Color.accent
    font.family: Style.fontFamily
    font.pixelSize: Style.font.caption
    font.bold: true
    anchors.left: parent.right
    anchors.leftMargin: 4
    anchors.verticalCenter: parent.verticalCenter
  }
}
