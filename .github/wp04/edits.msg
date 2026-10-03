chore(lint): minimal fixes for the new lint rules; document the check gate

- extension/test/fake-chrome.ts, tests/browser-bridge/integration.test.ts:
  justified eslint-disable-next-line comments (no-this-alias in a test fake,
  no-explicit-any for untyped tool result bodies in a test helper).
- tests/platform/windows-command.test.ts: drop unnecessary \" escapes in a
  template literal (same string value).
- README: lint/format scripts, the npm run check gate, the separate
  real-browser E2E and the CI steps.

No production code changes.
