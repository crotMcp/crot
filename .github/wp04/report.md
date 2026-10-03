# WP-04 temporary CI report

- Run: https://github.com/ASTYCAT/crot-mcp/actions/runs/37139283646
- Trigger commit: 5cc6119d81caa94d6ce1cdd791527119a425a780
- Verified commit: 5be1287723266f9f1ae31721e8005e9cd0ef9f6f
- Jobs: prepare=success apply=success verify=success

## prepare (ubuntu-latest, Node v22.23.3, npm 10.9.9)

- Base commit: 5cc6119d81caa94d6ce1cdd791527119a425a780
- Dev dependencies already in package.json; lockfile step skipped.
- edits.patch applied: 4 files changed, 12 insertions(+), 4 deletions(-)
- Prettier: no changes
- Commits exported: 1

## verify

### macos-latest-node20 (Node v20.20.2, npm 10.8.2, commit 5be1287)

- `npm ci`: exit 0 (3 s)
- `npm run lint`: exit 0 (3 s)
- `npm run format:check`: exit 0 (2 s)
- `npm run typecheck`: exit 0 (3 s)
- `npm run typecheck:extension`: exit 0 (2 s)
- `npm run build`: exit 0 (3 s)
- `npm run build:extension`: exit 0 (2 s)
- `npm test`: exit 0 (18 s)
- `npm run test:extension`: exit 0 (1 s)
- `npm run check`: exit 0 (40 s)
- working tree clean after checks

### macos-latest-node22 (Node v22.23.2, npm 10.9.8, commit 5be1287)

- `npm ci`: exit 0 (9 s)
- `npm run lint`: exit 0 (4 s)
- `npm run format:check`: exit 0 (3 s)
- `npm run typecheck`: exit 0 (3 s)
- `npm run typecheck:extension`: exit 0 (2 s)
- `npm run build`: exit 0 (3 s)
- `npm run build:extension`: exit 0 (1 s)
- `npm test`: exit 0 (19 s)
- `npm run test:extension`: exit 0 (2 s)
- `npm run check`: exit 0 (36 s)
- working tree clean after checks

### ubuntu-latest-node20 (Node v20.20.2, npm 10.8.2, commit 5be1287)

- `npm ci`: exit 0 (2 s)
- `npm run lint`: exit 0 (4 s)
- `npm run format:check`: exit 0 (6 s)
- `npm run typecheck`: exit 0 (6 s)
- `npm run typecheck:extension`: exit 0 (3 s)
- `npm run build`: exit 0 (4 s)
- `npm run build:extension`: exit 0 (2 s)
- `npm test`: exit 0 (35 s)
- `npm run test:extension`: exit 0 (2 s)
- `npm run check`: exit 0 (61 s)
- `vitest list (default config) has no tests-e2e`: exit 0 (0 s)
- default vitest files: 37, of which tests-e2e: 0
- working tree clean after checks

### ubuntu-latest-node22 (Node v22.23.3, npm 10.9.9, commit 5be1287)

- `npm ci`: exit 0 (4 s)
- `npm run lint`: exit 0 (6 s)
- `npm run format:check`: exit 0 (5 s)
- `npm run typecheck`: exit 0 (6 s)
- `npm run typecheck:extension`: exit 0 (3 s)
- `npm run build`: exit 0 (4 s)
- `npm run build:extension`: exit 0 (2 s)
- `npm test`: exit 0 (44 s)
- `npm run test:extension`: exit 0 (3 s)
- `npm run check`: exit 0 (67 s)
- `vitest list (default config) has no tests-e2e`: exit 0 (0 s)
- default vitest files: 37, of which tests-e2e: 0
- working tree clean after checks

### windows-latest-node20 (Node v20.20.2, npm 10.8.2, commit 5be1287)

- `npm ci`: exit 0 (5 s)
- `npm run lint`: exit 0 (5 s)
- `npm run format:check`: exit 0 (5 s)
- `npm run typecheck`: exit 0 (5 s)
- `npm run typecheck:extension`: exit 0 (4 s)
- `npm run build`: exit 0 (4 s)
- `npm run build:extension`: exit 0 (2 s)
- `npm test`: exit 0 (79 s)
- `npm run test:extension`: exit 0 (3 s)
- `npm run check`: exit 0 (108 s)
- working tree clean after checks

### windows-latest-node22 (Node v22.23.3, npm 10.9.9, commit 5be1287)

- `npm ci`: exit 0 (7 s)
- `npm run lint`: exit 0 (10 s)
- `npm run format:check`: exit 0 (6 s)
- `npm run typecheck`: exit 0 (5 s)
- `npm run typecheck:extension`: exit 0 (2 s)
- `npm run build`: exit 0 (4 s)
- `npm run build:extension`: exit 0 (2 s)
- `npm test`: exit 0 (64 s)
- `npm run test:extension`: exit 0 (2 s)
- `npm run check`: exit 0 (83 s)
- working tree clean after checks

