# Personal-Life Productivity Scenarios

Food for thought for designing a personal AI agent system that travels with one person across jobs. Subject: a Microsoft engineer, technical, lives a regular adult life — side projects, learning, friends, finance, planning, hobbies, journaling. These scenarios are the slices of non-work life where an always-on assistant that *remembers you* actually saves time. They're deliberately specific: each one is a recognizable Tuesday-night or Saturday-morning moment, not a fantasy of total automation.

---

### P01 — Resurrecting a stalled side project
**Trigger:** Sunday afternoon, opens the laptop wanting to work on the home-server dashboard they last touched six weeks ago.
**Today (manual):** Re-reads their own commits, scrolls Discord for context, re-installs deps, tries to remember the "what's next" from a half-finished TODO comment. Burns 40 minutes before writing code.
**AI opportunity:** A project-memory agent that journals each session ("you left off mid-refactor of the auth middleware, tests were red on the OIDC branch, your stated next step was to add refresh-token rotation"). On open, it greets with a 60-second resume brief and the exact `git checkout` + dev-server command.
**Frequency:** Weekly (on the projects that survive); ad-hoc across the graveyard.

### P02 — Learning queue triage
**Trigger:** A friend DMs a link to a paper on speculative decoding. Already has 47 unread tabs, 12 saved papers in Zotero, 3 half-watched MIT lectures.
**Today (manual):** Bookmarks it, forgets it. Once a quarter has a guilt-driven cleanup session that mostly archives without reading.
**AI opportunity:** A learning curator that ingests saved links, deduplicates against what they've already read, tags by topic and depth (skim/read/study), and surfaces 1–2 items per evening matched to their stated current interests. Knows which papers they actually finished vs. abandoned and adjusts recommendation aggressiveness accordingly.
**Frequency:** Daily intake, weekly surfacing.

### P03 — Second-brain capture and retrieval
**Trigger:** In a 1:1 with a mentor, hears a sharp framing about career capital. Wants it later but won't remember where it came from.
**Today (manual):** Maybe scribbles in Obsidian. More often, it evaporates. When they later need it ("what was that thing about T-shaped engineers?") they grep their vault and find three contradictory versions.
**AI opportunity:** A capture agent fed by voice memos, screenshots, and highlights, that normalizes notes into atomic claims with provenance (who said it, when, in what context). Retrieval is semantic: "that thing about career capital from a mentor" returns the note. Periodically resurfaces orphan notes during journaling.
**Frequency:** Multiple captures per day, retrieval ad-hoc.

### P04 — Texting friends back before it's weird
**Trigger:** Saturday morning, sees three unread iMessage threads from earlier in the week. One is a friend's job announcement they meant to congratulate.
**Today (manual):** Feels the social debt accumulate. Eventually fires off a flat "congrats!" four days late.
**AI opportunity:** A relationship-aware drafting agent that reads thread context (with explicit consent), surfaces "you owe Jamie a reply about their new role at Stripe — here are three draft tones," and tracks who they've gone too long without contacting. Critically: drafts only, never auto-sends to humans.
**Frequency:** Daily nudge, drafts ad-hoc.

### P05 — Holiday cards and birthday remembering
**Trigger:** Mid-November. Last year they sent cards on December 27th.
**Today (manual):** Panics in early December, exports a contact list, hand-curates 40 addresses, half of which are stale.
**AI opportunity:** A relationships agent that maintains a living address book with last-verified dates, drafts a holiday card list ranked by closeness (with a "drop" suggestion for people you haven't spoken to in 3 years), kicks off the Minted order in early November, and pings birthdays a week ahead with a gift idea grounded in conversations from the last year.
**Frequency:** Annual cycle, monthly birthday checks.

### P06 — RSVP and personal scheduling
**Trigger:** Wedding invite arrives. Three group-chat plans this week. Dentist wants to reschedule.
**Today (manual):** Calendar Tetris in their head, double-books, forgets to RSVP, dentist falls through cracks.
**AI opportunity:** A personal-calendar agent that watches inbox + iMessage for soft commitments, proposes responses ("you said 'maybe Saturday' to two people, here's who you should pick based on cadence"), and holds tentative blocks until confirmed. Reconciles personal calendar against work calendar without exposing either to the other.
**Frequency:** Daily.

### P07 — Monthly money check-in
**Trigger:** First of the month, vague unease about spending.
**Today (manual):** Opens Mint (RIP) or its successor, stares at categories, closes laptop. Maybe checks credit card balance. Doesn't change behavior.
**AI opportunity:** A finance agent connected to read-only account APIs that produces a one-page narrative: "you spent 22% more on takeout than your trailing 6-month average; your Roth is on track; your AWS bill on the side project jumped because you forgot to turn off the GPU instance." Surfaces specific, actionable anomalies — not dashboards.
**Frequency:** Monthly digest, weekly anomaly alerts.

### P08 — Subscription audit and renewals
**Trigger:** Random charge from a service they don't remember signing up for.
**Today (manual):** Squints at the statement, googles the merchant, maybe cancels, maybe shrugs.
**AI opportunity:** A subscriptions agent that tracks every recurring charge, flags unused services (cross-references with usage where possible — "you haven't logged into Notion in 4 months"), and queues renewals with a 7-day cancel window. Knows domain renewals, AppleCare, insurance, and warns before auto-renew at higher tiers.
**Frequency:** Continuous monitoring, monthly review.

### P09 — Tax-season prep without the dread
**Trigger:** Mid-February. W-2s and 1099s are arriving. Last year they filed an extension.
**Today (manual):** Pile of PDFs in Downloads, frantic March hunt for the HSA form, panicked DM to a CPA friend.
**AI opportunity:** A tax-prep agent that collects documents year-round (forwarded email rule into a dedicated inbox), categorizes them, reminds about quarterly estimates if applicable, tracks deductible side-project expenses, and produces a tidy folder + summary by mid-March. Doesn't file taxes — just hands the CPA a clean package.
**Frequency:** Annual cycle, continuous capture.

### P10 — Workout consistency and food logging
**Trigger:** Monday morning, intent to lift 4x this week. By Thursday, lifted twice.
**Today (manual):** Strong app, MyFitnessPal, willpower. Logs lapse, motivation lapses with them.
**AI opportunity:** A health agent that pulls from Apple Health + the lifting app, notices the dropoff pattern ("you historically miss Wednesday — propose moving it to Tuesday?"), drafts the next session based on last week's load, and lets food logging happen by photo + voice ("chipotle bowl, double chicken") instead of database scrolling.
**Frequency:** Daily.

### P11 — Doctor follow-up loop closing
**Trigger:** PCP visit. They ordered bloodwork, said "we'll talk in two weeks if anything's off."
**Today (manual):** Bloodwork happens, results appear in MyChart, never get fully understood. Follow-up never scheduled. Question for next visit forgotten.
**AI opportunity:** A health-admin agent that watches the patient portal, summarizes results in plain language with flags, drafts follow-up questions, and books the follow-up if the PCP said to. Maintains a running "questions for next visit" list captured throughout the year.
**Frequency:** Ad-hoc per encounter, continuous capture.

### P12 — Trip planning end-to-end
**Trigger:** Friend texts "Lisbon in October?"
**Today (manual):** 14 browser tabs, a Google Doc, a Slack thread with the friend, half-built itinerary in Notion, flights booked but not the hotel until the last week.
**AI opportunity:** A travel agent (literally) that holds the trip as a single object: budget, dates, flight watches, hotel options ranked against past preferences, restaurant shortlist filtered to "places you'd actually like," packing list generated from weather + activities + what they own, and a daily "before you leave" checklist (hold mail, water plants, charge headphones).
**Frequency:** Per trip; 4–8 trips/year.

### P13 — Home admin and bills
**Trigger:** Comcast bill jumped $20. HVAC service is overdue. Renter's insurance renews next month.
**Today (manual):** Each one a separate, friction-y task. Most slide.
**AI opportunity:** A home-ops agent that maintains the list of recurring household obligations (filter changes, smoke detector batteries, lease renewal, car registration, plant watering when traveling), watches for bill anomalies, and drafts the "call Comcast to renegotiate" script with current competitor rates pre-researched.
**Frequency:** Continuous, weekly digest.

### P14 — Long-term career and savings planning
**Trigger:** Quarterly self-doubt: "am I on track?" Or a recruiter message that surfaces it.
**Today (manual):** Spreadsheet glances, vague anxiety, occasional conversation with a friend at a similar level.
**AI opportunity:** A planning agent that holds the multi-year picture: comp trajectory vs. role expectations, savings rate vs. stated FI goal, skills inventory vs. where the industry is moving. Doesn't pretend to forecast — instead, runs scenarios on request ("if I take a 6-month sabbatical in 2028") and remembers the values the person has previously stated so it doesn't drift toward generic optimization.
**Frequency:** Quarterly check-in, ad-hoc scenarios.

### P15 — Reading and podcast continuity
**Trigger:** On a flight, wants to pick up the book they were 60% through, can't remember which one.
**Today (manual):** Three books in flight, none finished, Audible queue cluttered with abandoned starts.
**AI opportunity:** A reading agent that tracks active vs. dormant books, surfaces the right one for the context (long flight = the fiction they're 60% through, treadmill = the podcast queued for 30 minutes), captures highlights, and once a quarter prompts a 5-minute reflection on a finished book that gets filed into the second brain.
**Frequency:** Daily touch, weekly reshuffling.

### P16 — Journaling that doesn't feel like a chore
**Trigger:** End of day. Used to journal in college, hasn't kept a streak past 9 days since.
**Today (manual):** Empty Obsidian daily note. Cursor blinks. Closes laptop.
**AI opportunity:** A journaling agent that opens with the day's actual artifacts — calendar, commits, messages sent, places visited — and asks one specific question ("you skipped the gym today and had a hard 1:1 — what's the read?"). Captures the response, links it to people and projects, and resurfaces patterns ("the last four times you mentioned Sam, you were drained — worth noticing?").
**Frequency:** Daily.

### P17 — Creative writing draft graveyard
**Trigger:** Has three half-written blog posts, an essay idea from a shower thought last week, and a newsletter they keep meaning to start.
**Today (manual):** Drafts pile up. Publishes maybe twice a year, far below their actual rate of having things to say.
**AI opportunity:** A writing agent that holds drafts as living artifacts, accepts voice-memo additions on walks, suggests "this draft is 80% there — what's blocking publish?" and offers to do the unfun parts (alt text, SEO title, syndication to multiple platforms). Keeps a stable of "stuck drafts" warm so they don't go cold.
**Frequency:** Multiple captures per week, publish cycle weekly-to-monthly.

### P18 — Gift-giving without panic
**Trigger:** Partner's birthday in three weeks. Last year's gift was a gift card. They felt bad.
**Today (manual):** Last-minute Amazon search, generic outcome, residual guilt.
**AI opportunity:** A gifting agent that listens (with consent) for "I wish I had X" or "this is broken" comments throughout the year from the small set of people they actually buy for, maintains a private wishlist, and surfaces 3–4 options 3 weeks before any gifting occasion with delivery dates pre-calculated against the deadline.
**Frequency:** ~10–15 gifting events per year, continuous capture.
