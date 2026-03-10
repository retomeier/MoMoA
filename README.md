# Mixture of Mixture of Agents - Researcher Branch

Coordinate independent LLM experts to solve complex, long-running engineering tasks that can exceed the capabilities of single-agent loops.

---

This branch adds "Research" abilities to the MoMoA system. Refer to [MomoA Researcher](https://labs.google/code/experiments/momoa-researcher) for a research project-focussed implementation of MoMoA.

---

MoMoA breaks large projects into sub-tasks and assigns them to dynamic "Work Phase Rooms." Within each room, two specialized experts—like a **Creative Developer** and a **Conservative Senior Engineer**—are forced to debate, review, and validate each other's work before reporting back to an Orchestrator.

To start a session, point the CLI at your project directory and describe the goal:

```bash
python3 python_cli.py "Refactor the authentication logic to use JWT instead of sessions" \
  --directory ./my-web-app \
  --output ./updates
```

If the Orchestrator encounters an unresolvable ambiguity, it will pause and prompt you for a "Human-in-the-Loop" response directly in your terminal:

```text
----------------------------Question from the agent:----------------------------
I found two different ways to implement the API endpoint. Should I prioritize 
execution speed or memory efficiency for this specific module?
---------------------------------------------------------------------------------

Your answer: Prioritize execution speed; memory is not a bottleneck here.
```

---

MoMoA is an experimental architecture tuned for the Software Development Life Cycle (SDLC). It prioritizes consistency over speed by requiring multiple rounds of internal peer review and validation before any file change is finalized.

### CLI Reference

| Argument | Description | Default |
| --- | --- | --- |
| `positional_prompt` | The primary task description for the agent. | (Required) |
| `-d, --directory` | The local path the agent should read and modify. | `None` |
| `-o, --output` | Where to save worklogs and the final result diffs. | `agent_output` |
| `-a, --assumptions` | Path to a text file containing rules the agent must obey. | `assumptions.txt` |
| `-s, --serverAddress` | The address of the running MoMoA server. | `localhost:3007` |
| `--no-save` | Display diffs and results without writing all files to disk. | `False` |

### Setup & Configuration

1. **Environment:** Create a `.env` file in the server directory with your `GEMINI_API_KEY`
2. **Launch Server:**
```bash
npm install
npm run dev
```
3. **Ignore Rules:** Create an `.agentignore` file in the root of the project folder if you plan to have MoMoA run against an existing project. This follows standard `.gitignore` syntax to prevent the agent from reading heavy dependencies (like `node_modules`) or sensitive secrets.
4. **Launch Client:** 
Ensure you have `websocket-client` installed via pip:
```bash
pip install websocket-client
python3 python_cli.py "Your prompt here" -d ./your-project
```

### Key Architecture Components

* **The Orchestrator:** Breaks the prompt into sub-tasks and reviews work phase reports.
* **Work Phase Rooms:** Specialized environments (Engineering, Planning, Documentation) with domain-specific tools.
* **Experts:** Personas with conflicting prompts (e.g., "Skeptical" vs "Creative") designed to catch logical errors through dissent.
* **The Overseer:** A background process that triggers every 15 minutes to unstick the agent if it enters a circular logic loop.

## About this Project

Project Home Page:
https://labs.google/code/experiments/momoa

Code Home:
https://github.com/retomeier/momoa

Maintained by:
Reto Meier

## License
This project is licensed under the Apache 2 License - see the [license.md](LICENSE) file for details.
