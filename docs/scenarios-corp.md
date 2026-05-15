# Daily Scenarios — Microsoft WEX Engineer

Food for thought for designing a personal AI agent system. The target user is a corp dev on the WEX team, working on Office/OneDrive-adjacent products (repos like `odsp-web`, `augloop`) inside Microsoft's Azure DevOps ecosystem. Each scenario below is a recognizable slice of a typical workday — from the first PR notification at 8:47 AM to the last commit before logoff. The "AI opportunity" column is deliberately concrete: what kind of agent, which tool surface, which manual step disappears. Use these as design fixtures when deciding which Hive agents to build first, which MCP integrations matter, and which workflows are worth automating end-to-end versus leaving to a human-in-the-loop assistant.

---

### S01 — Morning ADO Triage
**Trigger:** First laptop open of the day; overnight activity has piled up in ADO across assigned work items, PR review requests, and `@mention` comments.
**Today (manual):** Engineer opens ADO dashboard, scans My Work Items, switches tabs to Pull Requests, opens each notification email from Outlook to figure out which threads still need a reply, mentally sorts by urgency.
**AI opportunity:** A triage agent that pulls from ADO REST + Outlook + Teams, dedupes notifications, ranks by blocker-status (someone waiting on you vs FYI), and produces a single ranked "do this first" list with one-click jumps. Drops Epics, demotes bot noise, surfaces stalled threads >24h old.
**Frequency:** daily

### S02 — PR Review Assigned to You
**Trigger:** ADO emails "X added you as a required reviewer" on a 600-line PR in `odsp-web`.
**Today (manual):** Engineer clones the branch or browses files in ADO web, mentally maps the diff against the file structure, reads commit messages, leaves inline comments. Often skims and rubber-stamps when the diff is too large.
**AI opportunity:** A reviewer agent that fetches the diff via ADO API, runs it against repo-aware static rules (KillSwitch usage, telemetry coverage, accessibility lint), produces a draft review with concrete inline suggestions, and flags risky changes for human attention. Posts as a draft; human approves and submits.
**Frequency:** daily

### S03 — Addressing PR Comments on Your Own PR
**Trigger:** Reviewer left 14 comments on your PR overnight, some nits, some "this needs a redesign."
**Today (manual):** Engineer reads each comment, mentally categorizes (nit / valid / disagree), edits files, replies inline, pushes a new iteration, marks threads resolved one by one.
**AI opportunity:** An author agent that ingests the comment thread, classifies each (style / logic / question / blocker), drafts code edits for the trivial ones, drafts replies for the disagreements, leaves the architectural ones for the human. Pushes a single squashed iteration with a summary of which comments were addressed and how.
**Frequency:** daily

### S04 — Standup Prep
**Trigger:** 9:30 AM daily standup in 10 minutes.
**Today (manual):** Engineer scrambles to remember what they did yesterday by scrolling git log, checks if today's plan still holds given overnight blockers, hopes nobody asks for specifics.
**AI opportunity:** A standup agent that reads yesterday's commits, closed work items, and PR activity from ADO, plus today's calendar and assigned items, and produces a three-bullet "yesterday / today / blockers" draft 15 minutes before the meeting. Surfaces real blockers (stalled review, failing CI, dependency on another team).
**Frequency:** daily

### S05 — Coding a Work Item
**Trigger:** Engineer picks an ADO work item, reads the description, opens the repo.
**Today (manual):** Engineer searches the codebase for relevant files, reads ADRs and design docs from SharePoint, writes the code, runs tests locally, iterates. KillSwitch wrap-up often forgotten until reviewer asks.
**AI opportunity:** A coding agent (Cursor / Claude Code style) primed with the work item context, repo conventions from `CLAUDE.md` / `guidance/`, KillSwitch patterns, and telemetry requirements. Drafts the change, runs `npm test`, ensures the KillSwitch is wired correctly. Human reviews the final diff before commit.
**Frequency:** daily

### S06 — Creating an ADO Pull Request
**Trigger:** Code is ready, tests pass, time to ship.
**Today (manual):** Engineer runs `az repos pr create`, fills in title and description manually, pastes the work item ID, picks reviewers from memory, adds the right area path tag, attaches screenshots if it's a UI change.
**AI opportunity:** A PR-creation agent (already partially exists as `/atomic:create-ado-pr`) that auto-generates title and description from the commit history, links the work item, infers reviewers from `CODEOWNERS` and recent file history, attaches screenshots from a local screenshots folder, and applies the right policy tags. Human approves the draft, agent submits.
**Frequency:** daily

### S07 — Teams DM Backlog
**Trigger:** 23 unread Teams DMs, some from PMs, some from partner teams, some from your manager.
**Today (manual):** Engineer reads each, mentally categorizes (FYI / needs reply today / needs action), often forgets to reply to the ones that need action by EOD.
**AI opportunity:** A comms agent with Teams Graph API access that summarizes unread DMs into "needs reply" / "FYI" / "action item," drafts replies for the simple ones, surfaces threads that have been waiting >24h. Optionally posts the agent-drafted reply for human approval before sending.
**Frequency:** daily

### S08 — Teams Channel Catchup
**Trigger:** Engineer opens the team channel, sees 80 messages since yesterday EOD.
**Today (manual):** Engineer skims, looks for `@team` mentions, gives up on the rest.
**AI opportunity:** A channel-digest agent that produces a paragraph summary of "decisions made," "questions still open," "links shared worth saving," and "items requiring your input." Runs at 9 AM and 1 PM.
**Frequency:** daily

### S09 — Outlook Triage
**Trigger:** 60+ emails overnight, mostly auto-generated (ADO, IcM, Geneva alerts, Kusto subscriptions, internal newsletters).
**Today (manual):** Engineer mass-deletes bot noise, replies to the human ones, often misses the one genuinely urgent thread.
**AI opportunity:** A mail agent (the `gus-mail` MCP integration is already a starting point) that classifies by source, archives bot noise after extracting any actionable signals, surfaces human-authored emails needing reply, and drafts responses for routine ones. Respects the `WA_MAIL_ALLOW_SEND` and `WA_MAIL_ALLOWED_RECIPIENTS` policy.
**Frequency:** daily

### S10 — Meeting Note-Taking and Follow-Ups
**Trigger:** A 30-minute design review on Teams ends.
**Today (manual):** Engineer scribbled notes in OneNote, tries to remember the three action items assigned to them, never sends the follow-up summary they promised.
**AI opportunity:** A meeting agent that consumes the Teams transcript, produces structured notes (decisions, action items with owners, open questions), files action items as ADO tasks assigned to the right person, drafts the follow-up Teams message. Human approves before send.
**Frequency:** daily

### S11 — Reading a Spec or ADR
**Trigger:** A new feature lands on the team's roadmap; PM shares a 12-page spec in SharePoint.
**Today (manual):** Engineer skims, misses the section that affects their component, gets surprised in next week's planning.
**AI opportunity:** A reading agent that ingests the SharePoint doc, summarizes per-component impact, flags sections relevant to the engineer's owned files based on `CODEOWNERS`, drafts clarifying questions to send to the PM.
**Frequency:** weekly

### S12 — Debugging a Live Incident
**Trigger:** IcM ticket pages at 2 PM: "OneDrive web latency spike, ICM 12345678."
**Today (manual):** Engineer opens Geneva to look at metrics, jumps to Kusto to query logs, correlates with recent deployments, tries to find the offending commit.
**AI opportunity:** An incident agent with Geneva + Kusto + ADO release pipeline access that, given an IcM ID, auto-correlates the timing with recent deployments, fetches the top error signatures from Kusto, identifies suspect PRs merged in the last 24h, and produces a "likely root cause" hypothesis with evidence.
**Frequency:** weekly

### S13 — Cross-Team Coordination Ask
**Trigger:** Engineer needs a fix from the Augloop team to unblock their `odsp-web` change.
**Today (manual):** Engineer asks in Teams, gets ignored, asks again, eventually finds the right person via org chart spelunking, opens an ADO work item in the other team's project.
**AI opportunity:** A coordination agent that, given "I need X from Augloop team," identifies the right owner via `CODEOWNERS` + Microsoft Graph org data, drafts a Teams message with full context (your repo, your blocker, your timeline, the specific function/file), files the cross-team work item with proper area path.
**Frequency:** weekly

### S14 — Onboarding to a New Repo or Feature Area
**Trigger:** Manager asks engineer to take on a feature in a repo they've never touched.
**Today (manual):** Engineer clones the repo, reads `README.md` (usually stale), greps for entry points, asks a teammate awkward questions in DMs.
**AI opportunity:** An onboarding agent that ingests the repo, identifies its architectural layers, surfaces the active ADRs and design docs, names the top-five files to read first, and produces a "build and run locally" checklist verified against actual scripts in `package.json`.
**Frequency:** monthly

### S15 — Cross-Repo Code Navigation
**Trigger:** Engineer needs to trace how a request flows from `odsp-web` through `augloop` to a backend service.
**Today (manual):** Engineer greps across multiple cloned repos, switches IDE windows, gets lost.
**AI opportunity:** A navigation agent with multi-repo index that, given an entry point, traces the call chain across repo boundaries, produces a sequence diagram, highlights the components owned by other teams.
**Frequency:** weekly

### S16 — Writing Documentation
**Trigger:** Engineer just shipped a feature; the wiki is stale.
**Today (manual):** Engineer puts it on the TODO list, never gets to it.
**AI opportunity:** A docs agent that reads the shipped diff, the work item description, and the PR discussion, drafts the wiki update or ADR, posts to SharePoint as a draft for human edit.
**Frequency:** weekly

### S17 — 1:1 Prep with Manager
**Trigger:** Weekly 1:1 in 1 hour.
**Today (manual):** Engineer opens the running 1:1 OneNote doc, tries to remember what they wanted to bring up, types two bullets in a rush.
**AI opportunity:** A 1:1 agent that pulls from the week's commits, PRs, completed work items, blockers logged in standup, and recent comms, drafts an agenda with "wins / blockers / questions / career topics" structure.
**Frequency:** weekly

### S18 — Connects / Perf Review Writing
**Trigger:** Quarterly Connect doc is due Friday.
**Today (manual):** Engineer stares at a blank Connect template, tries to remember everything they shipped in the last 4 months, drafts impact statements without metrics.
**AI opportunity:** A Connect agent that aggregates four months of ADO activity, PR descriptions, IcM contributions, mentorship moments from Teams, and produces draft impact bullets organized against the Microsoft model (individual / through others / leveraging others), each backed by linkable evidence.
**Frequency:** monthly

### S19 — Sprint Planning / Backlog Grooming
**Trigger:** Friday backlog grooming meeting.
**Today (manual):** Engineer scans the team's backlog cold, picks items that "sound interesting," has no view of dependencies or sizing.
**AI opportunity:** A grooming agent (already drafted in `guidance/groomer/`) that ranks backlog items by readiness (acceptance criteria present, dependencies resolved), suggests T-shirt sizing based on similar past items, flags duplicates and stale ones.
**Frequency:** weekly

### S20 — Retro Prep
**Trigger:** End of sprint, retro tomorrow.
**Today (manual):** Engineer thinks "what went wrong" for two minutes, jots one item.
**AI opportunity:** A retro agent that scans the sprint's PR cycle times, incident count, rolled-over work items, and Teams sentiment, produces draft "went well / didn't go well / try next" items with evidence.
**Frequency:** monthly

### S21 — Helpdesk: Someone Asks You How to Do Something
**Trigger:** A new hire DMs: "How do I get a GUID for an experiment?"
**Today (manual):** Engineer tells them about `odsp-generate-guid`, then types the same answer next week for someone else.
**AI opportunity:** A helpdesk agent (already drafted in `guidance/helpdesk/`) that owns FAQs for the team, answers in Teams with links to internal docs, captures new questions and proposes wiki updates when an answer is given more than twice.
**Frequency:** daily

### S22 — Build Break / CI Failure
**Trigger:** CI is red on main after your merge.
**Today (manual):** Engineer opens the pipeline, reads the log, reproduces locally, hopes it's not a flake.
**AI opportunity:** A build agent that watches pipelines, on red fetches the log, classifies (flake / your change / infra), if flake retries automatically, if your change drafts a revert PR for confirmation, if infra files an IcM.
**Frequency:** weekly

### S23 — End-of-Day Wrap
**Trigger:** 5:30 PM, time to log off.
**Today (manual):** Engineer commits WIP with `git commit -m "wip"`, closes laptop, forgets what they were doing by tomorrow morning.
**AI opportunity:** An EOD agent that reviews the day's git diff, drafts a real commit message for WIP, writes a "tomorrow morning, resume here" note pinned to the work item, surfaces any threads (PR comments, Teams DMs, emails) still waiting on a reply.
**Frequency:** daily

### S24 — Knowledge Capture from Slack/Teams Threads
**Trigger:** A great debugging thread happened in Teams; nobody will ever find it again.
**Today (manual):** Engineer thinks "I should write that up," doesn't.
**AI opportunity:** A capture agent that watches starred/reacted Teams messages, recognizes "useful debugging thread" or "decision made" patterns, drafts a wiki entry or ADR, files it under the right area for human review.
**Frequency:** weekly

### S25 — Calendar Defragmentation
**Trigger:** Tomorrow's calendar has six meetings with no coding time.
**Today (manual):** Engineer accepts everything, has no focus time, ships nothing.
**AI opportunity:** A calendar agent that scans the next 5 days, identifies low-value recurring meetings (no agenda, no your-name in notes), drafts decline-or-defer messages, blocks 2-hour focus chunks daily, defends them against new invites.
**Frequency:** weekly
