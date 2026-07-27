import QtQuick

// Localhost HTTP/SSE client for the Staka agent daemon.
//
// The agent binds 127.0.0.1:7920 with no auth (same trust model as the
// session bus: the local user owns the process). This client deliberately
// carries no credentials and never touches org URLs or the machine token -
// those stay inside the agent daemon. The panel is a dumb transport.
//
// Endpoints (see packages/agent/src/api/routes.ts):
//   GET  /health  -> { status, machine_id, org_name, model, skills_count, memory_entries }
//   GET  /skills  -> [ { name, description, source, path } ]
//   POST /chat    -> SSE stream; event name "message", data = JSON AgentEvent
//
// AgentEvent shapes (from @staka/protocol ProtocolEvent):
//   { type: "text_delta", content }
//   { type: "tool_call_start", name, args }
//   { type: "tool_call_end", name, result_summary }
//   { type: "error", message }
//   { type: "done", tokens_in?, tokens_out? }
QtObject {
  id: root

  property string baseUrl: "http://127.0.0.1:7920"

  // Health state, refreshed by pollHealth().
  property bool healthy: false
  // "unknown" | "ok" | "unreachable" | <agent-reported status, e.g. "suspended">
  property string healthStatus: "unknown"
  property string machineId: ""
  property string orgName: ""
  property string model: ""
  property int skillsCount: 0
  property int memoryEntries: 0

  property var healthTimer: Timer {
    interval: 10000
    repeat: true
    running: true
    triggeredOnStart: true
    onTriggered: root.pollHealth()
  }

  function pollHealth() {
    var xhr = new XMLHttpRequest()
    xhr.open("GET", baseUrl + "/health")
    xhr.onreadystatechange = function() {
      if (xhr.readyState !== XMLHttpRequest.DONE) return
      if (xhr.status === 200) {
        try {
          var body = JSON.parse(xhr.responseText)
          root.machineId = body.machine_id || ""
          root.orgName = body.org_name || ""
          root.model = body.model || ""
          root.skillsCount = body.skills_count || 0
          root.memoryEntries = body.memory_entries || 0
          root.healthStatus = body.status || "ok"
          root.healthy = root.healthStatus === "ok"
        } catch (e) {
          root.healthy = false
          root.healthStatus = "unknown"
        }
      } else {
        root.healthy = false
        root.healthStatus = "unreachable"
      }
    }
    xhr.send()
  }

  // POST /chat and stream AgentEvents back through onEvent(obj).
  // The agent speaks SSE: blocks of "data: <json>" lines separated by a
  // blank line. We parse responseText incrementally as it arrives so text
  // deltas render live, buffering any partial trailing line.
  function chat(message, sessionId, onEvent) {
    var xhr = new XMLHttpRequest()
    xhr.open("POST", baseUrl + "/chat")
    xhr.setRequestHeader("Content-Type", "application/json")
    xhr.setRequestHeader("Accept", "text/event-stream")

    var buffer = ""
    var lastIndex = 0
    var dataLines = []

    var flushEvent = function() {
      if (dataLines.length === 0) return
      var payload = dataLines.join("\n")
      dataLines = []
      if (payload.length === 0) return
      try {
        onEvent(JSON.parse(payload))
      } catch (e) {
        // Ignore malformed frames rather than killing the stream.
      }
    }

    xhr.onreadystatechange = function() {
      // readyState 3 (LOADING) fires as chunks land; 4 (DONE) at stream end.
      if (xhr.readyState !== XMLHttpRequest.LOADING && xhr.readyState !== XMLHttpRequest.DONE) return
      var text = xhr.responseText || ""
      buffer += text.slice(lastIndex)
      lastIndex = text.length

      var nl
      while ((nl = buffer.indexOf("\n")) >= 0) {
        var line = buffer.slice(0, nl)
        buffer = buffer.slice(nl + 1)
        if (line.charAt(line.length - 1) === "\r") line = line.slice(0, -1)
        if (line.length === 0) {
          flushEvent()
        } else if (line.indexOf("data:") === 0) {
          dataLines.push(line.slice(5).replace(/^ /, ""))
        }
        // "event:" / "id:" / ":" comment lines are ignored.
      }

      if (xhr.readyState === XMLHttpRequest.DONE) {
        flushEvent()
        if (xhr.status !== 200) {
          onEvent({ type: "error", message: "agent returned HTTP " + xhr.status })
        }
        onEvent({ type: "done" })
      }
    }

    var body = { message: message }
    if (sessionId) body.session_id = sessionId
    xhr.send(JSON.stringify(body))
  }

  // GET /skills -> array of { name, description, source, path }.
  function listSkills(callback) {
    var xhr = new XMLHttpRequest()
    xhr.open("GET", baseUrl + "/skills")
    xhr.onreadystatechange = function() {
      if (xhr.readyState !== XMLHttpRequest.DONE) return
      if (xhr.status === 200) {
        try {
          callback(JSON.parse(xhr.responseText))
        } catch (e) {
          callback([])
        }
      } else {
        callback([])
      }
    }
    xhr.send()
  }
}
