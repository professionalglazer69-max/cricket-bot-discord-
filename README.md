🏏 Discord Cricket Bot (Live Scores + Daily Summaries)

A fully-featured Cricket Discord Bot built using Node.js and discord.js v14/v15.

It delivers near-live cricket score updates, daily match summaries, match-tracking, and a full interactive admin settings panel — all fully configurable per server.
________________________________________
⭐ Features
🔄 Live Match Tracking (Custom Mode)

•	Track specific match IDs of your choice

•	Posts embedded score updates every few minutes

•	Automatically posts final scorecards when matches end

•	Smart throttling to avoid spam

•	Stops tracking when match is completed



📰 Daily Mode

•	Sends a daily summary of all matches for your filters

•	Includes international + Indian domestic heuristics

•	Posts tomorrow’s international fixtures

🛠 Interactive Settings Panel

•	/cricket-settings opens a full clickable admin panel:

o	Toggle system ON/OFF

o	Switch mode (custom/daily)

o	Toggle role pings

o	Edit category filters (international/domestic/first-class/franchise)

o	Edit gender filters (men/women)

o	Refresh settings display

🎛 Filter System

•	Filters include:

o	Category → international / domestic / franchise / first-class

o	Gender → men / women / both

o	Team filters → only show matches containing specific teams

•	Command-based control for all filters

🏷 Role Pings

•	Turn pings ON/OFF

•	Add/remove roles to ping

•	Test ping command

🏏 Scorecard Support

•	/cricket-summary gives a full batting + bowling scorecard, auto-paged

•	Supports multiple API formats

•	Robust name & value detection

🗂 Match Picker

•	/set-match opens an interactive menu to choose which match to track

•	Filter by category, gender, and team

•	25-option max select menu with confirmation

📊 Heuristics & Match Detection

•	Auto-detect category from:

o	series name

o	match type

o	state-level Indian domestic teams

•	Distinguish Men/Women matches

•	Detect "live" status even when API is vague

