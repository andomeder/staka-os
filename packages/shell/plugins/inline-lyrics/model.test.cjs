const assert = require('node:assert/strict')
const fs = require('node:fs')
const vm = require('node:vm')
const { test } = require('node:test')
const model = vm.createContext({})
vm.runInContext(fs.readFileSync(__dirname + '/Model.js', 'utf8'), model)

test('cache query quotes metadata and matches recording duration', () => {
  const query = model.cacheQuery({ title: "Don't", artist: 'Singer', album: 'Live', duration: 123 })
  assert.ok(query.includes("title = 'Don''t'"))
  assert.ok(query.includes('abs(duration - 123) < 0.1'))
})

test('cache lyrics preserve timestamps and text', () => {
  const result = model.cacheLines(JSON.stringify([{ lyrics: JSON.stringify([{ Timing: 1.5, Text: '<literal>' }]), state: 4 }]))
  assert.equal(result[0].time, 1.5)
  assert.equal(result[0].text, '<literal>')
})

test('invalid cached rows are rejected', () => {
  assert.equal(model.cacheLines('invalid').length, 0)
  assert.equal(model.cacheLines('[{"lyrics":"[{\"Timing\":-2}]"}]').length, 0)
})

test('active line handles intro, repeated text and backwards seeking', () => {
  const lines = [{time: 5, text: 'Repeat'}, {time: 10, text: 'Repeat'}, {time: 20, text: 'End'}]
  assert.equal(model.activeLine(lines, 0), -1)
  assert.equal(model.activeLine(lines, 10), 1)
  assert.equal(model.activeLine(lines, 6), 0)
})

test('withMaxWidth sets maxWidth on the matching entry only', () => {
  const layout = { left: [{ id: 'omarchy.workspaces' }, { id: 'cloudsurfer.inline-lyrics', players: 'spotify' }], right: [] }
  assert.equal(model.withMaxWidth(layout, 'cloudsurfer.inline-lyrics', 520), true)
  assert.equal(layout.left[1].maxWidth, 520)
  assert.equal(layout.left[1].players, 'spotify')
  assert.equal(layout.left[0].maxWidth, undefined)
})

test('withMaxWidth clamps and reports a miss', () => {
  const low = { left: [{ id: 'cloudsurfer.inline-lyrics' }] }
  const high = { center: [{ id: 'cloudsurfer.inline-lyrics' }] }
  assert.equal(model.withMaxWidth(low, 'cloudsurfer.inline-lyrics', 10), true)
  assert.equal(low.left[0].maxWidth, 100)
  assert.equal(model.withMaxWidth(high, 'cloudsurfer.inline-lyrics', 5000), true)
  assert.equal(high.center[0].maxWidth, 800)
  assert.equal(model.withMaxWidth(high, 'someone.else', 400), false)
  assert.equal(model.withMaxWidth(null, 'cloudsurfer.inline-lyrics', 400), false)
})
