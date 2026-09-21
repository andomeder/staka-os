# KB fixtures

Sample org content for knowledge base tests and the engine evaluation.

Layout:

- `docs/` - markdown org documents (procedures, policies, guides).
  `orgb-facilities.md` belongs to a second organisation and is used by the
  cross-org isolation tests.
- `profiles/` - org directory profile documents. `who_knows` evidence
  comes from these.
- `packs/demo-pack/` - a skill pack in the Slice 2 pack format (dirs with
  SKILL.md frontmatter) used by skill pack sync tests.
- `queries.json` - evaluation queries with the expected fixture hit, used
  by the engine gate and by regression tests.
