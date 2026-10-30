# Changelog

What changed in each version of totalrecall, for the people who use it. cmod publish releases the section for the version, and the Updated toast and Settings show it.

## [Unreleased]

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
