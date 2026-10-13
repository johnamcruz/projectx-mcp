# Running the flow recorder

`projectx-mcp --record-flow` records order flow for `PROJECTX_FLOW_SYMBOLS` into `PROJECTX_FLOW_DIR` and serves no MCP. It should run all the time the market is open, so run it as a service. It holds `recorder.lock` in the directory, so starting it twice is harmless: the second copy exits.

## macOS (launchd)

Save this as `~/Library/LaunchAgents/com.example.projectx-flow-recorder.plist`, replace every `/path/to/...` placeholder, then load it with `launchctl load ~/Library/LaunchAgents/com.example.projectx-flow-recorder.plist`.

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.example.projectx-flow-recorder</string>
  <key>ProgramArguments</key>
  <array>
    <string>/path/to/node</string>
    <string>/path/to/projectx-mcp/dist/index.js</string>
    <string>--record-flow</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <!-- Credentials and settings come from this .env file (keep it private). -->
    <key>PROJECTX_ENV_FILE</key>
    <string>/path/to/projectx-mcp/.env</string>
    <key>PROJECTX_FLOW_SYMBOLS</key>
    <string>MNQ,MES</string>
    <key>PROJECTX_FLOW_DIR</key>
    <string>/path/to/flow-directory</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <!-- Restart after a crash or an error exit (at most every 30 s), not after a clean exit (SIGTERM). -->
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>ThrottleInterval</key>
  <integer>30</integer>
  <key>StandardErrorPath</key>
  <string>/path/to/logs/projectx-flow-recorder.log</string>
</dict>
</plist>
```

Notes:

- The recorder logs to stderr only; stdout stays empty.
- `launchctl unload` sends SIGTERM: the recorder writes the minutes that are final, closes the hub connection and releases the lock.
- Put the credentials (`PROJECTX_USERNAME`, `PROJECTX_API_KEY`) in the `.env` file, not in the plist.
- MCP servers that should read the recording need the same `PROJECTX_FLOW_DIR`.
- `get_bars` with `includeOrderFlow` gives MNQ and MES bars the full-size contract's flow (NQ and ES, contract roots `ENQ` and `EP`), and reads that contract's recorded files. For recorded flow on MNQ and MES bars, add `ENQ` and `EP` to `PROJECTX_FLOW_SYMBOLS` (e.g. `MNQ,MES,ENQ,EP`; at most `PROJECTX_FLOW_MAX_CONTRACTS`, default 6).
- A minute is written once it settles: right after a trade arrives 2 s past its end, or 10 s after its end when none does (up to 20 s when prints arrive late). Expect rows to lag the clock by that much.
- A minute is written only if the quote feed's volume and last price agree with the prints, so a trade subscription that dies while quotes keep flowing writes nothing rather than zeros.
- Only complete minutes are written. Nothing is written while the market is closed, while the connection is down or silent for more than 10 s, or for the slept time if the machine sleeps; those minutes are simply missing from the files.
- If the machine crashes mid-write, the next start truncates the partial last line and goes on from the last complete row.
