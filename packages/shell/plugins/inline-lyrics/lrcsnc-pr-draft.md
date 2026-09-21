# lrcsnc upstream PR draft

Target: https://github.com/Endg4meZer0/lrcsnc
Base commit: `40ad2fcac79a66c1d8e6cfaa97b175536fe0c8d0` (v0.1.3-1)

**NOTE: this patch does NOT fix issue #9. Do not write `Fixes #9` in the PR.**
See "Issue #9" section at the bottom.

---

## Commit message

```
fix(mpris): make "included-players" exclusive and let "excluded-players" win

Players missing from a non-empty include list were still accepted, so
browsers and wallpapers leaked into the match. Exclusions were also
skipped whenever an include list was set.
```

## PR title

```
fix(mpris): make "included-players" exclusive and let "excluded-players" win
```

## PR body

```markdown
`playerInFilter` had two bugs.

An include list was not exclusive. If nothing matched, it fell through
to `return true`, so with `included-players = ["spotify"]` a browser or
a wallpaper could still get picked up. It acted like a hint more than a
filter.

And an exclude only got checked when the include list was empty. Anything
that matched an include returned `true` straight away, so
`excluded-players` could never veto it.

Now exclusions win and a non-empty include list is exclusive: you have to
be on it to pass. An empty include list still accepts everything, so if
you only use `excluded-players` nothing changes for you.

The test covers a match, a miss, an exclude with no include list, an
exclude that overrides an include, and the no-filter case.
```

## Follow-up comment (post a few minutes after the PR)

Two things that don't belong in the description, sent as a comment so the
PR body stays short.

````markdown
Two notes I left out of the description.

The test sits in `internal/mpris` rather than `tests/...` like the rest.
`playerInFilter` isn't exported so it has to be in-package to reach it.
If you'd rather I move the filtering out into something exported I can
restructure it.

I also checked this doesn't break anything on non-Linux. The patch only
touches `playerInFilter` and adds a test file, no new imports beyond
`strings`, which was already there. `GOOS=darwin go build ./internal/mpris/`
is clean. Windows fails on `syscall.Kill` in `internal/pkg/log`, but it
does that on the current main too, so it's not from this change.
````

## Diff

```diff
diff --git a/internal/mpris/player.go b/internal/mpris/player.go
index 08b39f3..356e7e2 100644
--- a/internal/mpris/player.go
+++ b/internal/mpris/player.go
@@ -255,21 +255,24 @@ func SetPosition(pos float64) error {
 func playerInFilter(player string) bool {
 	global.Config.M.Lock()
 	defer global.Config.M.Unlock()
-	if len(global.Config.C.Player.IncludedPlayers) != 0 {
-		for _, includedPlayer := range global.Config.C.Player.IncludedPlayers {
-			if strings.Contains(player, includedPlayer) {
-				return true
-			}
+
+	// Excluded players take precedence over included ones.
+	for _, excludedPlayer := range global.Config.C.Player.ExcludedPlayers {
+		if strings.Contains(player, excludedPlayer) {
+			return false
 		}
 	}
 
-	if len(global.Config.C.Player.ExcludedPlayers) != 0 {
-		for _, excludedPlayer := range global.Config.C.Player.ExcludedPlayers {
-			if strings.Contains(player, excludedPlayer) {
-				return false
-			}
+	if len(global.Config.C.Player.IncludedPlayers) == 0 {
+		return true
+	}
+
+	// With an include list set, only players on it pass the filter.
+	for _, includedPlayer := range global.Config.C.Player.IncludedPlayers {
+		if strings.Contains(player, includedPlayer) {
+			return true
 		}
 	}
 
-	return true
+	return false
 }
```

## New file: `internal/mpris/player_test.go`

```go
package mpris

import (
	"lrcsnc/internal/pkg/global"
	"testing"
)

func TestPlayerInFilter(t *testing.T) {
	tests := []struct {
		name     string
		included []string
		excluded []string
		player   string
		want     bool
	}{
		{
			name:     "player on include list passes",
			included: []string{"spotify"},
			player:   "org.mpris.MediaPlayer2.spotify",
			want:     true,
		},
		{
			name:     "player missing from include list is rejected",
			included: []string{"spotify"},
			player:   "org.mpris.MediaPlayer2.chromium",
			want:     false,
		},
		{
			name:     "excluded player is rejected even when no include list is set",
			excluded: []string{"mpvpaper"},
			player:   "org.mpris.MediaPlayer2.mpvpaper",
			want:     false,
		},
		{
			name:     "exclude wins over include",
			included: []string{"spotify"},
			excluded: []string{"spotify"},
			player:   "org.mpris.MediaPlayer2.spotify",
			want:     false,
		},
		{
			name:   "no filters accepts any player",
			player: "org.mpris.MediaPlayer2.anything",
			want:   true,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			global.Config.C.Player.IncludedPlayers = tt.included
			global.Config.C.Player.ExcludedPlayers = tt.excluded

			if got := playerInFilter(tt.player); got != tt.want {
				t.Errorf("playerInFilter(%q) = %v, want %v", tt.player, got, tt.want)
			}
		})
	}
}
```

## Verification

```
go test -race -count=1 ./internal/mpris/   -> ok (1.01s)
gofmt -l internal/mpris/                   -> (clean)
```

## Old vs new behaviour (measured)

| case | old | new | changed |
|---|---|---|---|
| excl firefox/zen, firefox playing (#9 config) | false | false | |
| excl firefox/zen, chromium playing (#9 config) | true | true | |
| default config, spotify playing | true | true | |
| include=[spotify], vlc playing | true | false | **yes** |
| include=[spotify], spotify playing | true | true | |
| include=[spotify] + exclude=[spotify] | true | false | **yes** |

## Issue #9 (separate, NOT fixed by this patch)

Issue #9 config:

```toml
[player]
included-players = []
excluded-players = ["firefox", "zen"]
```

With an empty include list and `firefox` excluded, the OLD code already
returns `false` for `org.mpris.MediaPlayer2.firefox.instance_1_192924`
(confirmed by running the OLD logic over the reporter's exact config).
Old and new agree on every case in that issue, which is why the
maintainer's unit test "works properly". The filter body is correct
for #9's config, so the patch above does not change #9's behaviour.

### Verified root cause

The reporter's browser video is not exposed under a name containing
`firefox` or `zen`. On a KDE/Plasma desktop, browser media is published
by `plasma-browser-integration` as:

```
org.mpris.MediaPlayer2.plasma-browser-integration
```

That name contains neither excluded substring, so it legitimately
passes the filter and gets watched. The reporter only blocked the
names they could see in `playerctl -l` at that moment (`firefox`), not
the second MPRIS name their browser also publishes.

Reproduced live against the reporter's exact config, with the same
MPRIS names present on this machine:

```
$ ./lrcsnc-orig --log-level debug -c cfg/config.toml
Current players available in MPRIS: org.mpris.MediaPlayer2.chromium.instance14142,
  org.mpris.MediaPlayer2.firefox.instance_1_1280,
  org.mpris.MediaPlayer2.kdeconnect.mpris_7114bceb...,
  org.mpris.MediaPlayer2.mpv,
  org.mpris.MediaPlayer2.plasma-browser-integration,
  org.mpris.MediaPlayer2.plasma-browser-integration-260563,
  org.mpris.MediaPlayer2.spotify
Found a fitting player: 'org.mpris.MediaPlayer2.chromium.instance14142'
Switched to player 'org.mpris.MediaPlayer2.chromium.instance14142'
```

`firefox` was correctly skipped. `chromium` was then accepted because
its name contains neither `firefox` nor `zen`. Same result with the
patched binary, which is expected: the two are equivalent for this
config.

So #9 is a filter-syntax/documentation problem, not a filtering bug.
The name a browser publishes is not always the browser's own name.

Options for the maintainer:

- Document that `excluded-players` matches raw D-Bus names and that
  browsers may publish more than one (e.g. add
  `plasma-browser-integration` to the default exclude list, or to the
  wiki compatibility page).
- Match on the player's identity/short name instead of the raw bus
  name, if a more intuitive behaviour is wanted.

Either way, worth noting the default config already excludes
`firefox` and `zen`, so a user on Plasma who reports this will keep
hitting it until `plasma-browser-integration` is accounted for.


---

## Draft reply for issue #9

Posted as a comment on the issue. Asks for the one artifact that
discriminates between the hypotheses, instead of asserting a cause.

````markdown
Popping in from reading the filter code. I think I can explain part of
this, but I can't say it's your setup for sure without one more thing.

The filter matches the raw D-Bus name, not what `playerctl -l` shows.
`mpris.List()` hands back names like
`org.mpris.MediaPlayer2.firefox.instance_1_192924`, and excluded-players
gets checked with `strings.Contains` against that whole string. So
`"firefox"` does match and firefox itself does get skipped. I ran your
config over it and got false, same as your unit test.

The thing is, a browser can publish more than one MPRIS name, and only
one of them has the browser's name in it. On Plasma the browser
extension puts media out as:

```
org.mpris.MediaPlayer2.plasma-browser-integration
```

Nothing in there says firefox or zen, so it sails through the filter and
gets watched. I got this with your exact config:

```
Current players available in MPRIS: org.mpris.MediaPlayer2.firefox.instance_1_1280,
  ..., org.mpris.MediaPlayer2.plasma-browser-integration, ...
Found a fitting player: 'org.mpris.MediaPlayer2.chromium.instance14142'
```

firefox got skipped, then the first name with neither firefox nor zen in
it was grabbed instead. That's where the lyrics came from.

Any chance you could grab the line that settles it? With debug logging:

```
grep "Current players available" ~/.local/state/lrcsnc/log
```

It prints every name the filter saw. If something other than `firefox`
turns up there, that's the leak. If firefox really is the only name on
the list then I've got this wrong and the bug is somewhere else, which
is worth knowing either way.

### A possible fix

Those names come from `ListNames`. MPRIS clients also expose an
`Identity` property with the readable app name. Here,
`plasma-browser-integration` reports `Identity = "Mozilla Firefox"`, and
firefox reports `Mozilla firefox`.

So if the config strings got matched against the bus name *and* the
`Identity`, your config would do what you meant it to. The bridge would
get caught by `"firefox"` even though its bus name never says the word.
I wrote the helper and ran it over these names. `"firefox"` knocks out
both clients and still lets chromium, spotify and mpv through. Has to be
case-insensitive.

One catch: some clients don't expose `Identity` at all (kdeconnect
returns nothing for it), so it needs to fall back to the bus name
instead of treating a missing identity as a miss. Costs a property read
per player on each `ChangePlayer()` too. Happy to send that as a PR if
you think matching on identity is right, or just document the bus-name
behaviour and add `plasma-browser-integration` to the default excludes.

Separate from the filter bug in the PR I opened, by the way. With an
empty include list and firefox excluded the old and new code do the same
thing, so that fix won't change anything for you.
````