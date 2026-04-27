# Copyright 2026 Reto Meier
#
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#      http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.

import argparse
import sys
import os
import base64
import websocket # Might need to install this: pip install websocket-client
import uuid
import json
import textwrap
import shutil
import pathlib

# Import the necessary function from the agentignore_rules module
try:
    from agentignore_rules import evaluate_path
except ModuleNotFoundError:
    from .agentignore_rules import evaluate_path # Assuming momoa_cli is package root

# Variable to store the number of lines the wrapped question takes
question_lines_count = None
# Global variable to track client state
client_state = "INIT" # States: INIT, AWAITING_PARAMS_ACK, UPLOADING_FILES, TASK_RUNNING
# Global variable for file upload index
file_upload_index = 0
# Global constant for payload size (25MB)
MAX_PAYLOAD_SIZE = 25 * 1024 * 1024

# Global variables for project data determined in main
prompt_text = None
all_files_data = []
assumptions_content = None

# Global variable for the spinner state
spinner_int = 0
# Global variable to store the cursor position before the HITL question
saved_cursor_position = None

def spinner_char():
    """
    Cycles through spinner characters('-', '\\', '-', '/').
    """
    global spinner_int
    chars = ['-', '\\', '-', '/']
    return chars[spinner_int % len(chars)]

def display_progress_updates(completed_update=None, in_progress_update=None):
    """
    Displays progress updates or updates the spinner on the console.
    Mimics cli.js displayProgressUpdates.
    Args:
        completed_update (str, optional): Message for a completed task. Defaults to None.
        in_progress_update (str, optional): Message for a task in progress. Defaults to None.
    """
    global spinner_int

    MAX_LINE_LENGTH = 500

    if completed_update is None and in_progress_update is None:
        # No updates provided, just update the spinner
        # Clear the current line, move cursor to start, write spinner, move cursor back to start
        sys.stdout.write('\r') # Move cursor to the beginning of the line
        #sys.stdout.write('\x1b[2K') # Clear the current line
        sys.stdout.write(spinner_char())
        sys.stdout.write('\r') # Move cursor back to the beginning, ready for next write
        sys.stdout.flush() # Ensure the output is immediately visible
        spinner_int += 1
    else:
        # Updates are provided
        if completed_update:
            escaped_completed_update = completed_update.replace('`', '\\`')
            # Clear the line, write the completed message followed by a newline.
            sys.stdout.write('\r') # Move cursor to the beginning
            sys.stdout.write('\x1b[2K') # Clear the line
            sys.stdout.write(f"\n{escaped_completed_update}\n")
            sys.stdout.flush()
            spinner_int = 0 

        if in_progress_update:
            escaped_update = in_progress_update.replace('`', '\\`')
            # Truncate the in-progress message if it's too long, accounting for the spinner prefix
            prefix_length = len("- ") # Length of the spinner prefix
            if len(escaped_update) + prefix_length > MAX_LINE_LENGTH:
                escaped_update = escaped_update[:MAX_LINE_LENGTH - prefix_length - 3] + "..." # -3 for ellipsis
            spinner_int = 0 # Reset spinner on a new in-progress message


def get_project_definition(args):
    """
    Retrieves the project definition from various sources:
    command-line arguments, a prompt file, user input, or piped stdin.
    """
    project_definition = None

    # 1. Check positional argument (text)
    if args.positional_prompt:
        project_definition = args.positional_prompt

    # 2. Check --prompt option (filename) if positional wasn't used
    if project_definition is None and args.prompt:
        prompt_filepath = args.prompt
        try:
            with open(prompt_filepath, 'r', encoding='utf-8') as f:
                project_definition = f.read()
        except FileNotFoundError:
            print(f"Error: Prompt file not found at '{prompt_filepath}'", file=sys.stderr)
            sys.exit(1)
        except Exception as e:
            print(f"Error reading prompt file '{prompt_filepath}': {e}", file=sys.stderr)
            sys.exit(1)

    # 3. If no definition yet, check if stdin is being piped (not an interactive TTY)
    if project_definition is None:
        # Check if sys.stdin is connected to a pipe or file, not a terminal
        if not sys.stdin.isatty():
            try:
                # Read all content from stdin
                piped_input = sys.stdin.read().strip()
                if piped_input:
                    project_definition = piped_input
                # If piped input is empty, fall through to interactive prompt
            except Exception as e:
                print(f"Error reading from piped input: {e}", file=sys.stderr)
                sys.exit(1)

    # 4. If no definition has been provided yet (arg, file, or piped), prompt the user
    if project_definition is None or not project_definition.strip():
        try:
            user_input = input('Please provide a project definition: ')
            if not user_input.strip():
                print('Error: Project definition cannot be empty.', file=sys.stderr)
                sys.exit(1)
            project_definition = user_input.strip()

        except EOFError:
            print('\nError: No input provided.', file=sys.stderr)
            sys.exit(1)
        except KeyboardInterrupt:
             print('\nInterrupted by user.', file=sys.stderr)
             sys.exit(1)

    return project_definition


def get_files_in_directory_recursive(dir_path):
    """
    Recursively finds all file paths within a given directory,
    respecting .agentignore rules found in the directory and its parents.

    Uses evaluate_path from agentignore_rules.py to determine inclusion/exclusion,
    and prunes traversal of excluded directories.

    Returns a list of absolute file paths.
    """
    file_list = []
    root_dir = os.path.abspath(dir_path) # The base directory for rule evaluation context

    if not os.path.isdir(root_dir):
        print(f"Error: Directory not found at '{dir_path}'", file=sys.stderr)
        return file_list # Return empty list on error

    try:
        # os.walk provides the recursive traversal
        # Note: dirs is modified in place to control traversal
        for root, dirs, files in os.walk(root_dir, followlinks=False): # Avoid following symlinks for simplicity
            current_dir_abs = os.path.abspath(root)

            # --- Step 1: Check if the current directory should be traversed/included ---
            # Evaluate the directory itself based on rules from its parents.
            # If the directory is excluded, skip processing its contents and its subdirectories.
            # The evaluate_path function handles whether the target_path is a file or directory.
            # We evaluate the directory itself before processing its contents.
            if not evaluate_path(current_dir_abs, root_dir):
                # If the current directory is excluded, prune traversal by emptying dirs and files
                # print(f"Skipping excluded directory: {current_dir_abs}", file=sys.stderr) # Debugging
                dirs[:] = [] # Clear the list of subdirectories to visit
                files[:] = [] # Clear the list of files to process in this directory
                continue # Move to the next directory provided by os.walk (which will be outside this subtree)

            # --- Step 2: Process files in the current directory (if directory is included) ---
            for file in files:
                file_path_abs = os.path.abspath(os.path.join(root, file))

                # Evaluate the file path based on rules from the current directory and its ancestors
                if evaluate_path(file_path_abs, root_dir):
                    file_list.append(file_path_abs)

            # --- Step 3: Prune excluded subdirectories from the 'dirs' list ---
            # Modify the 'dirs' list in place based on evaluation.
            # Iterate over a copy of the list because we are modifying it.
            for dirname in list(dirs):
                 subdir_path_abs = os.path.abspath(os.path.join(root, dirname))
                 # Evaluate the subdirectory path.
                 if not evaluate_path(subdir_path_abs, root_dir):
                     # If the subdirectory is excluded, remove it from the dirs list
                     # This tells os.walk *not* to descend into this subdirectory.
                     # print(f"Pruning excluded subdirectory from traversal: {subdir_path_abs}", file=sys.stderr) # Debugging
                     dirs.remove(dirname)

    except Exception as e:
        # Catch any errors during traversal or rule evaluation
        print(f"Error during directory traversal or rule evaluation in '{dir_path}': {e}", file=sys.stderr)
        # Decide if we should re-raise or return partial list. Let's return partial and log.
        # raise # Re-raising matches original behavior, but maybe less user-friendly.
        # Let's just log and return what we found so far.
        pass

    return file_list


def process_files(file_paths, base_path=None):
    """
    Reads file contents, encodes to Base64, and returns a list of file objects.
    Replicates the logic from cli.js's processFiles.
    Args:
        file_paths (list): A list of file paths to process.
        base_path (str, optional): A base path to make file names relative to. Defaults to None.
    Returns:
        list: A list of dictionaries, each with 'name' and 'content' keys.
    """
    files_data = []
    if not file_paths:
        return files_data # Return empty list if no paths provided

    for file_path in file_paths:
        try:
            # Read the file content
            with open(file_path, 'rb') as f: # Read in binary mode for base64 encoding
                file_content = f.read()

            # Convert the file content to base64
            base64_content = base64.b64encode(file_content).decode('utf-8')

            # Determine the file name (relative to base_path if provided)
            if base_path:
                # Ensure base_path is absolute for reliable relative path calculation
                abs_base_path = os.path.abspath(base_path)
                # Calculate relative path. os.path.relpath handles cases where
                # file_path is not under base_path, returning the full path.
                # pathlib is generally more robust for relative paths, let's use it.
                try:
                    file_name = str(pathlib.Path(file_path).relative_to(abs_base_path))
                except ValueError:
                     # If file_path is not under abs_base_path, use its absolute path
                     file_name = os.path.abspath(file_path)
            else:
                # If no base_path, just use the base name of the file
                file_name = os.path.basename(file_path)

            # Append to the list of file objects
            files_data.append({
                'name': file_name,
                'content': base64_content
            })

        except FileNotFoundError:
            print(f"Error: File not found at '{file_path}'", file=sys.stderr)
            # cli.js logs error and continues for individual file read errors.
            # We will do the same.
            continue # Skip this file and proceed to the next
        except Exception as e:
            print(f"Error reading file '{file_path}': {e}", file=sys.stderr)
            # Log other errors but continue processing other files
            continue

    return files_data

def submit_answer(ws, answer):
    """
    Constructs and sends the HITL_RESPONSE message over the WebSocket.
    Also clears the question and prompt from the console and restores cursor.
    """
    message = json.dumps({
        'status': 'HITL_RESPONSE',
        'answer': answer
    })
    try:
        ws.send(message)
    except Exception as e:
        print(f"Error sending HITL_RESPONSE: {e}", file=sys.stderr)

    global question_lines_count, saved_cursor_position

    if question_lines_count is not None:
        # Calculate total lines occupied by the HITL prompt block.
        # Header (1) + question (question_lines_count) + footer (1) + blank after footer (1) + "Your answer: " prompt (1)
        # The 'input()' call adds another newline implicitly, so we need to account for that line too.
        # So, the prompt line itself is cleared (1) + the blank line from input() (1)
        # Total lines to clear: header (1) + question (question_lines_count) + footer (1) + blank after footer (1) + prompt line (1) + newline from input() (1)
        lines_to_clear = question_lines_count + 5 # 1 (header) + question_lines_count + 1 (footer) + 1 (blank after footer) + 1 (prompt) + 1 (input newline)

        # Clear the lines, starting from the line after the input (where cursor currently is)
        # Move cursor up to the first line of the HITL block (the header border line)
        # This is `lines_to_clear` lines up from the current position.
        sys.stdout.write(f"\x1b[{lines_to_clear}A")
        sys.stdout.flush()

        # Clear each line and move down
        for _ in range(lines_to_clear):
            sys.stdout.write("\x1b[2K") # Clear the line
            sys.stdout.write("\x1b[1B") # Move cursor down one line
            sys.stdout.flush()

        # After clearing, the cursor is at the line *after* the last cleared line.
        # Move cursor back to the top of the cleared block to prepare for restoration
        # (This moves it to where the header border line *was*).
        sys.stdout.write(f"\x1b[{lines_to_clear}A")
        sys.stdout.flush()

        # Restore the cursor position if it was saved
        if saved_cursor_position:
            sys.stdout.write(saved_cursor_position)
            sys.stdout.flush() 

        sys.stdout.write("\x1b[1A") # Move cursor up one line
        sys.stdout.flush() 

        # Reset global variables
        question_lines_count = None
        saved_cursor_position = None

def save_files_to_disk(files, root_path):
    """
    Saves a list of file objects (each with filename and base64 content) to disk.
    If a file's decoded content is empty, and the file exists on disk, it will be deleted.
    Replicates the logic from cli.js's saveFilesToDisk, including
    constructing output paths and creating directories. Decodes base64 content.

    Args:
        files (list): A list of dictionaries, each with 'name' and 'content'.
        root_path (str): The base directory path where files should be saved.
    """
    if not files or not isinstance(files, list):
        print('No files to save or files is not a list.', file=sys.stderr)
        return

    # Ensure root_path exists and is a directory
    os.makedirs(root_path, exist_ok=True)
    if not os.path.isdir(root_path):
         print(f"Error: Root output path '{root_path}' is not a directory.", file=sys.stderr)
         return

    for file in files:
        # Validate file object structure
        if not isinstance(file, dict) or 'name' not in file or 'content' not in file:
            print('Skipping invalid file format in list.', file=sys.stderr)
            continue

        original_filename = file['name']
        base64_content = file['content']

        # Construct the full output path early, as it's needed for deletion logic
        output_filepath = str(pathlib.Path(root_path) / original_filename)

        decoded_content_bytes = None
        should_delete = False

        try:
            if not base64_content:
                should_delete = True
            else:
                try:
                    # Attempt to decode base64. This can raise binascii.Error if not valid.
                    decoded_content_bytes = base64.b64decode(base64_content)
                except Exception as b64_e: # Catch any decoding error specifically
                    print(f"Error decoding base64 content for file '{original_filename}': {b64_e}", file=sys.stderr)
                    # If base64 content is invalid, treat it as empty or unprocessable
                    should_delete = True
                    decoded_content_bytes = b'' # Set to empty bytes to avoid further errors

                if not decoded_content_bytes:
                    should_delete = True
                else:
                    try:
                        # Attempt to decode to string to check for whitespace
                        # Use a common encoding like 'utf-8'. Adjust if files use different encodings.
                        decoded_content_str = decoded_content_bytes.decode('utf-8').strip()
                        if not decoded_content_str:
                            # Content is only whitespace after stripping
                            should_delete = True
                    except UnicodeDecodeError:
                        # If it's not valid UTF-8 (e.g., binary file), treat it as non-empty for this check
                        pass # should_delete remains False

            if should_delete:
                if os.path.exists(output_filepath):
                    os.remove(output_filepath)
                    print(f"File '{output_filepath}' has empty, whitespace-only, or invalid base64 content and was deleted.", file=sys.stderr)
                else:
                    print(f"File '{output_filepath}' has empty, whitespace-only, or invalid base64 content but does not exist on disk.", file=sys.stderr)
                continue # Skip to the next file as nothing needs to be written
            
            # Ensure parent directories exist for the output file
            output_dir = os.path.dirname(output_filepath)
            if output_dir: # Only create if there's a directory part
                os.makedirs(output_dir, exist_ok=True)

            # Write the decoded content to the file
            # Use 'wb' mode for binary content
            with open(output_filepath, 'wb') as f:
                f.write(decoded_content_bytes)

            print(f"File '{output_filepath}' saved successfully.", file=sys.stderr)

        except Exception as e:
            print(f"Error processing file '{original_filename}'. Attempted path: '{output_filepath}'. Error: {e}", file=sys.stderr)

def send_file_chunk(ws):
    """
    Calculates the next chunk of files to send based on MAX_PAYLOAD_SIZE
    and the global file_upload_index. Sends the chunk or a START_TASK message
    if finished.
    """
    global file_upload_index, all_files_data, MAX_PAYLOAD_SIZE, client_state

    current_chunk = []
    current_size = 0

    while file_upload_index < len(all_files_data):
        file_obj = all_files_data[file_upload_index]
        
        # Estimate size (in bytes) of the JSON-ified file object
        # This is an approximation; precise JSON size is harder.
        # Using utf-8 length of content is a good proxy.
        try:
            file_size = len(file_obj['name'].encode('utf-8')) + len(file_obj['content'].encode('utf-8'))
        except Exception as e:
            print(f"Warning: Could not encode file {file_obj['name']}. Skipping. Error: {e}", file=sys.stderr)
            file_upload_index += 1
            continue

        # If adding this file exceeds the max size, send the current chunk first.
        # But if the current chunk is empty, send the large file anyway.
        if (current_size + file_size) > MAX_PAYLOAD_SIZE and current_size > 0:
            break # Send the chunk we have.

        current_chunk.append(file_obj)
        current_size += file_size
        file_upload_index += 1

        # If a single file is larger than the max size, it will be sent alone.
        if current_size >= MAX_PAYLOAD_SIZE:
            break # Send this single large file.

    if current_chunk:
        # Send the file chunk
        print(f"Sending {len(current_chunk)} files (bytes: {current_size})... ({file_upload_index}/{len(all_files_data)})", file=sys.stderr)
        ws.send(json.dumps({
            "status": "FILE_CHUNK",
            "data": { "files": current_chunk }
        }))
        # State remains "UPLOADING_FILES", waiting for CHUNK_RECEIVED
    else:
        # No more files to send
        print("All files sent. Sending START_TASK command.", file=sys.stderr)
        ws.send(json.dumps({
            "status": "START_TASK",
            "data": {} # Send empty data payload
        }))
        print("AGENT_TASK_FILE_IO_COMPLETE", flush=True)
        client_state = "TASK_RUNNING" # Update state to task running


def main():
    # MODIFIED: Add globals for state machine
    global current_message_id, question_lines_count, saved_cursor_position
    global prompt_text, all_files_data, assumptions_content
    global client_state, file_upload_index, MAX_PAYLOAD_SIZE

    parser = argparse.ArgumentParser(description='LLM Agent CLI App')

    # Define command-line options
    parser.add_argument(
        '-s', '--serverAddress',
        type=str,
        default='localhost:3007',
        help='Address of the LLM Agent server (default: %(default)s)'
    )
    parser.add_argument(
        '-f', '--files',
        nargs='+', # Accepts one or more arguments
        help='Files to upload (multiple files allowed)'
    )
    parser.add_argument(
        '-d', '--directory',
        type=str,
        help='Directory to recursively upload files from'
    )

    parser.add_argument(
        '-m', '--maxTurns',
        type=int,
        default=15,
        help='Maximum number of turns for each phase (default: %(default)d)'
    )
    parser.add_argument(
        '-c', '--creativity',
        type=int,
        default=2,
        choices=range(0, 6), # Assuming 1-5 based on help text in cli.js comment
        metavar='[0-5]',
        help='Creativity level (1-5) (default: %(default)d)'
    )
    parser.add_argument(
        '-a', '--assumptions',
        type=str,
        default='assumptions.txt',
        help='File containing assumptions for the agent to obey'
    )
    parser.add_argument(
        '-o', '--output',
        type=str,
        default='agent_output',
        help='Output directory for saving files (default: %(default)s)'
    )
    parser.add_argument(
        '-p', '--prompt',
        type=str,
        help='File containing the request prompt'
    )
    parser.add_argument(
        '-r', '--spec',
        type=str,
        help='File path to the project specification, or the specification string itself'
    )
    parser.add_argument(
        '-e', '--env',
        type=str,
        help='File path to the environment setup instructions, or the instructions string itself'
    )
    parser.add_argument(
        '--no-save',
        action='store_true',
        help='Do not save file changes, only show diffs or results in the final output.'
    )
    parser.add_argument(
        '--mode',
        type=str,
        default='developer',
        help='Agent mode (e.g., developer, analyzer)'
    )

    # Add positional argument for prompt
    parser.add_argument(
        'positional_prompt',
        nargs='?', # Zero or one positional argument
        help='Request prompttext (positional argument)'
    )

    args = parser.parse_args()
    
    # If no directory or files specified, default to current directory
    if args.directory is None and not args.files:
        args.directory = os.getcwd()
    
    # --------------------------------------------------------------------------
    # MODIFIED: Check if --spec and --env arguments are file paths.
    # If they are, read the content from the file.
    # --------------------------------------------------------------------------
    if args.spec:
        if os.path.isfile(args.spec):
             try:
                # Read spec file
                with open(args.spec, 'r', encoding='utf-8') as f:
                    args.spec = f.read()
                print(f"Loaded project specification from file: {f.name}", file=sys.stderr)
             except Exception as e:
                print(f"Error reading specification file: {e}", file=sys.stderr)
                sys.exit(1)
    
    if args.env:
        if os.path.isfile(args.env):
             try:
                # Read env file
                with open(args.env, 'r', encoding='utf-8') as f:
                    args.env = f.read()
                print(f"Loaded environment instructions from file: {f.name}", file=sys.stderr)
             except Exception as e:
                print(f"Error reading environment instructions file: {e}", file=sys.stderr)
                sys.exit(1)
    # --------------------------------------------------------------------------

    # Get the project definition using the implemented logic
    prompt_text = get_project_definition(args)

    # Initialize lists and variables for file data and assumptions
    all_files_data = [] # This is now populated globally
    assumptions_content = None # This is now populated globally

    # Process files from --files option
    if args.files:
        print(f"Processing files specified by --files: {args.files}", file=sys.stderr)
        files_from_option = process_files(args.files)
        all_files_data.extend(files_from_option)

    # Process files from --directory option
    if args.directory:
        print(f"Processing files from directory: {args.directory}", file=sys.stderr)
        try:
            # Use the new .agentignore-aware function
            dir_files = get_files_in_directory_recursive(args.directory)
            if dir_files:
                print(f"Found {len(dir_files)} files in directory according to .agentignore rules.", file=sys.stderr)
                # Process files relative to the specified directory
                files_from_directory = process_files(dir_files, args.directory)
                all_files_data.extend(files_from_directory)
            else:
                 print(f"No files found in directory '{args.directory}' matching .agentignore rules.", file=sys.stderr)
        except Exception as e:
            print(f"An error occurred during directory processing for '{args.directory}': {e}", file=sys.stderr)


    # Read content from --assumptions file
    if args.assumptions:
        assumptions_filepath = args.assumptions
        try:
            with open(assumptions_filepath, 'r', encoding='utf-8') as f:
                assumptions_content = f.read()
        except Exception as e:
            print(f"No assumptions file provided, or error reading assumptions file '{assumptions_filepath}': {e}", file=sys.stderr)

    # Generate a unique client UUID
    client_uuid = str(uuid.uuid4())

    # --- WebSocket Logic ---

    # MODIFIED: on_message is now a state machine
    def on_message(ws, message, args, client_uuid):
        global current_message_id, question_lines_count, client_state, file_upload_index # Declare all necessary globals

        try:
            # --- State Machine Logic ---
            data = json.loads(message)
            status = data.get('status')
            message_content = data.get('message', 'No message content')

            if client_state == "AWAITING_PARAMS_ACK":
                if status == 'PARAMS_RECEIVED':
                    print("Server ACK received. Starting file upload...", file=sys.stderr)
                    client_state = "UPLOADING_FILES"
                    send_file_chunk(ws) # Send the first chunk
                else:
                    print(f"Error: Expected PARAMS_RECEIVED, got {status}. Message: {message_content}", file=sys.stderr)
                    ws.close()
            
            elif client_state == "UPLOADING_FILES":
                if status == 'CHUNK_RECEIVED':
                    # Server got the chunk, send the next one
                    send_file_chunk(ws)
                else:
                    print(f"Error during upload: Expected CHUNK_RECEIVED, got {status}. Message: {message_content}", file=sys.stderr)
                    ws.close()

            elif client_state == "TASK_RUNNING":
                # --- This is the ORIGINAL on_message logic for a running task ---
                if status == 'PROGRESS_UPDATES':
                    display_progress_updates(data.get('completed_status_message'), data.get('current_status_message'))
                    completed_status_message = data.get('completed_status_message')

                    if completed_status_message:
                        root_output_path = args.output or "agent_output"
                        try:
                            os.makedirs(root_output_path, exist_ok=True)
                        except Exception as e:
                            print(f"Error creating worklog directory '{root_output_path}': {e}", file=sys.stderr)
                            return 

                        worklog_filename = os.path.join(root_output_path, f"Thinking-{client_uuid}.log.md")

                        try:
                            with open(worklog_filename, 'a', encoding='utf-8') as f:
                                f.write(completed_status_message + '\n')
                        except Exception as e:
                            print(f"Error writing to worklog file '{worklog_filename}': {e}", file=sys.stderr)
                
                elif status == 'WORK_LOG':
                    if message_content: 
                        root_output_path = args.output or "agent_output"
                        try:
                            os.makedirs(root_output_path, exist_ok=True)
                        except Exception as e:
                            print(f"Error creating worklog directory '{root_output_path}': {e}", file=sys.stderr)
                            display_progress_updates()
                            return 

                        worklog_filename = os.path.join(root_output_path, f"worklog{client_uuid}.log")

                        try:
                            with open(worklog_filename, 'a', encoding='utf-8') as f:
                                f.write(message_content + '\n')
                        except Exception as e:
                            print(f"Error writing to worklog file '{worklog_filename}': {e}", file=sys.stderr)
                    display_progress_updates()

                elif status == 'APPLY_FILE_CHANGE':
                    change_data = data.get('data')
                    if change_data:
                        filename = change_data.get('filename')
                        base64_content = change_data.get('content')
                        
                        if filename is not None and base64_content is not None:
                            print(f"\nApplying update for file: {filename}", file=sys.stderr)
                            root_output_path = args.output or "agent_output"
                            file_to_save = [{'name': filename, 'content': base64_content}]
                            save_files_to_disk(file_to_save, root_output_path)
                        else:
                            print("\n[APPLY_FILE_CHANGE] Received incomplete data from server.", file=sys.stderr)

                elif status == 'COMPLETE_RESULT':
                    result_data = data.get('result') 
                    result_type = data.get('resultType')
                    full_data = data.get('data')

                    project_result_text = full_data.get('result', 'No result text received from server.')

                    sys.stdout.write('\r') 
                    print(' ')
                    sys.stdout.write('\x1b[2K')
                    print('\n\x1b[1m** Project Result **\x1b[22m', file=sys.stderr)
                    print(f"\n{project_result_text}", file=sys.stderr)

                    if full_data:
                        retrospective = full_data.get('retrospective')
                        feedback = full_data.get('feedback')
                        files_json_string = full_data.get('files') 

                        print('\n\x1b[1m** Retrospective **\x1b[22m', file=sys.stderr)
                        retrospective_wrapped = textwrap.fill(str(retrospective), width=shutil.get_terminal_size().columns - 2)
                        print(f"\n{retrospective_wrapped}", file=sys.stderr)

                        print('\n\x1b[1m** Feedback **\x1b[22m', file=sys.stderr)
                        feedback_wrapped = textwrap.fill(str(feedback), width=shutil.get_terminal_size().columns - 2)
                        print(f"\n{feedback_wrapped}", file=sys.stderr)

                        print('\n\x1b[1m** Files **\x1b[22m', file=sys.stderr)
                        if files_json_string:
                            try:
                                received_files = json.loads(files_json_string)
                                files_to_save = []

                                for file_obj in received_files:
                                    # Always add the file to the save list, regardless of args.no_save
                                    # The server determines what to send based on the flag we sent in on_open.
                                    # If the server sent it, we save it.
                                    files_to_save.append(file_obj)
                                
                                if files_to_save:
                                    root_output_path = args.output or "agent_output"
                                    save_files_to_disk(files_to_save, root_output_path)
                                else:
                                    print("No files to save based on current settings.", file=sys.stderr)

                            except json.JSONDecodeError:
                                print("Error decoding files JSON string from server data.", file=sys.stderr)
                            except Exception as e:
                                print(f"An error occurred during file saving: {e}", file=sys.stderr)
                        else:
                            print("No files data received.", file=sys.stderr)

                    print("\nProject complete. Closing connection and exiting.", file=sys.stderr)
                    ws.close()
                    sys.exit(0)

                elif status == 'HITL_QUESTION':
                    question_text = data.get('message')

                    if question_text:
                        sys.stdout.write("\x1b[s") # Save cursor position
                        sys.stdout.flush()
                        saved_cursor_position = "\x1b[u"

                        sys.stderr.write('\x1b[1m\n\n\x1b[32m----------------------------Question from the agent:----------------------------\x1b[34m\n')

                        terminal_width = shutil.get_terminal_size().columns
                        wrap_width = 80
                        wrapped_question = textwrap.fill(question_text, width=wrap_width)

                        print(wrapped_question, file=sys.stderr)
                        question_lines_count = len(wrapped_question.splitlines())

                        sys.stderr.write(f'\x1b[32m---------------------------------------------------------------------------------\x1b[0m\n\n')
                        sys.stderr.flush()

                        try:
                            sys.stdout.write('\x1b[34mYour answer: \x1b[0m')
                            sys.stdout.flush()
                            answer = input()
                            submit_answer(ws, answer)

                        except (EOFError, KeyboardInterrupt):
                            print('\nInput interrupted.', file=sys.stderr)
                            submit_answer(ws, "") 
                        except Exception as e:
                            print(f"Error during user input: {e}", file=sys.stderr)
                            submit_answer(ws, f"Error: {e}")
                    else:
                        print(f"\n[HITL_QUESTION] Received incomplete data: {data}", file=sys.stderr)

                elif status == 'ERROR': # Corrected from 'error' to 'ERROR' to match server
                    print(f"\n[ERROR]: {message_content}", file=sys.stderr)
                else:
                    print(f"\n[Unknown status]: {status} - {message_content}", file=sys.stderr)
            
            else:
                print(f"Unknown client state: {client_state}", file=sys.stderr)

        except json.JSONDecodeError:
            # NEW: Handle non-JSON auth error from server (if it sends one)
            if client_state == "AWAITING_PARAMS_ACK":
                 print(f"Authentication or parameter error: {message}", file=sys.stderr)
                 ws.close()
                 sys.exit(1)
            else:
                print(f"Error decoding JSON message: {message}", file=sys.stderr)
        except Exception as e:
            print(f"An unexpected error occurred in on_message: {e}", file=sys.stderr)


    def on_error(ws, error):
        # print(f"\nWebSocket error: {error}", file=sys.stderr)
        sys.exit(1) # Exit on error, replicating cli.js

    def on_close(ws, close_status_code, close_msg):
        # MODIFIED: Only print success if task was running
        if client_state == "TASK_RUNNING":
            print(f"Project completed. Closing WebSocket connection.", file=sys.stderr)
        else:
            print(f"WebSocket connection closed prematurely. State: {client_state}", file=sys.stderr)
        sys.exit(0) # Exit cleanly


    # MODIFIED: on_open now only sends parameters
    def on_open(ws):
        global client_state, prompt_text, all_files_data, assumptions_content # Load globals
        
        # Construct the initial request payload *without files*
        initial_request_params = {
            "prompt": prompt_text,
            "githubUrl": "",
            "llmName": "Unused",
            "maxTurns": args.maxTurns,
            "creativity": args.creativity,
            "assumptions": assumptions_content,
            "clientUUID": client_uuid,
            "apiKey": "Unused", 
            "projectSpecification": args.spec,
            "environmentInstructions" : args.env,
            "saveFiles": not args.no_save,
            "mode": args.mode,
        }

        # Construct the full message payload wrapper
        message_payload = {
            "status": "INITIAL_REQUEST_PARAMS",
            "data": initial_request_params
        }

        # Send the initial parameters payload
        try:
            ws.send(json.dumps(message_payload))
            client_state = "AWAITING_PARAMS_ACK"
            print("Sent initial parameters. Waiting for server ACK...", file=sys.stderr)
        except Exception as e:
            print(f"Error sending INITIAL_REQUEST_PARAMS payload: {e}", file=sys.stderr)
            ws.close()
            sys.exit(1)


    # Construct WebSocket URL
    websocket_url = f"ws://{args.serverAddress}"

    # Create and run the WebSocket app
    try:
        print(f"Connecting to {websocket_url}...", file=sys.stderr)
        client_state = "INIT"
        file_upload_index = 0
        
        ws = websocket.WebSocketApp(websocket_url,
                                    on_open=on_open,
                                    on_message=lambda ws, msg: on_message(ws, msg, args, client_uuid),
                                    on_error=on_error,
                                    on_close=on_close)
        
        ws.run_forever()

    except Exception as e:
        print(f"Failed to connect to WebSocket server: {e}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()