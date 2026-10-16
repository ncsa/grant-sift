# Grant Sift in Claude: setup

You need an NCSA account. Writes made through Claude, such as feedback, are recorded under your username.

## Claude Code

```bash
claude mcp add -s user --transport http grant-sift https://grant-sift.software-dev.ncsa.illinois.edu/mcp --client-id grant-sift-mcp --callback-port 33418
```

Open a new session, run `/mcp`, choose **grant-sift → Authenticate**, and sign in with NCSA SSO.

## Claude Desktop chat

Requires Node.js (`npx`). Add this under `mcpServers` in `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
"grant-sift": {
  "command": "npx",
  "args": ["-y", "mcp-remote",
           "https://grant-sift.software-dev.ncsa.illinois.edu/mcp", "33418",
           "--callback-path", "/callback",
           "--transport", "http-only",
           "--static-oauth-client-info", "{\"client_id\": \"grant-sift-mcp\"}"]
}
```

Quit Claude Desktop (Cmd+Q) and reopen it. Sign in when the browser opens.

## Check

Ask: *"who am I to grant sift?"* It should answer with your NetID.

If something fails: don't run both sign-ins at once, because they share port 33418. Otherwise, send the error to the Grant Sift maintainers.
