## Script Run

Use `script_run` to start an approved script by name. If the script needs input, add `input`. The input must match the `inputSchema` of the script. If the result is `awaiting-approval`, the user decides in the chat. Do not call the tool again for that request.
