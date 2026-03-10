---
name: "code-runner-tool-string"
---
**Code Runner Tool (${strings/tool-prefix}RUN)**
* **Purpose:** Stages the provided files into a temporary directory and then executes **Python** (`.py`) or **Rust** (`.rs`) scripts in a **completely isolated, empty temporary directory**. You must explicitly list *every* file your script needs (scripts, dependencies, AND data files).

* **Syntax:**
  * **Python:** `${strings/tool-prefix}RUN{main.py, utils.py, data_file.zip}`
  * **Rust (Single File):** `${strings/tool-prefix}RUN{main.rs, data_file.zip}`
  * **Rust (Cargo Project):** `${strings/tool-prefix}RUN{main.rs, Cargo.toml, utils.rs, data.zip}`

* **Critical Execution Logic:**
  1.  **Isolation:** The tool creates a fresh, empty directory. It copies **ONLY** the files you list in the arguments.
      * *Warning:* If your script reads `data.txt`, you **MUST** include `data.txt` in the list, or it will crash with `FileNotFoundError`.
  2.  **Dependency Installation & Compiliation:** The tool automatically handles dependency installation (pip), compiles Rust binaries (rustc/cargo).
  3.  **Auto-Detection & Execution:**
      * **Python:** Executes the **first file** using `python3`.
      * **Rust (Simple):** If no `Cargo.toml` is present, it compiles the **first file** using `rustc` and executes the binary.
      * **Rust (Cargo):** If `Cargo.toml` is present in the file list, it executes the project using `cargo run --release --quiet`.
  4.  **Environment:**
      * **PYTHONPATH:** Set to the temp directory (imports work between staged files).
      * **Output:** Returns `stdout`, `stderr`, and any files created/modified by the script are automatically saved back to the project context.

* **Arguments:**
  * `files`: Comma-separated list of **all** required files.
      * **Position 1:** The entry point script (Main).
      * **Position 2+:** ALL other files (dependencies, `Cargo.toml`, .txt, .csv, .zip,  etc.).

* **Common Pitfalls:**
  * **Missing Data Files:** You forgot to list a data file (e.g., `dataset.zip`) in the arguments.
  * **Wrong Order:** The tool always executes the *first* file in the list.