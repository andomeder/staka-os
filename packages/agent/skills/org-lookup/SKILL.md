---
name: org-lookup
description: Search the organisation directory for people by name, employee ID, or email. Use when the user asks to find a colleague, look up contact details, or resolve who someone is.
---

# Organisation Directory Lookup

Use the `org_users_search` tool to find people in the organisation.

## When to use

- User asks "who is X" or "find X"
- User needs to send something to a colleague
- User asks for contact details

## Steps

1. Extract the search query from the user's request (name, partial name, or employee ID)
2. Call `org_users_search` with the query
3. Present results clearly: display name, employee ID, email
4. If multiple matches, list them and ask the user to confirm

## Notes

- Search is prefix-based on employee_id, display_name, and email
- Maximum 10 results returned
- Only non-PII fields are returned
