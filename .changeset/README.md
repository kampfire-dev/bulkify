# Changesets

Each PR that changes the published package adds a changeset: a short file
saying how the version should change and what to put in the changelog.

```sh
pnpm changeset
```

Pick patch, minor or major, then write the changelog entry. It can be several
lines of Markdown. Commit the file it creates here with your PR.

PRs that only touch tests, examples, docs or CI don't need one.

See "Releasing" in the main README for what happens after merging.
