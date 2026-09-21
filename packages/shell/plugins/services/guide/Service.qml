import QtQuick
import Quickshell
import Quickshell.Io
import Quickshell.Wayland
import qs.Commons

// Guidance overlay: the agent pointing at things on the user's output.
//
// One full-screen layer-shell surface per output, always on the overlay
// layer, rendering a highlight box, a fake agent cursor, and an optional
// label at compositor-native global coordinates. The surface NEVER accepts
// input: the empty input mask below makes the compositor pass every pointer
// event through to the windows beneath (proven by
// packages/shell/tests/guide-overlay-clickthrough).
//
// Driven over shell IPC (see bin/staka-shell), target "guide":
//   highlight  { x, y, w?, h?, label?, durationMs? }
//   sequence   { steps: [ { x, y, w?, h?, label?, durationMs? } ] }
//   clear      no arguments
// Coordinates are global compositor coordinates, the same space
// hyprctl/CDP/AT-SPI reads report.
Item {
  id: root

  property var shell: null
  property string stakaPath: Quickshell.env("STAKA_PATH")

  // Normalized steps: [{ x, y, w, h, label, durationMs }]
  property var steps: []
  property int stepIndex: -1

  readonly property bool active: stepIndex >= 0 && stepIndex < steps.length
  readonly property var currentStep: active ? steps[stepIndex] : null

  // A single highlight lingers longer than a sequence step by default.
  readonly property int defaultHighlightMs: 10000
  readonly property int defaultStepMs: 4000
  readonly property int maxSteps: 10
  readonly property int minDurationMs: 500
  readonly property int maxDurationMs: 60000

  Timer {
    id: stepTimer
    onTriggered: root.advance()
  }

  function clear() {
    stepTimer.stop()
    root.steps = []
    root.stepIndex = -1
  }

  function advance() {
    if (!root.active) return
    if (root.stepIndex + 1 >= root.steps.length) {
      root.clear()
      return
    }
    root.stepIndex += 1
    armTimer()
  }

  function armTimer() {
    stepTimer.interval = root.currentStep.durationMs
    stepTimer.restart()
  }

  function normalizeStep(raw, fallbackMs) {
    return {
      x: Math.round(Number(raw.x) || 0),
      y: Math.round(Number(raw.y) || 0),
      w: Math.max(8, Math.round(Number(raw.w) || 160)),
      h: Math.max(8, Math.round(Number(raw.h) || 56)),
      label: typeof raw.label === "string" ? raw.label.slice(0, 80) : "",
      durationMs: Math.min(root.maxDurationMs,
        Math.max(root.minDurationMs, Math.round(Number(raw.durationMs) || fallbackMs)))
    }
  }

  function showHighlight(raw) {
    root.steps = [normalizeStep(raw, root.defaultHighlightMs)]
    root.stepIndex = 0
    armTimer()
  }

  function showSequence(rawSteps) {
    var list = Array.isArray(rawSteps) ? rawSteps.slice(0, root.maxSteps) : []
    root.steps = list.map(function(s) { return normalizeStep(s, root.defaultStepMs) })
    root.stepIndex = root.steps.length > 0 ? 0 : -1
    if (root.active) armTimer()
  }

  function showHighlightJson(text) {
    try {
      var payload = JSON.parse(text)
      if (payload === null || typeof payload !== "object") return
      showHighlight(payload)
    } catch (e) {
      console.warn("guide: invalid highlight payload:", e)
    }
  }

  function showSequenceJson(text) {
    try {
      var payload = JSON.parse(text)
      if (payload === null || typeof payload !== "object") return
      showSequence(payload.steps)
    } catch (e) {
      console.warn("guide: invalid sequence payload:", e)
    }
  }

  IpcHandler {
    target: "guide"

    function highlight(payloadJson: string): void { root.showHighlightJson(payloadJson) }
    function sequence(payloadJson: string): void { root.showSequenceJson(payloadJson) }
    function clear(): void { root.clear() }
  }

  // One overlay surface per output. A step whose global coordinates fall on
  // another output simply renders outside this window's bounds (clipped).
  Variants {
    model: Quickshell.screens

    PanelWindow {
      id: overlayWindow
      required property var modelData
      screen: modelData
      visible: root.active

      anchors { top: true; bottom: true; left: true; right: true }
      color: "transparent"
      exclusionMode: ExclusionMode.Ignore
      WlrLayershell.namespace: "staka-guide"
      WlrLayershell.layer: WlrLayer.Overlay
      WlrLayershell.keyboardFocus: WlrKeyboardFocus.None

      // Safety-critical: an empty input region. The compositor must route
      // every pointer event to the windows beneath this surface. Never
      // replace this with a region that accepts input.
      mask: Region {}

      Highlight {
        visible: root.active
        step: root.currentStep
        screenX: overlayWindow.modelData.x
        screenY: overlayWindow.modelData.y
      }
    }
  }
}
