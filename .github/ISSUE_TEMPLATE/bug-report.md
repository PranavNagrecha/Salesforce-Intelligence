---
name: Bug report
about: A wrong answer, an error, or a command that did not do what the docs say
title: "bug: <what went wrong, in one line>"
labels: bug
---

**What you asked or ran**
<!-- The question you typed in your AI assistant, or the `sfi` command. If a question, say which host (Claude Code, Claude Desktop, Cursor, VS Code + Copilot, Codex). -->

**What came back**
<!-- The answer or error, trimmed. Replace real object, field, class and org names with placeholders such as `Demo_Object__c` before pasting. Never paste org ids, usernames or record data. -->

**What you expected**

**Version and environment**
<!-- `sfi --version`, `node --version`, operating system. `sfi doctor` output is useful; scrub names from it too. -->

**If a reference is missing from an answer**
<!-- "Field X is used in Y, but the answer does not list Y": that is usually an extractor gap. Use the "Extractor gap" template instead; it has the fields a fix needs. -->

**Checklist**
- [ ] No real org, object, field, class, profile or user names in this issue
- [ ] Reproduced on the latest release (`npx -y sf-intelligence@latest --version`)
