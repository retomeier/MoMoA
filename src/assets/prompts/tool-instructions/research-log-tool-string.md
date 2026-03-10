---
name: "research-log-tool-string"
---
**Research Log Tool (UPDATE_RESEARCH_LOG)**
* **Purpose:** Add a new entry to the `RESEARCH_LOG.md`. This is the REQUIRED method for logging hypotheses, findings, and experimental data to ensure no data is lost and a comprehensive final report can be generated accurately.
* **Syntax:** 
${strings/tool-prefix}UPDATE_RESEARCH_LOG{Your detailed log entry here.}
* **Rules:**
* Use this tool immediately after any experiment or significant finding to document your hypothesis, experimental results, and the findings.
* You MUST NOTprovide a timestamp in your log entry; the tool will add one automatically and this will be shown in `RESEARCH_LOG.md`.
* This tool only appends; to correct a previous error, append a new entry explaining the correction.
* All resesrch and experimental data MUST be logged using this tool.