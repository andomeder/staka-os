---
name: memory-recall
description: Search past conversations and sessions for previously discussed topics. Use when the user references something from a past conversation or asks what was discussed earlier.
---

# Memory Recall

Search past session transcripts to recall previous conversations.

## When to use

- User says "what did we discuss earlier" or "last time we talked about..."
- User references a past conversation
- You need context from a previous session

## Steps

1. Formulate a search query from the user's reference
2. Call `session_search` with the query
3. Review the matched entries (role, timestamp, content preview)
4. Summarise the relevant past context for the user

## Notes

- Search uses full-text matching across all session transcripts
- Results include timestamps for temporal context
- Content previews are truncated; the full content is in the session store
