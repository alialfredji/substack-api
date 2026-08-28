# Publishing

The CLI and TypeScript library are published together as `@alialf/substack-api`.
Publishing is manual; no GitHub Actions workflow is required.

## First release

Start from a clean, up-to-date `main` checkout:

```bash
git pull --ff-only
npm ci
npm run typecheck
npm test
npm pack --dry-run
```

Log in to npm and confirm the active account:

```bash
npm login
npm whoami
```

Publish the public scoped package:

```bash
npm publish --access public
```

Verify the release:

```bash
npm view @alialf/substack-api version
npx --yes --package @alialf/substack-api@latest substack-api call /health
```

## Later releases

Choose the appropriate semantic-version bump:

```bash
npm version patch
# or: npm version minor
# or: npm version major
```

Run the checks above, publish, then push the version commit and tag:

```bash
npm publish --access public
git push --follow-tags
```

Do not republish an existing version. If a publish fails after the version commit
is created, fix the problem and publish that same unpublished version.

## Test the agent skill before publishing

Install the skill from a local checkout:

```bash
npx skills add . --skill substack-api --agent codex -y --copy
export SUBSTACK_API_DIR=/absolute/path/to/substack-api
```

Start or restart Codex from that shell, then invoke
`$substack-api` or ask Codex to query a Substack profile.

## Install the released skill

Install directly from GitHub:

```bash
npx skills add alialf/substack-api --skill substack-api --agent codex -g -y
```

Restart Codex after installing or updating the skill.
