# WP-04 temporary CI report

- Run: https://github.com/ASTYCAT/crot-mcp/actions/runs/37138579644
- Trigger commit: 0a991719436ef8111dc1ec934865fe1f4caff720
- Verified commit: 6cf303789aff4513c90432e2bb04155d560d92da
- Jobs: prepare=success apply=success verify=success

## prepare (ubuntu-latest, Node v22.23.3, npm 10.9.9)

- Base commit: 0a991719436ef8111dc1ec934865fe1f4caff720
- package.json: added devDependencies @eslint/js@^9.39.5, eslint@^9.39.5, eslint-config-prettier@^10.1.8, prettier@^3.9.9, typescript-eslint@^8.71.0
- package-lock.json: 217 existing entries unchanged, 98 entries added
  - @eslint/js 9.39.5 sha512-QywQuszQh77pIXCsq998c8hbhSTI/azTty1Z6N53dmAudKHhy573j3yvRLsX2BSp8YpLtoCEG8E9DJe+8zUh4A==
  - eslint 9.39.5 sha512-DgZS62aPLXKlnxILS/AYCoRvHaZeXceIzlXPkkGGzJWSow1aEk0lbTlxUSlyjC8jcaKxAdOnTDz+o1JFSBsyjw==
  - eslint-config-prettier 10.1.8 sha512-82GZUjRS0p/jganf6q1rEO25VSoHH0hKPCTrgillPjdI/3bgBhAE1QzHrHTizjpRvy6pGAvKjDJtk2pF9NDq8w==
  - prettier 3.9.9 sha512-Z/CJHIkdujO/OtN7nXUii0Rf3VT5SRuhjBA82Xvu2XhBUgX3nhP67T0LHceBdQLex7OOFGTox+Q5Yg8Jk2Qivg==
  - typescript-eslint 8.71.0 sha512-fBdHYiqQ14RW6mOMXD14Svn82ZsCYAoQSzGRzyEjR59S5A2Krh/l7fGTOQ7iCr8gGy/mHVXtEF7s5fgjEdV0Pw==
- Note: lock root dependencies resynced with package.json: {"@modelcontextprotocol/sdk":"^1.31.0","koffi":"3.3.2","zod":"^4.0.0"} -> {"@modelcontextprotocol/sdk":"^1.31.0","zod":"^4.0.0"}
- Prettier: 91 files changed, 2763 insertions(+), 952 deletions(-)

```
 .github/wp04/verify-lock.mjs                |   3 +-
 extension/src/chrome-api.ts                 |   5 +-
 extension/src/commands.ts                   |  67 ++++++++++++-------
 extension/src/errors.ts                     |   3 +-
 extension/src/host-connection.ts            |  20 ++++--
 extension/src/page-functions.ts             |   4 +-
 extension/test/commands.test.ts             |  96 ++++++++++++++++++++++-----
 extension/test/fake-chrome.ts               |  16 ++++-
 extension/test/host-connection.test.ts      |  30 +++++++--
 extension/test/manifest.test.ts             |  37 +++++++----
 extension/test/page-functions.test.ts       |   5 +-
 src/adapters/http/auth.ts                   |  15 ++++-
 src/adapters/http/context.ts                |   4 +-
 src/adapters/http/server.ts                 |  61 +++++++++++++----
 src/adapters/mcp/tools.ts                   |  18 +++--
 src/bin/crot-browser-relay.ts               |   6 +-
 src/bin/crot-mcp.ts                         |  37 ++++++++---
 src/browser-bridge/endpoint.ts              |  41 +++++++++---
 src/browser-bridge/protocol.ts              |  58 +++++++++++++----
 src/browser-bridge/relay.ts                 |  20 ++++--
 src/browser-bridge/server.ts                |  89 ++++++++++++++++++++-----
 src/cli/browser-install.ts                  |  78 +++++++++++++++++-----
 src/cli/browser.ts                          |   4 +-
 src/cli/options.ts                          |  37 ++++++++---
 src/core/audit/audit.ts                     |   4 +-
 src/core/auth/principal.ts                  |   4 +-
 src/core/capabilities/browser/connection.ts |   6 +-
 src/core/capabilities/browser/schemas.ts    |  16 ++++-
 src/core/capabilities/browser/service.ts    | 138 ++++++++++++++++++++++++++-------------
 src/core/capabilities/filesystem/schemas.ts |   7 +-
 src/core/capabilities/filesystem/service.ts | 311 ++++++++++++++++++++++++++++++++++++++++++++++++++++++---------------------------------
 src/core/capabilities/process/schemas.ts    |  42 ++++++++++--
 src/core/capabilities/process/service.ts    |  50 +++++++++++---
 src/core/config/load.ts                     |  18 ++++-
 src/core/config/schema.ts                   |  30 +++++++--
 src/core/crot-core.ts                       |  40 ++++++++++--
 src/core/errors.ts                          |   8 ++-
 src/core/execution/guard.ts                 |   5 +-
 src/core/permissions/capabilities.ts        |   6 +-
 src/core/platform/encoding.ts               |  46 +++++++++++--
 src/core/platform/node-launcher.ts          |  44 +++++++++++--
 src/core/platform/node-platform.ts          |  24 +++++--
 src/core/platform/path-rules.ts             |  12 +++-
 src/core/platform/private-files.ts          |   9 ++-
 src/core/platform/shells.ts                 |  11 +++-
 src/core/platform/startup-path.ts           |  14 +++-
 src/core/platform/types.ts                  |  15 ++++-
 src/core/platform/windows-command.ts        |  15 ++++-
 src/core/workspace/workspace.ts             |  13 +++-
 src/native-host/job-launcher.ts             |  15 ++++-
 src/native-host/native-host.ts              |  17 ++++-
 src/native-host/validation.ts               |  15 +++--
 src/native-host/windows-acl.ts              |  53 ++++++++++++---
 src/native-host/windows-job.ts              |  23 +++++--
 tests-e2e/browser/harness.ts                |  31 +++++++--
 tests-e2e/browser/real-browser.e2e.test.ts  | 531 ++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++------------------------------------------------------------------
 tests/adapters/http.test.ts                 |  73 ++++++++++++++++-----
 tests/adapters/mcp-browser.test.ts          |  38 +++++++++--
 tests/adapters/mcp.test.ts                  |  26 ++++++--
 tests/browser-bridge/integration.test.ts    |  88 ++++++++++++++++++++-----
 tests/browser-bridge/protocol.test.ts       |  63 ++++++++++++++----
 tests/browser-bridge/relay.test.ts          |  53 ++++++++++++---
 tests/browser-bridge/server.test.ts         |  24 +++++--
 tests/capabilities/browser.test.ts          | 111 ++++++++++++++++++++++++++-----
 tests/capabilities/filesystem.test.ts       |  75 ++++++++++++++++-----
 tests/capabilities/output-buffer.test.ts    |   7 +-
 tests/capabilities/process.test.ts          | 169 +++++++++++++++++++++++++++++++++++++----------
 tests/cli.test.ts                           |  34 ++++++++--
 tests/cli/browser-install.test.ts           |  89 ++++++++++++++++++++-----
 tests/cli/lifecycle.test.ts                 |  21 +++---
 tests/core/audit.test.ts                    |  34 ++++++++--
 tests/core/browser-core.test.ts             |  41 +++++++++---
 tests/core/config.test.ts                   |  20 ++++--
 tests/core/permissions.test.ts              |  24 +++++--
 tests/core/protected-paths.test.ts          |  42 +++++++++---
 tests/core/shutdown.test.ts                 |  15 ++++-
 tests/core/workspace.test.ts                |  13 +++-
 tests/helpers.ts                            |  12 +++-
 tests/native-host/native-host.test.ts       |  39 ++++++++---
 tests/native-host/validation.test.ts        |  57 ++++++++++++++--
 tests/native-host/windows-acl.test.ts       |   4 +-
 tests/native-host/windows-job.test.ts       |  24 +++++--
 tests/platform/directories.test.ts          |  25 ++++---
 tests/platform/encoding.test.ts             |   8 ++-
 tests/platform/node-platform.test.ts        |  10 ++-
 tests/platform/path-rules.test.ts           |  18 +++--
 tests/platform/private-files.test.ts        |  16 ++++-
 tests/platform/startup-path.test.ts         |  50 ++++++++++----
 tests/platform/windows-cmd-encoding.test.ts |  13 +++-
 tests/platform/windows-command.test.ts      |  28 ++++++--
 tests/stdio.test.ts                         |  24 +++++--
 91 files changed, 2763 insertions(+), 952 deletions(-)
```
- Commits exported: 2

## verify

### macos-latest-node20 (Node v20.20.2, npm 10.8.2, commit 6cf3037)

- `npm ci`: exit 0 (4 s)
- `npm run lint`: exit 1 (4 s)

```

> crot@0.1.0 lint
> eslint .


/Users/runner/work/crot-mcp/crot-mcp/extension/src/errors.ts
  46:14  error  Unexpected control character(s) in regular expression: \x00, \x1f  no-control-regex

/Users/runner/work/crot-mcp/crot-mcp/extension/test/fake-chrome.ts
  161:11  error  Unexpected aliasing of 'this' to local variable  @typescript-eslint/no-this-alias

/Users/runner/work/crot-mcp/crot-mcp/src/browser-bridge/server.ts
  461:14  error  Unexpected control character(s) in regular expression: \x00, \x1f  no-control-regex

/Users/runner/work/crot-mcp/crot-mcp/src/cli/browser-install.ts
  130:17  error  Unexpected control character(s) in regular expression: \x00, \x1f  no-control-regex

/Users/runner/work/crot-mcp/crot-mcp/src/core/capabilities/browser/service.ts
  362:14  error  Unexpected control character(s) in regular expression: \x00, \x1f  no-control-regex

/Users/runner/work/crot-mcp/crot-mcp/src/core/platform/path-rules.ts
  8:27  error  Unexpected control character(s) in regular expression: \x00, \x1f  no-control-regex

/Users/runner/work/crot-mcp/crot-mcp/src/native-host/validation.ts
  40:7  error  Unexpected control character(s) in regular expression: \x00, \x1f  no-control-regex

/Users/runner/work/crot-mcp/crot-mcp/tests/browser-bridge/integration.test.ts
  61:13  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any

/Users/runner/work/crot-mcp/crot-mcp/tests/browser-bridge/server.test.ts
  233:12  error  Unexpected control character(s) in regular expression: \x00, \x1f  no-control-regex

/Users/runner/work/crot-mcp/crot-mcp/tests/capabilities/browser.test.ts
  386:39  error  Unexpected control character(s) in regular expression: \x00, \x1f  no-control-regex

/Users/runner/work/crot-mcp/crot-mcp/tests/platform/windows-command.test.ts
  119:64  error  Unnecessary escape character: \"  no-useless-escape
  119:67  error  Unnecessary escape character: \"  no-useless-escape

✖ 12 problems (12 errors, 0 warnings)

```

- `npm run format:check`: exit 0 (3 s)
- `npm run typecheck`: exit 0 (4 s)
- `npm run typecheck:extension`: exit 0 (2 s)
- `npm run build`: exit 0 (3 s)
- `npm run build:extension`: exit 0 (2 s)
- `npm test`: exit 0 (22 s)
- `npm run test:extension`: exit 0 (2 s)
- `npm run check`: exit 1 (4 s)

```

> crot@0.1.0 check
> npm run lint && npm run format:check && npm run typecheck && npm run typecheck:extension && npm run build && npm run build:extension && npm test && npm run test:extension


> crot@0.1.0 lint
> eslint .


/Users/runner/work/crot-mcp/crot-mcp/extension/src/errors.ts
  46:14  error  Unexpected control character(s) in regular expression: \x00, \x1f  no-control-regex

/Users/runner/work/crot-mcp/crot-mcp/extension/test/fake-chrome.ts
  161:11  error  Unexpected aliasing of 'this' to local variable  @typescript-eslint/no-this-alias

/Users/runner/work/crot-mcp/crot-mcp/src/browser-bridge/server.ts
  461:14  error  Unexpected control character(s) in regular expression: \x00, \x1f  no-control-regex

/Users/runner/work/crot-mcp/crot-mcp/src/cli/browser-install.ts
  130:17  error  Unexpected control character(s) in regular expression: \x00, \x1f  no-control-regex

/Users/runner/work/crot-mcp/crot-mcp/src/core/capabilities/browser/service.ts
  362:14  error  Unexpected control character(s) in regular expression: \x00, \x1f  no-control-regex

/Users/runner/work/crot-mcp/crot-mcp/src/core/platform/path-rules.ts
  8:27  error  Unexpected control character(s) in regular expression: \x00, \x1f  no-control-regex

/Users/runner/work/crot-mcp/crot-mcp/src/native-host/validation.ts
  40:7  error  Unexpected control character(s) in regular expression: \x00, \x1f  no-control-regex

/Users/runner/work/crot-mcp/crot-mcp/tests/browser-bridge/integration.test.ts
  61:13  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any

/Users/runner/work/crot-mcp/crot-mcp/tests/browser-bridge/server.test.ts
  233:12  error  Unexpected control character(s) in regular expression: \x00, \x1f  no-control-regex

/Users/runner/work/crot-mcp/crot-mcp/tests/capabilities/browser.test.ts
  386:39  error  Unexpected control character(s) in regular expression: \x00, \x1f  no-control-regex

/Users/runner/work/crot-mcp/crot-mcp/tests/platform/windows-command.test.ts
  119:64  error  Unnecessary escape character: \"  no-useless-escape
  119:67  error  Unnecessary escape character: \"  no-useless-escape

✖ 12 problems (12 errors, 0 warnings)

```

- working tree clean after checks

### macos-latest-node22 (Node v22.23.2, npm 10.9.8, commit 6cf3037)

- `npm ci`: exit 0 (5 s)
- `npm run lint`: exit 1 (4 s)

```

> crot@0.1.0 lint
> eslint .


/Users/runner/work/crot-mcp/crot-mcp/extension/src/errors.ts
  46:14  error  Unexpected control character(s) in regular expression: \x00, \x1f  no-control-regex

/Users/runner/work/crot-mcp/crot-mcp/extension/test/fake-chrome.ts
  161:11  error  Unexpected aliasing of 'this' to local variable  @typescript-eslint/no-this-alias

/Users/runner/work/crot-mcp/crot-mcp/src/browser-bridge/server.ts
  461:14  error  Unexpected control character(s) in regular expression: \x00, \x1f  no-control-regex

/Users/runner/work/crot-mcp/crot-mcp/src/cli/browser-install.ts
  130:17  error  Unexpected control character(s) in regular expression: \x00, \x1f  no-control-regex

/Users/runner/work/crot-mcp/crot-mcp/src/core/capabilities/browser/service.ts
  362:14  error  Unexpected control character(s) in regular expression: \x00, \x1f  no-control-regex

/Users/runner/work/crot-mcp/crot-mcp/src/core/platform/path-rules.ts
  8:27  error  Unexpected control character(s) in regular expression: \x00, \x1f  no-control-regex

/Users/runner/work/crot-mcp/crot-mcp/src/native-host/validation.ts
  40:7  error  Unexpected control character(s) in regular expression: \x00, \x1f  no-control-regex

/Users/runner/work/crot-mcp/crot-mcp/tests/browser-bridge/integration.test.ts
  61:13  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any

/Users/runner/work/crot-mcp/crot-mcp/tests/browser-bridge/server.test.ts
  233:12  error  Unexpected control character(s) in regular expression: \x00, \x1f  no-control-regex

/Users/runner/work/crot-mcp/crot-mcp/tests/capabilities/browser.test.ts
  386:39  error  Unexpected control character(s) in regular expression: \x00, \x1f  no-control-regex

/Users/runner/work/crot-mcp/crot-mcp/tests/platform/windows-command.test.ts
  119:64  error  Unnecessary escape character: \"  no-useless-escape
  119:67  error  Unnecessary escape character: \"  no-useless-escape

✖ 12 problems (12 errors, 0 warnings)

```

- `npm run format:check`: exit 0 (4 s)
- `npm run typecheck`: exit 0 (4 s)
- `npm run typecheck:extension`: exit 0 (2 s)
- `npm run build`: exit 0 (3 s)
- `npm run build:extension`: exit 0 (2 s)
- `npm test`: exit 0 (20 s)
- `npm run test:extension`: exit 0 (2 s)
- `npm run check`: exit 1 (4 s)

```

> crot@0.1.0 check
> npm run lint && npm run format:check && npm run typecheck && npm run typecheck:extension && npm run build && npm run build:extension && npm test && npm run test:extension


> crot@0.1.0 lint
> eslint .


/Users/runner/work/crot-mcp/crot-mcp/extension/src/errors.ts
  46:14  error  Unexpected control character(s) in regular expression: \x00, \x1f  no-control-regex

/Users/runner/work/crot-mcp/crot-mcp/extension/test/fake-chrome.ts
  161:11  error  Unexpected aliasing of 'this' to local variable  @typescript-eslint/no-this-alias

/Users/runner/work/crot-mcp/crot-mcp/src/browser-bridge/server.ts
  461:14  error  Unexpected control character(s) in regular expression: \x00, \x1f  no-control-regex

/Users/runner/work/crot-mcp/crot-mcp/src/cli/browser-install.ts
  130:17  error  Unexpected control character(s) in regular expression: \x00, \x1f  no-control-regex

/Users/runner/work/crot-mcp/crot-mcp/src/core/capabilities/browser/service.ts
  362:14  error  Unexpected control character(s) in regular expression: \x00, \x1f  no-control-regex

/Users/runner/work/crot-mcp/crot-mcp/src/core/platform/path-rules.ts
  8:27  error  Unexpected control character(s) in regular expression: \x00, \x1f  no-control-regex

/Users/runner/work/crot-mcp/crot-mcp/src/native-host/validation.ts
  40:7  error  Unexpected control character(s) in regular expression: \x00, \x1f  no-control-regex

/Users/runner/work/crot-mcp/crot-mcp/tests/browser-bridge/integration.test.ts
  61:13  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any

/Users/runner/work/crot-mcp/crot-mcp/tests/browser-bridge/server.test.ts
  233:12  error  Unexpected control character(s) in regular expression: \x00, \x1f  no-control-regex

/Users/runner/work/crot-mcp/crot-mcp/tests/capabilities/browser.test.ts
  386:39  error  Unexpected control character(s) in regular expression: \x00, \x1f  no-control-regex

/Users/runner/work/crot-mcp/crot-mcp/tests/platform/windows-command.test.ts
  119:64  error  Unnecessary escape character: \"  no-useless-escape
  119:67  error  Unnecessary escape character: \"  no-useless-escape

✖ 12 problems (12 errors, 0 warnings)

```

- working tree clean after checks

### ubuntu-latest-node20 (Node v20.20.2, npm 10.8.2, commit 6cf3037)

- `npm ci`: exit 0 (4 s)
- `npm run lint`: exit 1 (4 s)

```

> crot@0.1.0 lint
> eslint .


/home/runner/work/crot-mcp/crot-mcp/extension/src/errors.ts
  46:14  error  Unexpected control character(s) in regular expression: \x00, \x1f  no-control-regex

/home/runner/work/crot-mcp/crot-mcp/extension/test/fake-chrome.ts
  161:11  error  Unexpected aliasing of 'this' to local variable  @typescript-eslint/no-this-alias

/home/runner/work/crot-mcp/crot-mcp/src/browser-bridge/server.ts
  461:14  error  Unexpected control character(s) in regular expression: \x00, \x1f  no-control-regex

/home/runner/work/crot-mcp/crot-mcp/src/cli/browser-install.ts
  130:17  error  Unexpected control character(s) in regular expression: \x00, \x1f  no-control-regex

/home/runner/work/crot-mcp/crot-mcp/src/core/capabilities/browser/service.ts
  362:14  error  Unexpected control character(s) in regular expression: \x00, \x1f  no-control-regex

/home/runner/work/crot-mcp/crot-mcp/src/core/platform/path-rules.ts
  8:27  error  Unexpected control character(s) in regular expression: \x00, \x1f  no-control-regex

/home/runner/work/crot-mcp/crot-mcp/src/native-host/validation.ts
  40:7  error  Unexpected control character(s) in regular expression: \x00, \x1f  no-control-regex

/home/runner/work/crot-mcp/crot-mcp/tests/browser-bridge/integration.test.ts
  61:13  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any

/home/runner/work/crot-mcp/crot-mcp/tests/browser-bridge/server.test.ts
  233:12  error  Unexpected control character(s) in regular expression: \x00, \x1f  no-control-regex

/home/runner/work/crot-mcp/crot-mcp/tests/capabilities/browser.test.ts
  386:39  error  Unexpected control character(s) in regular expression: \x00, \x1f  no-control-regex

/home/runner/work/crot-mcp/crot-mcp/tests/platform/windows-command.test.ts
  119:64  error  Unnecessary escape character: \"  no-useless-escape
  119:67  error  Unnecessary escape character: \"  no-useless-escape

✖ 12 problems (12 errors, 0 warnings)

```

- `npm run format:check`: exit 0 (5 s)
- `npm run typecheck`: exit 0 (6 s)
- `npm run typecheck:extension`: exit 0 (3 s)
- `npm run build`: exit 0 (4 s)
- `npm run build:extension`: exit 0 (2 s)
- `npm test`: exit 0 (38 s)
- `npm run test:extension`: exit 0 (3 s)
- `npm run check`: exit 1 (4 s)

```

> crot@0.1.0 check
> npm run lint && npm run format:check && npm run typecheck && npm run typecheck:extension && npm run build && npm run build:extension && npm test && npm run test:extension


> crot@0.1.0 lint
> eslint .


/home/runner/work/crot-mcp/crot-mcp/extension/src/errors.ts
  46:14  error  Unexpected control character(s) in regular expression: \x00, \x1f  no-control-regex

/home/runner/work/crot-mcp/crot-mcp/extension/test/fake-chrome.ts
  161:11  error  Unexpected aliasing of 'this' to local variable  @typescript-eslint/no-this-alias

/home/runner/work/crot-mcp/crot-mcp/src/browser-bridge/server.ts
  461:14  error  Unexpected control character(s) in regular expression: \x00, \x1f  no-control-regex

/home/runner/work/crot-mcp/crot-mcp/src/cli/browser-install.ts
  130:17  error  Unexpected control character(s) in regular expression: \x00, \x1f  no-control-regex

/home/runner/work/crot-mcp/crot-mcp/src/core/capabilities/browser/service.ts
  362:14  error  Unexpected control character(s) in regular expression: \x00, \x1f  no-control-regex

/home/runner/work/crot-mcp/crot-mcp/src/core/platform/path-rules.ts
  8:27  error  Unexpected control character(s) in regular expression: \x00, \x1f  no-control-regex

/home/runner/work/crot-mcp/crot-mcp/src/native-host/validation.ts
  40:7  error  Unexpected control character(s) in regular expression: \x00, \x1f  no-control-regex

/home/runner/work/crot-mcp/crot-mcp/tests/browser-bridge/integration.test.ts
  61:13  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any

/home/runner/work/crot-mcp/crot-mcp/tests/browser-bridge/server.test.ts
  233:12  error  Unexpected control character(s) in regular expression: \x00, \x1f  no-control-regex

/home/runner/work/crot-mcp/crot-mcp/tests/capabilities/browser.test.ts
  386:39  error  Unexpected control character(s) in regular expression: \x00, \x1f  no-control-regex

/home/runner/work/crot-mcp/crot-mcp/tests/platform/windows-command.test.ts
  119:64  error  Unnecessary escape character: \"  no-useless-escape
  119:67  error  Unnecessary escape character: \"  no-useless-escape

✖ 12 problems (12 errors, 0 warnings)

```

- `vitest list (default config) has no tests-e2e`: exit 0 (0 s)
- default vitest files: 37, of which tests-e2e: 0
- working tree clean after checks

### ubuntu-latest-node22 (Node v22.23.3, npm 10.9.9, commit 6cf3037)

- `npm ci`: exit 0 (5 s)
- `npm run lint`: exit 1 (7 s)

```

> crot@0.1.0 lint
> eslint .


/home/runner/work/crot-mcp/crot-mcp/extension/src/errors.ts
  46:14  error  Unexpected control character(s) in regular expression: \x00, \x1f  no-control-regex

/home/runner/work/crot-mcp/crot-mcp/extension/test/fake-chrome.ts
  161:11  error  Unexpected aliasing of 'this' to local variable  @typescript-eslint/no-this-alias

/home/runner/work/crot-mcp/crot-mcp/src/browser-bridge/server.ts
  461:14  error  Unexpected control character(s) in regular expression: \x00, \x1f  no-control-regex

/home/runner/work/crot-mcp/crot-mcp/src/cli/browser-install.ts
  130:17  error  Unexpected control character(s) in regular expression: \x00, \x1f  no-control-regex

/home/runner/work/crot-mcp/crot-mcp/src/core/capabilities/browser/service.ts
  362:14  error  Unexpected control character(s) in regular expression: \x00, \x1f  no-control-regex

/home/runner/work/crot-mcp/crot-mcp/src/core/platform/path-rules.ts
  8:27  error  Unexpected control character(s) in regular expression: \x00, \x1f  no-control-regex

/home/runner/work/crot-mcp/crot-mcp/src/native-host/validation.ts
  40:7  error  Unexpected control character(s) in regular expression: \x00, \x1f  no-control-regex

/home/runner/work/crot-mcp/crot-mcp/tests/browser-bridge/integration.test.ts
  61:13  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any

/home/runner/work/crot-mcp/crot-mcp/tests/browser-bridge/server.test.ts
  233:12  error  Unexpected control character(s) in regular expression: \x00, \x1f  no-control-regex

/home/runner/work/crot-mcp/crot-mcp/tests/capabilities/browser.test.ts
  386:39  error  Unexpected control character(s) in regular expression: \x00, \x1f  no-control-regex

/home/runner/work/crot-mcp/crot-mcp/tests/platform/windows-command.test.ts
  119:64  error  Unnecessary escape character: \"  no-useless-escape
  119:67  error  Unnecessary escape character: \"  no-useless-escape

✖ 12 problems (12 errors, 0 warnings)

```

- `npm run format:check`: exit 0 (5 s)
- `npm run typecheck`: exit 0 (6 s)
- `npm run typecheck:extension`: exit 0 (3 s)
- `npm run build`: exit 0 (4 s)
- `npm run build:extension`: exit 0 (2 s)
- `npm test`: exit 0 (43 s)
- `npm run test:extension`: exit 0 (3 s)
- `npm run check`: exit 1 (4 s)

```

> crot@0.1.0 check
> npm run lint && npm run format:check && npm run typecheck && npm run typecheck:extension && npm run build && npm run build:extension && npm test && npm run test:extension


> crot@0.1.0 lint
> eslint .


/home/runner/work/crot-mcp/crot-mcp/extension/src/errors.ts
  46:14  error  Unexpected control character(s) in regular expression: \x00, \x1f  no-control-regex

/home/runner/work/crot-mcp/crot-mcp/extension/test/fake-chrome.ts
  161:11  error  Unexpected aliasing of 'this' to local variable  @typescript-eslint/no-this-alias

/home/runner/work/crot-mcp/crot-mcp/src/browser-bridge/server.ts
  461:14  error  Unexpected control character(s) in regular expression: \x00, \x1f  no-control-regex

/home/runner/work/crot-mcp/crot-mcp/src/cli/browser-install.ts
  130:17  error  Unexpected control character(s) in regular expression: \x00, \x1f  no-control-regex

/home/runner/work/crot-mcp/crot-mcp/src/core/capabilities/browser/service.ts
  362:14  error  Unexpected control character(s) in regular expression: \x00, \x1f  no-control-regex

/home/runner/work/crot-mcp/crot-mcp/src/core/platform/path-rules.ts
  8:27  error  Unexpected control character(s) in regular expression: \x00, \x1f  no-control-regex

/home/runner/work/crot-mcp/crot-mcp/src/native-host/validation.ts
  40:7  error  Unexpected control character(s) in regular expression: \x00, \x1f  no-control-regex

/home/runner/work/crot-mcp/crot-mcp/tests/browser-bridge/integration.test.ts
  61:13  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any

/home/runner/work/crot-mcp/crot-mcp/tests/browser-bridge/server.test.ts
  233:12  error  Unexpected control character(s) in regular expression: \x00, \x1f  no-control-regex

/home/runner/work/crot-mcp/crot-mcp/tests/capabilities/browser.test.ts
  386:39  error  Unexpected control character(s) in regular expression: \x00, \x1f  no-control-regex

/home/runner/work/crot-mcp/crot-mcp/tests/platform/windows-command.test.ts
  119:64  error  Unnecessary escape character: \"  no-useless-escape
  119:67  error  Unnecessary escape character: \"  no-useless-escape

✖ 12 problems (12 errors, 0 warnings)

```

- `vitest list (default config) has no tests-e2e`: exit 0 (1 s)
- default vitest files: 37, of which tests-e2e: 0
- working tree clean after checks

### windows-latest-node20 (Node v20.20.2, npm 10.8.2, commit 6cf3037)

- `npm ci`: exit 0 (14 s)
- `npm run lint`: exit 1 (6 s)

```

> crot@0.1.0 lint
> eslint .


D:\a\crot-mcp\crot-mcp\extension\src\errors.ts
  46:14  error  Unexpected control character(s) in regular expression: \x00, \x1f  no-control-regex

D:\a\crot-mcp\crot-mcp\extension\test\fake-chrome.ts
  161:11  error  Unexpected aliasing of 'this' to local variable  @typescript-eslint/no-this-alias

D:\a\crot-mcp\crot-mcp\src\browser-bridge\server.ts
  461:14  error  Unexpected control character(s) in regular expression: \x00, \x1f  no-control-regex

D:\a\crot-mcp\crot-mcp\src\cli\browser-install.ts
  130:17  error  Unexpected control character(s) in regular expression: \x00, \x1f  no-control-regex

D:\a\crot-mcp\crot-mcp\src\core\capabilities\browser\service.ts
  362:14  error  Unexpected control character(s) in regular expression: \x00, \x1f  no-control-regex

D:\a\crot-mcp\crot-mcp\src\core\platform\path-rules.ts
  8:27  error  Unexpected control character(s) in regular expression: \x00, \x1f  no-control-regex

D:\a\crot-mcp\crot-mcp\src\native-host\validation.ts
  40:7  error  Unexpected control character(s) in regular expression: \x00, \x1f  no-control-regex

D:\a\crot-mcp\crot-mcp\tests\browser-bridge\integration.test.ts
  61:13  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any

D:\a\crot-mcp\crot-mcp\tests\browser-bridge\server.test.ts
  233:12  error  Unexpected control character(s) in regular expression: \x00, \x1f  no-control-regex

D:\a\crot-mcp\crot-mcp\tests\capabilities\browser.test.ts
  386:39  error  Unexpected control character(s) in regular expression: \x00, \x1f  no-control-regex

D:\a\crot-mcp\crot-mcp\tests\platform\windows-command.test.ts
  119:64  error  Unnecessary escape character: \"  no-useless-escape
  119:67  error  Unnecessary escape character: \"  no-useless-escape

✖ 12 problems (12 errors, 0 warnings)

```

- `npm run format:check`: exit 0 (6 s)
- `npm run typecheck`: exit 0 (9 s)
- `npm run typecheck:extension`: exit 0 (4 s)
- `npm run build`: exit 0 (6 s)
- `npm run build:extension`: exit 0 (3 s)
- `npm test`: exit 0 (118 s)
- `npm run test:extension`: exit 0 (4 s)
- `npm run check`: exit 1 (6 s)

```

> crot@0.1.0 check
> npm run lint && npm run format:check && npm run typecheck && npm run typecheck:extension && npm run build && npm run build:extension && npm test && npm run test:extension


> crot@0.1.0 lint
> eslint .


D:\a\crot-mcp\crot-mcp\extension\src\errors.ts
  46:14  error  Unexpected control character(s) in regular expression: \x00, \x1f  no-control-regex

D:\a\crot-mcp\crot-mcp\extension\test\fake-chrome.ts
  161:11  error  Unexpected aliasing of 'this' to local variable  @typescript-eslint/no-this-alias

D:\a\crot-mcp\crot-mcp\src\browser-bridge\server.ts
  461:14  error  Unexpected control character(s) in regular expression: \x00, \x1f  no-control-regex

D:\a\crot-mcp\crot-mcp\src\cli\browser-install.ts
  130:17  error  Unexpected control character(s) in regular expression: \x00, \x1f  no-control-regex

D:\a\crot-mcp\crot-mcp\src\core\capabilities\browser\service.ts
  362:14  error  Unexpected control character(s) in regular expression: \x00, \x1f  no-control-regex

D:\a\crot-mcp\crot-mcp\src\core\platform\path-rules.ts
  8:27  error  Unexpected control character(s) in regular expression: \x00, \x1f  no-control-regex

D:\a\crot-mcp\crot-mcp\src\native-host\validation.ts
  40:7  error  Unexpected control character(s) in regular expression: \x00, \x1f  no-control-regex

D:\a\crot-mcp\crot-mcp\tests\browser-bridge\integration.test.ts
  61:13  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any

D:\a\crot-mcp\crot-mcp\tests\browser-bridge\server.test.ts
  233:12  error  Unexpected control character(s) in regular expression: \x00, \x1f  no-control-regex

D:\a\crot-mcp\crot-mcp\tests\capabilities\browser.test.ts
  386:39  error  Unexpected control character(s) in regular expression: \x00, \x1f  no-control-regex

D:\a\crot-mcp\crot-mcp\tests\platform\windows-command.test.ts
  119:64  error  Unnecessary escape character: \"  no-useless-escape
  119:67  error  Unnecessary escape character: \"  no-useless-escape

✖ 12 problems (12 errors, 0 warnings)

```

- working tree clean after checks

### windows-latest-node22 (Node v22.23.3, npm 10.9.9, commit 6cf3037)

- `npm ci`: exit 0 (14 s)
- `npm run lint`: exit 1 (10 s)

```

> crot@0.1.0 lint
> eslint .


D:\a\crot-mcp\crot-mcp\extension\src\errors.ts
  46:14  error  Unexpected control character(s) in regular expression: \x00, \x1f  no-control-regex

D:\a\crot-mcp\crot-mcp\extension\test\fake-chrome.ts
  161:11  error  Unexpected aliasing of 'this' to local variable  @typescript-eslint/no-this-alias

D:\a\crot-mcp\crot-mcp\src\browser-bridge\server.ts
  461:14  error  Unexpected control character(s) in regular expression: \x00, \x1f  no-control-regex

D:\a\crot-mcp\crot-mcp\src\cli\browser-install.ts
  130:17  error  Unexpected control character(s) in regular expression: \x00, \x1f  no-control-regex

D:\a\crot-mcp\crot-mcp\src\core\capabilities\browser\service.ts
  362:14  error  Unexpected control character(s) in regular expression: \x00, \x1f  no-control-regex

D:\a\crot-mcp\crot-mcp\src\core\platform\path-rules.ts
  8:27  error  Unexpected control character(s) in regular expression: \x00, \x1f  no-control-regex

D:\a\crot-mcp\crot-mcp\src\native-host\validation.ts
  40:7  error  Unexpected control character(s) in regular expression: \x00, \x1f  no-control-regex

D:\a\crot-mcp\crot-mcp\tests\browser-bridge\integration.test.ts
  61:13  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any

D:\a\crot-mcp\crot-mcp\tests\browser-bridge\server.test.ts
  233:12  error  Unexpected control character(s) in regular expression: \x00, \x1f  no-control-regex

D:\a\crot-mcp\crot-mcp\tests\capabilities\browser.test.ts
  386:39  error  Unexpected control character(s) in regular expression: \x00, \x1f  no-control-regex

D:\a\crot-mcp\crot-mcp\tests\platform\windows-command.test.ts
  119:64  error  Unnecessary escape character: \"  no-useless-escape
  119:67  error  Unnecessary escape character: \"  no-useless-escape

✖ 12 problems (12 errors, 0 warnings)

```

- `npm run format:check`: exit 0 (7 s)
- `npm run typecheck`: exit 0 (7 s)
- `npm run typecheck:extension`: exit 0 (4 s)
- `npm run build`: exit 0 (6 s)
- `npm run build:extension`: exit 0 (3 s)
- `npm test`: exit 0 (114 s)
- `npm run test:extension`: exit 0 (4 s)
- `npm run check`: exit 1 (6 s)

```

> crot@0.1.0 check
> npm run lint && npm run format:check && npm run typecheck && npm run typecheck:extension && npm run build && npm run build:extension && npm test && npm run test:extension


> crot@0.1.0 lint
> eslint .


D:\a\crot-mcp\crot-mcp\extension\src\errors.ts
  46:14  error  Unexpected control character(s) in regular expression: \x00, \x1f  no-control-regex

D:\a\crot-mcp\crot-mcp\extension\test\fake-chrome.ts
  161:11  error  Unexpected aliasing of 'this' to local variable  @typescript-eslint/no-this-alias

D:\a\crot-mcp\crot-mcp\src\browser-bridge\server.ts
  461:14  error  Unexpected control character(s) in regular expression: \x00, \x1f  no-control-regex

D:\a\crot-mcp\crot-mcp\src\cli\browser-install.ts
  130:17  error  Unexpected control character(s) in regular expression: \x00, \x1f  no-control-regex

D:\a\crot-mcp\crot-mcp\src\core\capabilities\browser\service.ts
  362:14  error  Unexpected control character(s) in regular expression: \x00, \x1f  no-control-regex

D:\a\crot-mcp\crot-mcp\src\core\platform\path-rules.ts
  8:27  error  Unexpected control character(s) in regular expression: \x00, \x1f  no-control-regex

D:\a\crot-mcp\crot-mcp\src\native-host\validation.ts
  40:7  error  Unexpected control character(s) in regular expression: \x00, \x1f  no-control-regex

D:\a\crot-mcp\crot-mcp\tests\browser-bridge\integration.test.ts
  61:13  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any

D:\a\crot-mcp\crot-mcp\tests\browser-bridge\server.test.ts
  233:12  error  Unexpected control character(s) in regular expression: \x00, \x1f  no-control-regex

D:\a\crot-mcp\crot-mcp\tests\capabilities\browser.test.ts
  386:39  error  Unexpected control character(s) in regular expression: \x00, \x1f  no-control-regex

D:\a\crot-mcp\crot-mcp\tests\platform\windows-command.test.ts
  119:64  error  Unnecessary escape character: \"  no-useless-escape
  119:67  error  Unnecessary escape character: \"  no-useless-escape

✖ 12 problems (12 errors, 0 warnings)

```

- working tree clean after checks

