# Changelog

What changed in each version of totalrecall, for the people who use it. cmod publish releases the section for the version, and the Updated toast and Settings show it.

## [Unreleased]

## [0.2.1]

### Fixed
- Summaries start as soon as the program starts or an import lands. They no longer wait for the first recall turn after each restart.

## [0.2.0]

### Added
- `totalrecall import` brings your past Claude Code and Codex sessions into the chat, on each computer you run it on, and Claude.ai and ChatGPT exports too. It lists what it found and how many summaries that takes; add `go` to import. `since <day>` limits it to recent sessions, and `tools` brings tool calls too. Running it again adds only what is new, and a session total recall logged as it ran is left out. Turns never wait on an import's summaries.
- Claude reads an imported AI's replies and tool calls as `ai`, not as its own.
- `zoom` pages through a long message or a subagent's chat.
- A subagent reads a subagent's prompt: do what its task says, not what your last message says.

### Changed
- Summaries run 64 at once for the chat, and 64 more for an import, at high effort.
- A busy or unreachable pool only delays a summary: it is tried again until it goes through.
- The chat keeps an index beside its logs, so the program holds only what a turn reads and starts fast however long the chat grows. A chat from before builds its index at its first start.

### Fixed
- A message the model won't summarize gets its own text, cut to 512 bytes, as its summary, so turns never wait on it.
- A failed tool result is logged as an error.
- A subagent's report says how to open its whole chat.
- A log line a crash cut short is skipped, so the chat still starts.
- A long message is split where a line ends.
- A notice Claude Code adds without a task, such as a fork's, is never logged as your words.
- A summary the model stopped before its end is never kept.
- A session you imported logs only what follows when you turn recall on in it.
- While a large import's summaries catch up, turns read the live chat without it.

## [0.1.1]

### Changed
- A compaction in a session with total recall on costs no tokens. In place of Claude Code's summary, the session's history becomes the chat's view, so a session you turn recall off in still remembers the whole chat.

### Fixed
- A summary that failed is tried again as the next turn starts, so the turn never sits through its wait.
- A long tool output is logged as one message, its head and tail together.
- A restarted chat pays for each summary once.

## [0.1.0]

### Added
- `/recall` turns total recall on or off in a session. Every session it's on in, on every computer that shares your oneclaude pool, shares one chat that never ends.
- Claude reads the whole chat as summary lines, recent ones fine and old ones coarse, and opens any line with `zoom`. `date` gives a message's date and time. Both tools are always loaded, so Claude never searches for them first.
- Turning it on in a session that already has a history brings that history into the chat. The session works as before until that history is summarized.
- A subagent's report joins the chat as one message under the subagent's name, and `zoom` with that name opens the subagent's whole chat.
- Pictures and PDFs stay in the chat. Claude reads a summary of each, and `zoom` opens the picture itself.
- Each turn, and each step Claude took, names the computer and folder it ran in.
- The chat runs in the background on the computer your oneclaude pool runs on. Installing the mod starts it there, and removing the mod stops it.
- A long session with total recall on compacts its own history the usual way, so turning recall off leaves a normal session. If the chat doesn't answer, the session waits to compact, so nothing is lost.
