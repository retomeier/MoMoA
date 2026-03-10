---
name: "optimizer-tool-string"
---
**Optimizer Tool (${strings/tool-prefix}OPTIMIZE)**
* **Purpose:** A high-performance research engine. It performs Grid Search, Random Search (Bayesian-style exploration), or Monte Carlo Stress Testing. Supports **Python** and **Rust**.

Use this tool for **experiments**, **tuning**, or **comparisons**. It is significantly faster than manual execution and supports **parallel execution** (up to 5 concurrent runs) and uses **symlinks** to avoid recompiling Rust code between trials. It automatically calculates statistical significance (Mean/StdDev) to ensure results are reliable. 

**Best took for:**
Hyperparameter tuning, prompt engineering tests, or finding optimal configurations.

* **Syntax:**
${strings/tool-prefix}OPTIMIZE{evaluator_script, [dependencies...], search_space_json, goal?, budget?, trials?}OPTIMIZE

* **Search Strategies:**
  1.  **Grid Search (Deterministic):**
      Provide lists of specific values. The tool runs every combination.
      * *Example:* `{"learning_rate": [0.01, 0.05], "batch_size": [32, 64]}`
  2.  **Random Search (Exploratory / Bayesian Proxy):**
      Provide **Range Objects** and a positive `budget`. The tool samples `budget` random configurations within the bounds.
      * *Use Case:* Exploring high-dimensional spaces efficiently.
      * *Range Syntax:* `{"param": {"min": 0, "max": 1, "type": "float"}}` (or `"type": "int"`)
      * *Requirement:* You MUST provide the `budget` argument (e.g., 20).
  3.  **Stress Testing (Robustness / Monte Carlo):**
      Set `trials` > 1. The tool runs *each* configuration `N` times (injecting a `RANDOM_SEED` env var) and returns the **Mean** and **Standard Deviation**.
      * *Use Case:* Verifying that a solution is robust and not just "lucky."
      * *Output:* Metric will appear as `Mean: 10.5 (StdDev: 0.2)`.

* **Language Specifics:**
  * **Python:** Interprets the script for every run. Supports `script.py` OR `script.py:function_name`.
  * **Rust:**
      * **Performance:** Compiles the binary *once* (or builds via Cargo *once*), then executes the binary for every trial.
      * **Cargo Support:** If `Cargo.toml` is listed in dependencies, uses `cargo run --release`.
      * **Restriction:** Rust **cannot** use the `script:function` syntax. It must be a standalone executable that prints to STDOUT.

* **The Evaluator Contract (How to report metrics):**
  The Optimizer does not "read" your code; it executes it. Your script must adhere to this interface:
  
  **1. STDOUT Protocol (Python & Rust):**
     Your script/binary must calculate the metric and print it to standard output using this exact tag:
     `[OPTIMIZER_METRIC]: <number>`
  **2. Function Protocol (Python Only):**
     You may use the syntax `my_script.py:my_function`. The tool will import `my_script` and call `my_function()`. The function must simply return a number.

* **Arguments:**
  1. `evaluator_script`: The Main Driver.
     * *Python:* `main.py` OR `main.py:function_name`.
     * *Rust:* `main.rs`.
  2. `dependencies`: (Files Only). List of helper scripts, `Cargo.toml`, or data files.
  3. `search_space_json`: JSON defining values or ranges.
  4. `goal`: 'min' or 'max'.
  5. `budget`: Integer (Default 0). If > 0, enables Random Search.
  6. `trials`: Integer (Default 1). If > 1, runs each config multiple times.
* **Best Practices:**
  * **Evaluator = Driver:** The tool only runs the Evaluator script. The Evaluator must internally trigger the Solver (e.g., subprocess.run([sys.executable, 'solver.py']) or import solver) to generate the results it needs to measure.
  * **Dependencies:** You MUST explicitly list *all* dependencies (including `gemini_oneshot.py`) in the `dependencies` argument. Tools run in a temporary directory; if you do not list the dependency, your code will not find the script.
  * **Subprocess Execution:** Always use `sys.executable` instead of hardcoded `"python3"` to invoke subprocesses. This ensures the correct environment/path is maintained.
  * **"Fail Fast" Logic:** Use "Fail Fast" logic for subprocess calls (e.g., `FileNotFoundError`), so if the *first* item of the dataset fails, you can catch the error, log it, and **break the loop immediately**. Do not attempt the remaining iterations. This prevents the "Dry Run" validations from timing out and crashing.

* **Examples:**
  * *Python Grid Search:*
    ${strings/tool-prefix}OPTIMIZE{model.py, [utils.py, data.csv], {"w": [10, 20]}, "min"}OPTIMIZE
  * *Python Function Call:*
    ${strings/tool-prefix}OPTIMIZE{model.py:evaluate, [], {"w": [10]}, "min"}OPTIMIZE
  * *Rust Random Search (Compiled Once, Run 50 times):*
    ${strings/tool-prefix}OPTIMIZE{main.rs, [Cargo.toml, utils.rs], {"w": {"min": 0, "max": 100}}, "min", 50}OPTIMIZE
* **Research Workflow Strategy:**
  Since this tool runs a single evaluator script at a time, you should use it in two distinct phases:
  1.  **Phase 1: Exploration (Open Evaluator)**
      Use the tool with your **Open/Training** evaluator and a broad `search_space`.
      * *Example:* ${strings/tool-prefix}OPTIMIZE{experiment_runner_open.py, [solver.py], {"W_A": [10, 50, 100]}, "min"}OPTIMIZE

  2. **Phase 2: Verification (Secret Evaluator)**
     Once you have found the best parameters (e.g., `W_A=50`), use the tool again with your **Secret/Test** evaluator.
     * **The Problem:** You cannot edit the secret file to add the required `print("[OPTIMIZER_METRIC]...")` statement.
     * **The Solution (Function Entry Point):** Use the `filename.py:function_name` syntax. The tool will automatically wrap the secret file, import it, call the function you specify, and capture the result.
     * *Example:* ${strings/tool-prefix}OPTIMIZE{SECRET__experiment_runner.py:run_simulation, [solver.py], {"W_A": [50]}, "min"}OPTIMIZE

* **The "Black Box" Contract (Read Carefully):**
  The Optimizer is an external engine. It does not "read" your code; it executes it. For the tool to work, your provided Python scripts **MUST** adhere to the following strict interfaces:

  **1. The Evaluator Contract (`experiment_runner`)**
  * **Responsibility:** Since the tool does not run the solver automatically, your Evaluator must run the experiment (execute the solver) and then calculate the metric.
  * **Option A (Script Mode):** Your script must calculate a metric and print it using the tag `[OPTIMIZER_METRIC]: <number>`.
  * **Option B (Function Mode):** Your function (e.g., `def run_simulation():`) must simply **return** a number (float or int). The tool handles the printing for you.